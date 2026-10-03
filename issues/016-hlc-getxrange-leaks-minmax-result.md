# 016 · HlcDataSeries.getXRange (horizontal error bars) leaks one wasm SCRTDoubleRange per call and rescans the full data each time

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Model/HlcDataSeries.js:186` |
| Severity | **high** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory (wasm heap growth); also frame time |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | TASK-13, SC-29 (web-performance skill) |
| Effort to fix | small |

## Code

```js
                let minMax;
                try {
                    // TODO probably can be optimized, make sure there are no memory leaks here
                    minMax = this.webAssemblyContext.NumberUtil.MinMax(hasLowCap ? this.getNativeLowValues() : this.getNativeXValues(), this.dataDistributionCalculator.containsNaN);
                    min = minMax.minD;
                    minMax = this.webAssemblyContext.NumberUtil.MinMax(hasHighCap ? this.getNativeHighValues() : this.getNativeXValues(), this.dataDistributionCalculator.containsNaN);
                    max = minMax.maxD;
                    if (!isRealNumber(min) || !isRealNumber(max)) {
                        return new NumberRange(0, 0);
                    }
                }
                finally {
                    deleteSafe(minMax);
                }
```

## Call path and frequency

SciChartRenderer.render (esm/Charting/Services/SciChartRenderer.js:132, X autorange step) -> tryPerformAutoRangeOn (:724-729; every frame when xAxis.autoRange === Always) -> AxisBase2D.getMaximumRange (esm/Charting/Visuals/Axis/AxisBase2D.js:823) -> getMaxXRange (:1281) -> getXDataRange (:1255-1259) -> FastErrorBarsRenderableSeries.getXRange (esm/Charting/Visuals/RenderableSeries/FastErrorBarsRenderableSeries.js:244) -> HlcDataSeries.getXRange (:167, horizontal branch :183-196). Also runs on each zoomExtents. Rate: once per frame per horizontal error-bar series under X autoRange Always.

## Why it costs

NumberUtil.MinMax returns a new embind-owned SCRTDoubleRange that needs delete(). Every other call site deletes its result in finally (BaseDataSeries.js:684, XyxyDataSeries.js:186-187). Here the second assignment overwrites the handle of the first result, so only the second is deleted. The first stays in the wasm heap, and its JS wrapper is collected without freeing it.

**Scale where it matters:** Narrow configuration: FastErrorBarsRenderableSeries with errorDirection Horizontal, more than 1 point, and X autoRange Always (or repeated zoom-extents). Within it, the leak is unbounded: one SCRTDoubleRange per frame, about 3,600 per minute at 60 Hz, kept until the wasm context is disposed. Each call also runs two O(n) native scans over the whole series.

## Fix (library side)

```diff
--- a/esm/Charting/Model/HlcDataSeries.js
+++ b/esm/Charting/Model/HlcDataSeries.js
@@ getXRange(dataSeriesValueType, isHorizontalDirection, hasHighCap, hasLowCap)
                 let minMax;
+                let minMaxLow;
                 try {
-                    minMax = this.webAssemblyContext.NumberUtil.MinMax(hasLowCap ? this.getNativeLowValues() : this.getNativeXValues(), this.dataDistributionCalculator.containsNaN);
-                    min = minMax.minD;
+                    minMaxLow = this.webAssemblyContext.NumberUtil.MinMax(hasLowCap ? this.getNativeLowValues() : this.getNativeXValues(), this.dataDistributionCalculator.containsNaN);
+                    min = minMaxLow.minD;
                     minMax = this.webAssemblyContext.NumberUtil.MinMax(hasHighCap ? this.getNativeHighValues() : this.getNativeXValues(), this.dataDistributionCalculator.containsNaN);
                     max = minMax.maxD;
@@
                 finally {
+                    deleteSafe(minMaxLow);
                     deleteSafe(minMax);
                 }
+// Optional: wrap the body in memoize(...) keyed on (this.changeCount, dataSeriesValueType, isHorizontalDirection, hasHighCap, hasLowCap), as BaseDataSeries.getXRangeByName does, so static data is not rescanned each frame.
```

**Trade-off:** None for the leak fix. A memo adds one cached NumberRange per series, and its key must include the direction and cap flags.

## App-side workaround

Avoid X autoRange Always on charts with horizontal error bars: use autoRange Once or Never and set xAxis.visibleRange from your own data. Or use vertical error bars.

## Verify

measure.md#mem: horizontal error bars, 10k points, xAxis.autoRange Always. Warm up, then run a 60 s render or "stream" scenario 10 times, sampling an app counter for wasm heap in use after each (measure.md#mem: read wasm size from an app counter). Pass: growth per repetition is within noise after the fix. Before the fix, growth is linear in the number of frames rendered.

## Other locations

- `esm/Charting/Model/HlcDataSeries.js:167` — getXRange overrides the changeCount-memoized BaseDataSeries.getXRange, so both full-array MinMax scans rerun on every call
- `esm/Charting/Visuals/RenderableSeries/FastErrorBarsRenderableSeries.js:244` — Only caller that passes isHorizontalDirection = true (errorDirection Horizontal)
- `esm/Charting/Model/XyxyDataSeries.js:186` — Same unmemoized pattern (two full MinMax scans per call, ignoring the sorted flag), but both results are deleted, so no leak

## Review notes

- Found by reviewer slice `s08-data-series`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

