# 041 · XyMovingAverageFilter recomputes every output after an insert/remove index, a full pass for prepend or front-trim

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Model/Filters/XyMovingAverageFilter.js:67` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | INP (history prepend), frame time (per-message trimming) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Rule | SC-24, V8-01 (web-performance skill) |
| Effort to fix | small |

## Code

```js
    filterOnInsert(startIndex, count) {
        this.calculate(startIndex);
    }
    filterOnRemove(startIndex, count) {
        this.calculate(startIndex);
    }
```

## Call path and frequency

source.insertRange(0, olderPoints) or source.removeRange(0, k) -> BaseDataSeries.notifyDataChanged (esm/Charting/Model/BaseDataSeries.js:411 / :462) -> XyFilterBase.onBaseDataChanged (XyFilterBase.js:157-161) -> XyMovingAverageFilter.filterOnInsert/filterOnRemove (:67-72) -> calculate(startIndex) (:135): clear() when startIndex is 0, else removeRange of the whole tail (:142-149), JS loop with push over every source point from startIndex (:155-199), appendRange (:200). Per insert/remove call; also filterOnUpdate for any index except the last (:77-78).

## Why it costs

After an insert or remove at startIndex, outputs before startIndex are unchanged and every output whose averaging window lies wholly after the change keeps its value; only count + length - 1 outputs (insert) or length - 1 outputs (remove) can change. calculate(startIndex) instead discards and recomputes the whole tail in JS, builds two JS arrays of that size with push, and copies them back into wasm, so front edits cost O(n) script time and allocation per call.

**Scale where it matters:** 1M-point non-FIFO source with length 20-200: each 'load older data' prepend, or each removeRange(0, k) used to trim a manual sliding window after an append, recomputes all n outputs.

## Fix (library side)

```diff
--- a/esm/Charting/Model/Filters/XyMovingAverageFilter.js
+++ b/esm/Charting/Model/Filters/XyMovingAverageFilter.js
@@ -67,8 +67,36 @@
     filterOnInsert(startIndex, count) {
-        this.calculate(startIndex);
+        if (this.fifoCapacity) return this.calculate(startIndex); // a FIFO filter cannot removeRange/insertRange
+        // only the inserted outputs and the next length-1 (whose window straddles the insert) change
+        const affected = Math.min(this.length - 1, this.count() - startIndex);
+        this.replaceWindow(startIndex, affected, count + affected);
     }
     filterOnRemove(startIndex, count) {
-        this.calculate(startIndex);
+        if (this.fifoCapacity) return this.calculate(startIndex);
+        // outputs whose window lies wholly after the gap keep their value
+        const affected = Math.min(this.length - 1, this.getOriginalCount() - startIndex);
+        this.replaceWindow(startIndex, count + affected, affected);
+    }
+    /** Replaces oldCount outputs at start with newCount outputs recomputed from the (non-FIFO) source */
+    replaceWindow(start, oldCount, newCount) {
+        const L = this.length;
+        const xv = vectorToArrayViewF64(this.getOriginalXValues(), this.webAssemblyContext);
+        const yv = vectorToArrayViewF64(this.getOriginalYValues(), this.webAssemblyContext);
+        const xs = new Float64Array(newCount);
+        const ys = new Float64Array(newCount);
+        let sum = 0;
+        for (let j = Math.max(0, start - L + 1); j < start; j++) sum += yv[j] || 0;
+        for (let k = 0; k < newCount; k++) {
+            const i = start + k;
+            xs[k] = xv[i];
+            sum += yv[i] || 0;
+            ys[k] = i >= L - 1 ? sum / L : NaN;
+            if (i - L + 1 >= 0) sum -= yv[i - L + 1] || 0;
+        }
+        if (oldCount > 0) this.removeRange(start, oldCount); // native memmove of the tail, no JS per point
+        if (newCount === 0) return;
+        // insertRange validates start < count() (BaseDataSeries.validateIndex), so a window that reaches the end is appended
+        if (start < this.count()) this.insertRange(start, xs, ys);
+        else this.appendRange(xs, ys);
     }
 (calculateUpdate for index < count-1, when neither the source nor the filter is FIFO, can use replaceWindow(index, w, w) with w = Math.min(this.length, this.count() - index))
```

**Trade-off:** Two notifications (Remove, Insert or Append) instead of Clear/Remove plus Append, and a native memmove of the output tail. NaN is treated as 0, as the existing containsNaN branch does; sums restart at the edit point, so values can differ from a full recompute by floating-point rounding only (calculate(start > 0) already does the same). A FIFO filter keeps the old full path, because removeRange/insertRange throw in FIFO mode while calculate(0) clears it. A scratch simulation with SciChart's index validation matched a full recompute on 2000 random series x 20 inserts/removes (a correctness check, not a measurement); without the append branch it threw in most trials.

## App-side workaround

Use fifoCapacity on the source instead of removeRange(0, k) trimming; for history prepends, create (or recreate) the filter after the history load so the full pass runs once.

## Verify

measure.md#inp: a 'load older data' click that calls insertRange(0, 10k points) on a 1M-point source with XyMovingAverageFilter(length 50), 5 runs per side. Pass: compare-runs 'win' on the processing subpart. Then measure.md#fps stream with append plus removeRange(0, k) per message. Pass: 'win' on frameP95Ms.

## Other locations

- `esm/Charting/Model/Filters/XyMovingAverageFilter.js:77` — calculateUpdate: update of a non-last point -> calculate(index) over the whole tail
- `esm/Charting/Model/Filters/XyMovingAverageFilter.js:142` — clear()/removeRange of the whole tail
- `esm/Charting/Model/Filters/XyMovingAverageFilter.js:155` — newX/newY JS arrays grown by push for the whole tail

## Review notes

- Found by reviewer slice `s09-filters-numerics-utils`.
- Adversarial verification (corrected): Re-read esm/Charting/Model/Filters/XyMovingAverageFilter.js:67-72 (quote verbatim), calculate at :135-201 (clear() for start 0 at :144, removeRange of the tail at :147, push loops :155-199, appendRange :200) and calculateUpdate :76-79. Caller chain confirmed: BaseDataSeries.insertRangeN notifies Insert at esm/Charting/Model/BaseDataSeries.js:411, removeRange notifies Remove at :462 -> notifyDataChanged :645-647 raiseEvent -> XyFilterBase.onBaseDataChanged (esm/Charting/Model/Filters/XyFilterBase.js:145, switch :157-162) -> filterOnInsert/filterOnRemove -> calculate(startIndex). No dirty flag, batching or size threshold in between; insertRange/removeRange on the source throw for FIFO (throwIfFifo :396/:454), so this path is non-FIFO sources only, as the finding says. Mechanism and O(n - startIndex) cost per call are certain (S). Severity kept medium: a prepend is a discrete interaction; per-message removeRange(0,k) trimming is app-dependent and fifoCapacity exists for it. CORRECTED the fix: the diff as written throws whenever the recomputed window reaches the end of the filter, because insertRange -> validateIndex (BaseDataSeries.js:1225-1232) rejects startIndex >= count(); e.g. insert at 80 into 100 points with length 50 removes 20 outputs and then calls insertRange(80) on an 80-point filter. A scratch simulation with SciChart's index validation threw in 1866 of 2000 random trials for the original diff and gave 0 errors and 0 mismatches against a full recompute (2000 trials x 20 inserts/removes, NaNs included) after switching to appendRange when start >= count(). Also added a FIFO-filter fallback: today calculate(0) works on a FIFO filter via clear(), while removeRange/insertRange on the filter would throw (throwIfFifo :1364). Corrected trade_off accordingly (the earlier 'matched on 2000 random inserts/removes' claim did not hold for the diff as written).

