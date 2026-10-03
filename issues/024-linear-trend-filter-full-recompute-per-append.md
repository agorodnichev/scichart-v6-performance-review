# 024 · XyLinearTrendFilter recomputes and re-uploads the whole series on every source append/update

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Model/Filters/XyLinearTrendFilter.js:81` |
| Severity | **high** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (also INP when data arrives during interaction) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/5c054001a12138465fa59eb7a575c293/): reproduced on WebGL and WebGPU ([source](../demos/024-linear-trend-filter-full-recompute-per-append/)) |
| Rule | SC-24, V8-01 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
        const yValues = [];
        const xValues = [];
        for (let i = 0; i < originalCount; i++) {
            const x = xValuesView[rawIdx(i)];
            xValues.push(x);
            yValues.push(x * this.slopeProperty + this.interceptProperty);
        }
        this.clear();
        this.appendRange(xValues, yValues);
```

## Call path and frequency

source.append/appendRange/update/insert/remove -> BaseDataSeries.notifyDataChanged (esm/Charting/Model/BaseDataSeries.js:647) -> XyFilterBase.onBaseDataChanged (XyFilterBase.js:145) -> inherited XyFilterBase.filterOnAppend/filterOnUpdate/filterOnInsert/filterOnRemove (XyFilterBase.js:113-138, not overridden) -> XyLinearTrendFilter.filterAll (XyLinearTrendFilter.js:51): sums pass (:63-72), output arrays (:81-87), clear() (BaseDataSeries.js:470, a Clear notification), appendRange (BaseDataSeries.js:195 -> DataDistributionCalculator.onAppend NaN scan and sorted scan over all n, HEAPF64.set from JS arrays). Once per source data call; per frame on a live chart.

## Why it costs

The filter implements only filterAll, so every source change rebuilds everything: a full pass for the five sums, two JS arrays of n doubles grown by push, a clear() of the output, then appendRange, which scans all n new values for NaN and for sortedness (the filter declares no data flags; clear() resets them) and copies n X and n Y values element by element into wasm. The regression sums are additive, so a non-FIFO append needs only the new points; the only O(n) work a new slope really requires is rewriting the output Y values.

**Scale where it matters:** Source of 100k-1M points receiving at least one append per frame; the cost grows with the total point count, not with the number of points appended (10 new points on a 1M-point source -> about six O(1M) passes and about 16 MB of transient JS arrays).

## Fix (library side)

```diff
--- a/esm/Charting/Model/Filters/XyLinearTrendFilter.js
+++ b/esm/Charting/Model/Filters/XyLinearTrendFilter.js
@@ -9,6 +9,7 @@
 export class XyLinearTrendFilter extends XyFilterBase {
     constructor(originalSeries, options) {
         super(originalSeries, options);
+        this.sums = undefined;
         if (this.getOriginalCount() > 0) {
             this.filterAll();
         }
@@ -48,42 +49,70 @@
             options
         };
     }
+    filterOnAppend(count) {
+        // Non-FIFO append: earlier points are unchanged, so extend the running sums with the new points only
+        const s = this.sums;
+        const n0 = s ? s.n : -1;
+        if (!s || this.originalSeries.fifoCapacity || this.fifoCapacity || this.count() !== n0 || n0 + count !== this.getOriginalCount()) {
+            this.filterAll();
+            return;
+        }
+        const xv = vectorToArrayViewF64(this.getOriginalXValues(), this.webAssemblyContext);
+        const yv = vectorToArrayViewF64(this.getOriginalYValues(), this.webAssemblyContext);
+        for (let i = n0; i < n0 + count; i++) {
+            this.addToSums(xv[i], yv[i]);
+        }
+        this.updateCoefficients();
+        const m = this.slopeProperty;
+        const c = this.interceptProperty;
+        const newX = xv.slice(n0, n0 + count);
+        const newY = newX.map(x => x * m + c);
+        // Rewrite the existing outputs in place before appendRange, which may grow wasm memory and detach these views
+        const outX = vectorToArrayViewF64(this.getNativeXValues(), this.webAssemblyContext);
+        const outY = vectorToArrayViewF64(this.getNativeYValues(), this.webAssemblyContext);
+        for (let i = 0; i < n0; i++) {
+            outY[i] = outX[i] * m + c;
+        }
+        this.appendRange(newX, newY); // one Append notification; bumps changeCount so memoized ranges refresh
+    }
+    addToSums(x, y) {
+        const s = this.sums;
+        s.n++;
+        s.xy += x * y;
+        s.x += x;
+        s.y += y;
+        s.xx += Math.pow(x, 2);
+        s.yy += Math.pow(y, 2);
+    }
+    updateCoefficients() {
+        const s = this.sums;
+        const a = s.xy * s.n;
+        const b = s.x * s.y;
+        const c = s.xx * s.n;
+        const d = Math.pow(s.x, 2);
+        this.correlationProperty = (a - b) / Math.sqrt((c - d) * (s.yy * s.n - Math.pow(s.y, 2)));
+        this.slopeProperty = (a - b) / (c - d); // y = mx + c, m is a slope, c is an intercept
+        this.interceptProperty = (s.y - this.slopeProperty * s.x) / s.n; // y = mx + c, m is a slope, c is an intercept
+    }
     filterAll() {
-        let sumByIndex = 0;
-        let sumX = 0;
-        let sumY = 0;
-        let sumPowX = 0;
-        let sumPowY = 0;
         const originalCount = this.getOriginalCount();
         const xValuesView = vectorToArrayViewF64(this.getOriginalXValues(), this.webAssemblyContext);
         const yValuesView = vectorToArrayViewF64(this.getOriginalYValues(), this.webAssemblyContext);
         const fifoCapacity = this.originalSeries.fifoCapacity;
         const fifoStartIndex = fifoCapacity ? this.originalSeries.fifoStartIndex : 0;
         const rawIdx = (i) => (fifoCapacity ? (i + fifoStartIndex) % fifoCapacity : i);
+        this.sums = { n: 0, x: 0, y: 0, xy: 0, xx: 0, yy: 0 };
         for (let i = 0; i < originalCount; i++) {
             const r = rawIdx(i);
-            const dblY = yValuesView[r];
-            const dblX = xValuesView[r];
-            sumByIndex += dblX * dblY;
-            sumX += dblX;
-            sumY += dblY;
-            sumPowX += Math.pow(dblX, 2);
-            sumPowY += Math.pow(dblY, 2);
-        }
-        const a = sumByIndex * originalCount;
-        const b = sumX * sumY;
-        const c = sumPowX * originalCount;
-        const d = Math.pow(sumX, 2);
-        this.correlationProperty = (a - b) / Math.sqrt((c - d) * (sumPowY * originalCount - Math.pow(sumY, 2)));
-        this.slopeProperty = (a - b) / (c - d); // y = mx + c, m is a slope, c is an intercept
-        const f = this.slopeProperty * sumX;
-        this.interceptProperty = (sumY - f) / originalCount; // y = mx + c, m is a slope, c is an intercept
-        const yValues = [];
-        const xValues = [];
+            this.addToSums(xValuesView[r], yValuesView[r]);
+        }
+        this.updateCoefficients();
+        const xValues = new Float64Array(originalCount);
+        const yValues = new Float64Array(originalCount);
         for (let i = 0; i < originalCount; i++) {
             const x = xValuesView[rawIdx(i)];
-            xValues.push(x);
-            yValues.push(x * this.slopeProperty + this.interceptProperty);
+            xValues[i] = x;
+            yValues[i] = x * this.slopeProperty + this.interceptProperty;
         }
         this.clear();
         this.appendRange(xValues, yValues);
```

**Trade-off:** Adds a sums field and writes the filter's own Y vector in place (bypassing the per-point API; the following appendRange bumps changeCount so memoized ranges refresh). The output rewrite stays O(n) per append because every Y depends on the new slope; emitting only two points (min and max X) would remove that too but changes count(), hit-test and rollover on the trend series. Running sums accumulate in the same order as the full pass, so the coefficients are bit-identical. FIFO sources and update/insert/remove still take filterAll (overwritten or replaced values are no longer available to subtract). The filter's containsNaN flag is computed from the appended Y values only on the incremental path, so after a NaN slope (constant X or a NaN source value) it stays true until the next filterAll; that only keeps the NaN-aware draw path, it does not change the output.

## App-side workaround

On streaming data, compute slope and intercept app-side with running sums and write a 2-point XyDataSeries (first and last X) once per frame; keep XyLinearTrendFilter for static series.

## Verify

measure.md#fps, stream scenario: 60 appends/s of 10 points into a 1M-point non-FIFO XyDataSeries plotted with an XyLinearTrendFilter series, 10 s, 5 runs per side. Pass: compare-runs 'win' on frameP95Ms and longFramesPer10s, no regression on frameP99Ms, and LoAF script time attributed to XyLinearTrendFilter goes down.

## Other locations

- `esm/Charting/Model/Filters/XyLinearTrendFilter.js:63` — full sums pass per call
- `esm/Charting/Model/Filters/XyFilterBase.js:113` — default hooks route append/update/insert/remove to filterAll; the doc comment at :21 tells users only filterAll is needed, so custom filters inherit the same O(n) per change
- `esm/Charting/Model/Filters/XyyFilterBase.js:65`
- `esm/Charting/Model/Filters/XyzFilterBase.js:65`
- `esm/Charting/Model/Filters/OhlcFilterBase.js:41`
- `esm/Charting/Model/Filters/HlcFilterBase.js:73`

## Review notes

- Found by reviewer slice `s09-filters-numerics-utils`.
- Adversarial verification (corrected): Re-read esm/Charting/Model/Filters/XyLinearTrendFilter.js in full: the quote matches :81-89 verbatim; the class overrides only filterAll (:51-90), so every hook falls to XyFilterBase.filterOnAppend/OnUpdate/OnInsert/OnRemove (:113-138) -> filterAll. Call path re-established: XyDataSeries.appendRange (XyDataSeries.js:96) -> BaseDataSeries.appendRangeN :195 -> notifyDataChanged :645 (changeCount++, raiseEvent :647) -> XyFilterBase.onBaseDataChanged :145/:152 -> filterAll. Per call: sums pass :63-72, output build :83-87 into JS arrays grown by push, clear() (BaseDataSeries.js:470, resets the distribution flags via DataDistributionCalculator.clear :98 to sorted=true/NaN=false), then appendRangeN -> DataDistributionCalculator.onAppend :18 runs newYValues.some(checkIsNaN) and isArraySorted over all n because the flags are unset, and appendDoubleVectorFromJsArray (utils/ccall/appendDoubleVectorFromJsArray.js:75-97) HEAPF64.set from plain JS arrays, X and Y. No cache, dirty flag or size guard; sibling bases (XyyFilterBase.js:65, XyzFilterBase.js:65, OhlcFilterBase.js:41, HlcFilterBase.js:73) default the same way. Runs per source data call (per message or per frame on a live chart), cost O(total n): high and S kept. SC-24 Avoid (incremental hook must equal filterAll) is satisfied by the fix. Corrected fix_diff: the original was a pseudo-diff ('@@ constructor', '... (sum loop and coefficient block)') that cannot be applied; replaced it with a real unified diff generated with diff -u from a patched copy (agent-scratch/s09v/b/..., node --check passes). Logic unchanged. Simulated the arithmetic of filterAll vs filterAll+filterOnAppend batches (agent-scratch/s09v/t024.mjs, 50 trials x 30 appends incl. NaN and zero-count appends): slope, intercept, correlation and every output Y are Object.is-identical, confirming the bit-identical claim. trade_off: added the sticky containsNaN note.

