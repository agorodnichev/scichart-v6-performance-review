# 089 · Column, candle, rectangle and box-plot widths rescan all X values every frame when X is unsorted

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/BaseRenderableSeries.js:1410` |
| Severity | **low** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (pan, zoom, stream) |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
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

Per draw: ColumnSeriesDrawingProvider.draw (DrawingProviders/ColumnSeriesDrawingProvider.js:73), OhlcSeriesDrawingProvider.js:105 (and :110 when drawAsOhlc && autoSimplify), RectangleSeriesDrawingProvider.js:72, BoxPlotSeriesDrawingProvider.js:94/:191/:225, ErrorSeriesDrawingProvider.js:92, RectangleDataLabelState.js:15 -> BaseRenderableSeries.getDataPointWidth (BaseRenderableSeries.js:741-764; Relative is the default mode, call at :755) -> getDataPointWidth helper (:1386-1430) -> isSorted false -> NumberUtil.MinMax over all N (:1410). Same helper from StackedColumnCollection.getColumnWidth (StackedColumnCollection.js:351), PolarColumnRenderableSeries.getDataPointWidth (Polar/PolarColumnRenderableSeries.js:100) and FastErrorBarsRenderableSeries.getDataPointWidth (:226), which passes isSorted = false for every horizontal error-bar series and so scans all Y values. Per hit test as well: ColumnSeriesHitTestProvider.js:25 (and the BoxPlot, Rectangle and Error hit-test providers) call getDataPointWidth, so RolloverModifier/CursorModifier pointer moves pay it too. Rate: 1-3 times per frame per series, plus once per hit test.

## Why it costs

It is an O(N) native scan of the whole series on every frame, although the result changes only when the data changes; BaseDataSeries already memoizes the same min/max per changeCount for getXRange (esm/Charting/Model/BaseDataSeries.js:657-700). Unsorted data is already drawn in full every frame (getIndicesRange returns 0..N-1 for unsorted X, BaseDataSeries.js:1407-1409), so this is an extra O(N) pass on top of an O(N) draw: the saving is a fraction of frame time, not a change in complexity.

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
@@ beforeAnimationStart()  (:1307)
     beforeAnimationStart() {
         var _a;
+        // a data-series animation rewrites the native X values without bumping changeCount
+        this.xMinMaxCache = undefined;
         const { animation } = this.animationFSM;
 (same cache in FastErrorBarsRenderableSeries.getDataPointWidth, keyed also by errorDirection, in PolarColumnRenderableSeries.getDataPointWidth (:100), and in StackedColumnCollection.getColumnWidth)
```

**Trade-off:** One small cached object per series. The cache must be keyed on the data-series identity and changeCount, skipped while a data animation runs, and cleared in beforeAnimationStart, because a data-series animation rewrites the native X values without bumping changeCount (BaseDataSeries.js:1114-1123), so the values after the animation do not match a cache keyed on the old changeCount.

## App-side workaround

Keep X sorted (SC-07) so the O(1) sorted path runs, or use dataPointWidthMode Absolute or Range, which skip the scan.

## Verify

measure.md#fps, `pan` scenario on a 1M-point FastColumnRenderableSeries with shuffled X (dataIsSortedInX false), 5 runs per side. Pass: compare-runs 'win' on frameP95Ms and no LoAF time in getDataPointWidth on frames without data changes. Not measured.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/FastErrorBarsRenderableSeries.js:226` — horizontal error bars always take the unsorted path over Y values
- `esm/Charting/Visuals/RenderableSeries/StackedColumnCollection.js:351` — collection column width, same helper

## Review notes

- Found by reviewer slice `s03-renderable-series`.
- Adversarial verification (corrected): Re-read BaseRenderableSeries.js:1386-1430 (quote verbatim; MinMax at :1410) and the Relative branch of getDataPointWidth (:741-764, call at :755). Relative is the default mode (FastColumnRenderableSeries.js:56, BaseOhlcRenderableSeries.js:21, FastBoxPlotRenderableSeries.js:55, FastErrorBarsRenderableSeries.js:56). Callers confirmed with rg: ColumnSeriesDrawingProvider.js:73, OhlcSeriesDrawingProvider.js:105 and :110 (second only with drawAsOhlc && autoSimplify), RectangleSeriesDrawingProvider.js:72, BoxPlotSeriesDrawingProvider.js:94/:191/:225, ErrorSeriesDrawingProvider.js:92, data labels (RectangleDataLabelState.js:15), the hit-test providers (ColumnSeriesHitTestProvider.js:25, BoxPlot/Rectangle/Error), PolarColumnRenderableSeries.js:100, StackedColumnCollection.js:351 and FastErrorBarsRenderableSeries.js:226 (isSorted = isVerticalDirection && ..., so horizontal error bars always scan Y). No guard: the helper has no cache, and isSortedAscending turns false once unsorted data is appended (DataDistributionCalculator.js:30-37). Claim stands, but two corrections. (1) Scale caveat: for unsorted data getIndicesRange returns the full range (BaseDataSeries.js:1407-1409, 'For unsorted data, we need to draw everything'), so the frame already does O(N) drawing; the MinMax is an extra O(N) pass on top, so the saving is a fraction of frame time. Low/H kept. (2) The proposed cache was wrong after data-series animations: updateAnimationProperties (BaseDataSeries.js:1114-1123) writes interpolated values into the native X vector, and neither setAnimationVectors (BaseRenderableSeries.js:1291-1301) nor afterAnimationComplete (:1320-1326) bumps changeCount. So a cache filled before the animation, with the same changeCount, would return the old min/max after the animation ends, which gives wrong column widths. Skipping the cache during the animation is not enough. Fix now also clears the cache in beforeAnimationStart (:1307). call_path, why_it_costs, fix_diff and trade_off updated.

