# 032 · OHLC/candlestick Y autorange reads high and low with two embind get(i) calls per point on every frame

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/BaseOhlcRenderableSeries.js:228` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (pan, zoom, stream with yAxis autoRange Always) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/f0c5ea18c20f6f9dbe98d81e970a5645/): reproduced on WebGL and WebGPU ([source](../demos/032-ohlc-yrange-embind-get-loop/)) |
| Rule | SC-06, V8-01 (web-performance skill) |
| Effort to fix | small |

## Code

```js
        if (pointSeries) {
            const { openValues, closeValues, highValues, lowValues } = pointSeries;
            const indicesRange = new NumberRange(0, pointSeries.count - 1);
            return getOHLCYRange(indicesRange, openValues, highValues, lowValues, closeValues);
        }
```

## Call path and frequency

SciChartRenderer.render step 4 (esm/Charting/Services/SciChartRenderer.js:137) -> tryPerformAutoRangeOn (:724-729, when yAxis.autoRange is Always) -> AxisBase2D.getMaximumRange (esm/Charting/Visuals/Axis/AxisBase2D.js:823) -> getWindowedYRange (:846-860) -> seriesYRangeForThisAxis (:837) -> BaseOhlcRenderableSeries.getYRange (BaseOhlcRenderableSeries.js:213-230) -> getOHLCYRange (esm/Charting/Model/OhlcDataSeries.js:267-286), whose loop calls highValues.get(i) and lowValues.get(i) at :276-277. Without resampling, the same loop runs over the visible candles through OhlcDataSeries.getWindowedYRange (:184-195), which, unlike BaseDataSeries.getWindowedYRange (esm/Charting/Model/BaseDataSeries.js:703-760), is not memoized. Rate: once per Y axis per OHLC series per frame; 2 JS->wasm calls per point.

## Why it costs

Every get(i) goes through the embind invoker (_glue-pretty/scichart.js:4648, craftInvokerFunction -> invokerFn: rest-args array, onDone closure, `this` validation, wasm call). The skill's SC-06 rule says get(i) loops cross into wasm once per point. The XY, band and rectangle range paths in the same library use one native NumberUtil.MinMaxWithIndex call per vector, and that function is in the typings (types/types/TSciChart.d.ts:248).

**Scale where it matters:** A candlestick or OHLC chart with the price axis on EAutoRange.Always (the default is Once, which runs the scan only on the first range). With default resampling, the scanned count is on the order of the plot width in pixels on both paths, because RequiresReduction (esm/Charting/Numerics/Resamplers/ExtremeResamplerHelper.js:111) switches to resampled vectors once the visible candles exceed the width-based threshold: a few thousand embind get() calls per frame per OHLC series. Only with resamplingMode = EResamplingMode.None do 5k-50k visible candles give 10k-100k calls per frame.

## Fix (library side)

```diff
--- a/esm/Charting/Model/OhlcDataSeries.js
+++ b/esm/Charting/Model/OhlcDataSeries.js
+import { deleteSafe } from "../../Core/Deleter";
+import { isRealNumber } from "../../utils/isRealNumber";
@@
-export function getOHLCYRange(indicesRange, openValues, highValues, lowValues, closeValues) {
+export function getOHLCYRange(indicesRange, openValues, highValues, lowValues, closeValues, wasmContext) {
     let yMin = Number.MAX_VALUE;
     let yMax = Number.NEGATIVE_INFINITY;
     const iMin = Math.max(indicesRange.min, 0);
     const iMax = Math.min(indicesRange.max, openValues.size() - 1);
     if (iMax < iMin) {
         return undefined;
     }
+    if (wasmContext) {
+        // two native scans instead of two embind get() calls per point
+        const start = Math.floor(iMin);
+        const count = Math.ceil(iMax) - start + 1;
+        let lowMM, highMM;
+        try {
+            lowMM = wasmContext.NumberUtil.MinMaxWithIndex(lowValues, start, count, true);
+            highMM = wasmContext.NumberUtil.MinMaxWithIndex(highValues, start, count, true);
+            if (!isRealNumber(lowMM.minD) || !isRealNumber(highMM.maxD)) return undefined;
+            return new NumberRange(lowMM.minD, highMM.maxD);
+        } finally {
+            deleteSafe(lowMM);
+            deleteSafe(highMM);
+        }
+    }
     for (let i = iMin; i <= iMax; i++) {
@@ getWindowedYRange(...)  (:194)
-        return getOHLCYRange(indicesRange, openValues, highValues, lowValues, closeValues);
+        return getOHLCYRange(indicesRange, openValues, highValues, lowValues, closeValues, this.webAssemblyContext);
--- a/esm/Charting/Visuals/RenderableSeries/BaseOhlcRenderableSeries.js
+++ b/esm/Charting/Visuals/RenderableSeries/BaseOhlcRenderableSeries.js
@@ getYRange (:228)
-            return getOHLCYRange(indicesRange, openValues, highValues, lowValues, closeValues);
+            return getOHLCYRange(indicesRange, openValues, highValues, lowValues, closeValues, this.webAssemblyContext);
```

**Trade-off:** MinMaxWithIndex with containsNaN = true must skip NaN gaps the way today's JS comparisons silently do; test a series with NaN candles. A window that is all NaN now returns undefined instead of NumberRange(MAX_VALUE, -Infinity), which the axis already handles for other series. The new parameter is optional, so app code that calls the exported getOHLCYRange keeps working. Memoizing OhlcDataSeries.getWindowedYRange on changeCount and xRange, as BaseDataSeries does, would also remove repeated scans on frames with no change. On a category X axis the old loop called get() with the fractional visible-range bounds (embind truncates to the integer index), so it read floor(min)..floor(max); the native call with Math.floor/Math.ceil reads floor(min)..ceil(max), at most one extra candle at the right edge, the same rounding BaseDataSeries uses for category axes. Passing this.dataSeries.dataDistributionCalculator.containsNaN instead of true skips the NaN checks for series without gaps.

## App-side workaround

Use EAutoRange.Once or Never on the price axis and set yAxis.visibleRange from a min/max you compute over the visible slice of getNativeHighValues()/getNativeLowValues() through vectorToArrayViewF64 (SC-06), only when the X range or the data changes.

## Verify

measure.md#fps, `pan` scenario on a FastCandlestickRenderableSeries with 100k candles and yAxis.autoRange = EAutoRange.Always, plus the same at 5k candles (not resampled), 5 runs per side. Pass: compare-runs 'win' or neutral on frameP95Ms with LoAF script time in getOHLCYRange going down, and the Y visibleRange after the pan equals the baseline. Not measured.

## Other locations

- `esm/Charting/Model/OhlcDataSeries.js:276` — root cause: highValues.get(i) / lowValues.get(i) per point
- `esm/Charting/Model/OhlcDataSeries.js:194` — non-resampled path, not memoized, same loop over visible candles
- `esm/Charting/Model/OhlcDataSeries.js:276` — same root cause, also reported by slice s08-data-series: OHLC (and box-plot) Y autorange calls two embind get(i) per visible candle on every autorange call, with no memo
- `esm/Charting/Model/OhlcDataSeries.js:184` — getWindowedYRange overrides the base version, which is memoized on changeCount and xRange. This override has no memo, so the scan reruns on every call
- `esm/Charting/Visuals/RenderableSeries/BaseOhlcRenderableSeries.js:228` — The resampled path runs the same loop over the resampled point-series vectors
- `esm/Charting/Model/BoxPlotDataSeries.js:218` — Same loop: maximumValues.get(i) and minimumValues.get(i) per visible box, not memoized
- `esm/Charting/Model/BaseDataSeries.js:736` — Pattern to copy: one native NumberUtil.MinMaxWithIndex call per array. The Xyy (XyyDataSeries.js:228) and Hlc (HlcDataSeries.js:293) paths already work this way

## Review notes

- Found by reviewer slice `s03-renderable-series`.
- Adversarial verification (corrected): Re-read BaseOhlcRenderableSeries.js:213-230 (quote matches 225-229, return at :228) and OhlcDataSeries.js:184-195 and :267-286 (highValues.get(i)/lowValues.get(i) at :276-277). Caller chain confirmed: SciChartRenderer.js:137 (step 4, every render) -> tryPerformAutoRangeOn :724-726 (runs only for EAutoRange.Always, or Once on first range) -> AxisBase2D.getMaximumRange :823 -> getWindowedYRange :846-860 -> seriesYRangeForThisAxis :837 -> rs.getYRange. No memo or dirty flag on either OHLC path: OhlcDataSeries.getWindowedYRange overrides the memoized BaseDataSeries.getWindowedYRange (:703-704 memoize) and getResampledPointSeries (BaseRenderableSeries.js:705-729) caches only the resampled vectors, not the range. XY (BaseDataSeries.js:1456), band/Xyy (XyyDataSeries.js:228-232) and Hlc (HlcDataSeries.js:276,293) use NumberUtil.MinMaxWithIndex (types/types/TSciChart.d.ts:248), so the fix pattern exists; imports in the diff resolve (esm/Core/Deleter, esm/utils/isRealNumber, as BaseDataSeries.js:3,15). Corrected: scale overstated the non-resampled case. RequiresReduction (ExtremeResamplerHelper.js:108-116) resamples whenever visible points exceed the viewport-width-based threshold, so with default resampling both paths scan on the order of the plot width; 5k-50k scanned candles per frame happen only with resamplingMode None. Added to trade_off the floor/ceil difference on category axes (old loop indexes get() with fractional i, which truncates). Severity medium kept: per-frame only under EAutoRange.Always and bounded by plot width under default resampling; SC-06 impact is medium. Typings path corrected to types/types/TSciChart.d.ts.
- Duplicate merged from slice `s08-data-series`: OHLC (and box-plot) Y autorange calls two embind get(i) per visible candle on every autorange call, with no memo
