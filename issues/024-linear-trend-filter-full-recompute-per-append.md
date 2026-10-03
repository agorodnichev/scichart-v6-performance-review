# 024 · XyLinearTrendFilter recomputes and re-uploads the whole series on every source append/update

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Model/Filters/XyLinearTrendFilter.js:81` |
| Severity | **high** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (also INP when data arrives during interaction) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
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
@@ constructor
         super(originalSeries, options);
+        this.sums = undefined;
         if (this.getOriginalCount() > 0) {
@@ class body
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
+        for (let i = n0; i < n0 + count; i++) this.addToSums(xv[i], yv[i]);
+        this.updateCoefficients();
+        const m = this.slopeProperty, c = this.interceptProperty;
+        const newX = xv.slice(n0, n0 + count);
+        const newY = newX.map(x => x * m + c);
+        // rewrite existing outputs in place before appendRange (which may grow wasm memory and detach views)
+        const outX = vectorToArrayViewF64(this.getNativeXValues(), this.webAssemblyContext);
+        const outY = vectorToArrayViewF64(this.getNativeYValues(), this.webAssemblyContext);
+        for (let i = 0; i < n0; i++) outY[i] = outX[i] * m + c;
+        this.appendRange(newX, newY); // one Append notification; bumps changeCount so cached Y ranges refresh
+    }
+    addToSums(x, y) {
+        const s = this.sums;
+        s.n++; s.xy += x * y; s.x += x; s.y += y; s.xx += Math.pow(x, 2); s.yy += Math.pow(y, 2);
+    }
+    updateCoefficients() {
+        const s = this.sums, a = s.xy * s.n, b = s.x * s.y, c = s.xx * s.n, d = Math.pow(s.x, 2);
+        this.correlationProperty = (a - b) / Math.sqrt((c - d) * (s.yy * s.n - Math.pow(s.y, 2)));
+        this.slopeProperty = (a - b) / (c - d);
+        this.interceptProperty = (s.y - this.slopeProperty * s.x) / s.n;
+    }
@@ filterAll (lines 52-78 and 81-87)
-        let sumByIndex = 0; ... (sum loop and coefficient block)
+        this.sums = { n: 0, x: 0, y: 0, xy: 0, xx: 0, yy: 0 };
+        for (let i = 0; i < originalCount; i++) { const r = rawIdx(i); this.addToSums(xValuesView[r], yValuesView[r]); }
+        this.updateCoefficients();
-        const yValues = [];
-        const xValues = [];
+        const xValues = new Float64Array(originalCount);
+        const yValues = new Float64Array(originalCount);
         for (let i = 0; i < originalCount; i++) {
             const x = xValuesView[rawIdx(i)];
-            xValues.push(x);
-            yValues.push(x * this.slopeProperty + this.interceptProperty);
+            xValues[i] = x;
+            yValues[i] = x * this.slopeProperty + this.interceptProperty;
         }
```

**Trade-off:** Adds a sums field and writes the filter's own Y vector in place (bypassing the per-point API; the following appendRange bumps changeCount so memoized ranges refresh). The output rewrite stays O(n) per append because every Y depends on the new slope; emitting only two points (min and max X) would remove that too but changes count(), hit-test and rollover on the trend series. Running sums accumulate in the same order as the full pass, so the coefficients are bit-identical. FIFO sources and update/insert/remove still take filterAll (overwritten or replaced values are no longer available to subtract).

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
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

