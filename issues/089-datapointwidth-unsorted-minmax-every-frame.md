# 089 · Column, candle, rectangle and box-plot widths rescan all X values every frame when X is unsorted

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/BaseRenderableSeries.js:1410` |
| Severity | **low** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (pan, zoom, stream) |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | V8-01 (web-performance skill) |
| Effort to fix | small |

## Code

```js
        else {
            let minMax;
            try {
                // containsNaN is always false for xValues
                minMax = wasmContext.NumberUtil.MinMax(xValues, false);
                // if (!isRealNumber(minMax.minD) || !isRealNumber(minMax.maxD)) {
                //     return new NumberRange(0, 0);
                // }
                min = minMax.minD;
                max = minMax.maxD;
            }
```

## Call path and frequency

ColumnSeriesDrawingProvider.draw (esm/Charting/Visuals/RenderableSeries/DrawingProviders/ColumnSeriesDrawingProvider.js:73), OhlcSeriesDrawingProvider.js:105 and :110 (twice per frame), RectangleSeriesDrawingProvider.js:72, BoxPlotSeriesDrawingProvider.js:94/:191/:225 -> BaseRenderableSeries.getDataPointWidth (BaseRenderableSeries.js:741-764, Relative mode, :755) -> getDataPointWidth helper (:1386-1430) -> isSorted false -> NumberUtil.MinMax over all N (:1410). Also StackedColumnCollection.getColumnWidth (StackedColumnCollection.js:351) and FastErrorBarsRenderableSeries.getDataPointWidth (:226), which passes isSorted = false for every horizontal error-bar series and so scans all Y values. Rate: 1-3 times per frame per series.

## Why it costs

It is an O(N) native scan of the whole series on every frame, although the result changes only when the data changes; BaseDataSeries already memoizes the same min/max per changeCount for getXRange (esm/Charting/Model/BaseDataSeries.js:657-700).

**Scale where it matters:** Unsorted X (out-of-order histograms, scatter-like columns, candles inserted out of order) with 10^5-10^6 points, and horizontal error bars of any size.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/BaseRenderableSeries.js
+++ b/esm/Charting/Visuals/RenderableSeries/BaseRenderableSeries.js
-export const getDataPointWidth = (xValues, xCoordCalc, seriesViewRectWidth, widthFraction, isCategoryAxis, isSorted, wasmContext) => {
+export const getDataPointWidth = (xValues, xCoordCalc, seriesViewRectWidth, widthFraction, isCategoryAxis, isSorted, wasmContext, cachedMinMax) => {
@@
-        else {
+        else if (cachedMinMax) {
+            max = xCoordCalc.getCoordinate(cachedMinMax.max);
+            min = xCoordCalc.getCoordinate(cachedMinMax.min);
+        }
+        else {
             let minMax;
@@ getDataPointWidth(xCoordCalc, widthFraction, widthMode)  (:755)
-            let candleWidth = Math.floor(getDataPointWidth(xValues, xCoordCalc, seriesViewRectWidth, widthFraction, isCategoryAxis, this.dataSeries.dataDistributionCalculator.isSortedAscending, this.webAssemblyContext));
+            const ds = this.dataSeries;
+            const isSorted = ds.dataDistributionCalculator.isSortedAscending;
+            let cache;
+            if (!isSorted && !isCategoryAxis && !this.isRunningDataAnimation) {
+                cache = this.xMinMaxCache;
+                if (!cache || cache.ds !== ds || cache.changeCount !== ds.changeCount) {
+                    let mm;
+                    try { mm = this.webAssemblyContext.NumberUtil.MinMax(xValues, false); cache = this.xMinMaxCache = { ds, changeCount: ds.changeCount, min: mm.minD, max: mm.maxD }; }
+                    finally { deleteSafe(mm); }
+                }
+            }
+            let candleWidth = Math.floor(getDataPointWidth(xValues, xCoordCalc, seriesViewRectWidth, widthFraction, isCategoryAxis, isSorted, this.webAssemblyContext, cache));
 (same cache in FastErrorBarsRenderableSeries.getDataPointWidth, keyed also by errorDirection, and in StackedColumnCollection.getColumnWidth)
```

**Trade-off:** One small cached object per series. The cache must be keyed on the data-series identity and changeCount and skipped during data animations, because animations change the values without a data change.

## App-side workaround

Keep X sorted (SC-07) so the O(1) sorted path runs, or use dataPointWidthMode Absolute or Range, which skip the scan.

## Verify

measure.md#fps, `pan` scenario on a 1M-point FastColumnRenderableSeries with shuffled X (dataIsSortedInX false), 5 runs per side. Pass: compare-runs 'win' on frameP95Ms and no LoAF time in getDataPointWidth on frames without data changes. Not measured.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/FastErrorBarsRenderableSeries.js:226` — horizontal error bars always take the unsorted path over Y values
- `esm/Charting/Visuals/RenderableSeries/StackedColumnCollection.js:351` — collection column width, same helper

## Review notes

- Found by reviewer slice `s03-renderable-series`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

