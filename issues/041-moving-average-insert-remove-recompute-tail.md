# 041 · XyMovingAverageFilter recomputes every output after an insert/remove index, a full pass for prepend or front-trim

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Model/Filters/XyMovingAverageFilter.js:67` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | INP (history prepend), frame time (per-message trimming) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
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
@@ -67,8 +67,30 @@
     filterOnInsert(startIndex, count) {
-        this.calculate(startIndex);
+        // only the inserted outputs and the next length-1 (whose window straddles the insert) change
+        const affected = Math.min(this.length - 1, this.count() - startIndex);
+        this.replaceWindow(startIndex, affected, count + affected);
     }
     filterOnRemove(startIndex, count) {
-        this.calculate(startIndex);
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
+        if (newCount > 0) this.insertRange(start, xs, ys);
     }
 (calculateUpdate for index < count-1 can use replaceWindow(index, w, w) with w = Math.min(this.length, this.count() - index))
```

**Trade-off:** Two notifications (Remove, Insert) instead of Clear/Remove plus Append, and a native memmove of the output tail. NaN is treated as 0, as the existing containsNaN branch does. Insert/remove remain impossible on FIFO filters (already true of calculate(start > 0)). A scratch simulation against a full recompute matched on 2000 random inserts/removes (a correctness check, not a measurement).

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
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

