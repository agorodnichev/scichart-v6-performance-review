# 075 · FastRectangleRenderableSeries always reports the full index range, so every frame processes every rectangle regardless of zoom

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/FastRectangleRenderableSeries.js:331` |
| Severity | **medium** |
| Pipeline stage | GPU draw (`gpu-draw`) |
| Metric | frame time (pan, zoom) |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/a033d8429f93f75587566d51acbecf9a/): reproduced on WebGL and WebGPU ([source](../demos/075-rectangle-series-no-visible-range-culling/)) |
| Rule | CNV-21, V8-01 (web-performance skill) |
| Effort to fix | medium |

## Demo findings

Answers the open question (evidence H): off-screen rectangles do reach the GPU, 4.55 MB uploaded per frame for 200,000 rectangles with 2,000 visible. See the [demo](https://jsfiddle.net/gh/gist/library/pure/a033d8429f93f75587566d51acbecf9a/).

## Code

```js
    getIndicesRange(xRange, isCategoryData) {
        // Even for sorted data, trying to figure out which rectangles are in view when they can have variable widths is hard and slow.
        return new NumberRange(0, this.dataSeries.count() - 1);
    }
```

## Call path and frequency

SciChartRenderer.prepareSeriesRenderData (esm/Charting/Services/SciChartRenderer.js:610-643) -> ExtremeResamplerHelper.resampleSeries (esm/Charting/Numerics/Resamplers/ExtremeResamplerHelper.js:17-41): rs.getIndicesRange at :28 when supportsResampling is false; otherwise new ResamplingParams calls rs.getIndicesRange (esm/Charting/Numerics/Resamplers/ResamplingParams.js:14), and because the constructor sets resamplingMode None whenever options are passed (FastRectangleRenderableSeries.js:39-41), needsResampling is false and rp.indexesRange is used (:36-41) -> FastRectangleRenderableSeries.getIndicesRange (:329-332) = [0, count-1] -> RenderPassData.indexRange (SciChartRenderer.js:641) -> BaseRenderableSeries.draw (:593) -> RectangleSeriesDrawingProvider.draw: applyStrokeFillPaletting over the full range (DrawingProviders/RectangleSeriesDrawingProvider.js:97), getStartAndCount (DrawingProviders/BaseSeriesDrawingProvider.js:75-90) -> args.count = N (:106) -> native DrawPoints (:136); then generateDataLabels (BaseRenderableSeries.js:645) over the same range (DataLabels/DataLabelState.js:51-53, loop at DataLabels/DataLabelProvider.js:394). FastRectangleRenderableSeries.getYRange (:281) also passes the full range to one native MinMaxPairWithIndex in TopHeight and CenterHeight modes. Rate: every render per rectangle series.

## Why it costs

The native DrawPoints call receives count = N, so the engine iterates over every rectangle on every render; whether it generates vertices for the off-screen ones or skips them early is inside wasm (it receives the viewport size, RectangleSeriesDrawingProvider.js:94), so that part grows with N at an unknown rate. The JS passes that share the index range, data labels and per-point paletting, certainly run over all N. CNV-21 asks to draw the visible range: with sorted X, a binary search finds it.

**Scale where it matters:** Rectangle series used for Gantt bars, timeline cells or histograms with 10^5 or more rectangles, viewed zoomed in, so that only a small fraction is on screen. Certain per-rectangle work on every render: with data labels enabled (defaults pointCountThreshold Infinity and pointGapThreshold 0, DataLabelProvider.js:45-46), getText, a native CalculateStringBounds and a label object for every rectangle, off-screen ones included; with a palette provider, the palette callback for every rectangle unless it is cached (SC-23). Plus one native DrawPoints pass over all N.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/FastRectangleRenderableSeries.js
+++ b/esm/Charting/Visuals/RenderableSeries/FastRectangleRenderableSeries.js
+import { getIndicesRange } from "../../Model/BaseDataSeries";
@@
     getIndicesRange(xRange, isCategoryData) {
-        // Even for sorted data, trying to figure out which rectangles are in view when they can have variable widths is hard and slow.
-        return new NumberRange(0, this.dataSeries.count() - 1);
+        const ds = this.dataSeries;
+        const last = ds.count() - 1;
+        // category axes, unsorted X and FIFO series keep the full range (the FIFO sweep path in
+        // RectangleSeriesDrawingProvider.draw overrides args.count and assumes startIndex 0)
+        if (isCategoryData || !ds.dataDistributionCalculator.isSortedAscending || ds.fifoCapacity > 0 || last < 1) {
+            return new NumberRange(0, last);
+        }
+        // Rectangle i spans [x_i - left, x_i + right]; left/right are the largest extents for the columnXMode:
+        // one native MinMax over x1 - x (StartEnd) or over x1 (StartWidth, MidWidth), cached on ds.changeCount;
+        // dataPointWidth for Mid/Start, recomputed per call when dataPointWidthMode is Absolute (it depends on the zoom).
+        const { left, right } = this.getMaxExtent();
+        // search the X column only: XyxyDataSeries.getIndicesRange (XyxyDataSeries.js:156-162) also binary-searches x1, which need not be sorted
+        const r = getIndicesRange(this.webAssemblyContext, ds.getNativeXValues(), new NumberRange(xRange.min - right, xRange.max + left), true);
+        return new NumberRange(Math.max(0, r.min - 1), Math.min(last, r.max + 1));
     }
```

**Trade-off:** It needs a cached maximum extent per data change. Unsorted X and category axes keep the full range. The Y autorange in TopHeight and CenterHeight modes then follows the visible window, like other series, which is a behaviour change; keep the old range behind yRangeMode if needed. A rectangle that is much wider than the others widens the culling margin for all of them. Data labels then run only over the visible rectangles, and DataLabelState computes pointCount and pointGap from the visible count, so labels that pointCountThreshold or pointGapThreshold suppressed before can appear when zoomed in. FIFO series keep the full range.

## App-side workaround

Split long data into several rectangle series by time bucket and hide the off-screen buckets (isVisible = false), or feed the series only the rectangles near the visible range and refill it with clear() plus appendRange() on visibleRangeChanged.

## Verify

measure.md#fps, `zoom` scenario: zoom into 1% of a 200k-rectangle StartEnd series, then repeat with 400k rectangles and the same visible count, 5 runs per side. Pass (CNV-21): frameP95Ms stays within noise when the off-screen data doubles, and wins against the baseline. Not measured.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/FastRectangleRenderableSeries.js:281` — Y autorange scans all N through the same full range
- `esm/Charting/Visuals/RenderableSeries/FastRectangleRenderableSeries.js:223` — getXRange MidWidth/StartWidth: MinMaxPair over all N on every call, not memoized

## Review notes

- Found by reviewer slice `s03-renderable-series`.
- Adversarial verification (corrected): Re-read FastRectangleRenderableSeries.js:329-332 (quote verbatim, primary :331), :38-41 (resamplingMode None only when options are passed), getYRange :280-325 and getXRange :210-265. Chain confirmed: SciChartRenderer.prepareSeriesRenderData (:610-643) -> ExtremeResamplerHelper.resampleSeries: rs.getIndicesRange at :28 when supportsResampling is false, else via ResamplingParams.js:14 and rp.indexesRange (:36-41, needsResampling false in mode None) -> RenderPassData (:641) -> BaseRenderableSeries.draw (:593) -> RectangleSeriesDrawingProvider.draw: palette over the full range (:97), getStartAndCount (BaseSeriesDrawingProvider.js:75-90) -> args.count = N (:106) -> native DrawPoints (:136). Then generateDataLabels (BaseRenderableSeries.js:645) iterates DataLabelState indexStart..indexEnd taken from the same indexRange (DataLabelState.js:51-53; loop DataLabelProvider.js:394) with defaults pointCountThreshold Infinity and pointGapThreshold 0 (:45-46), so with labels enabled every rectangle gets getText + CalculateStringBounds + a label object per render. No other caller relies on the full range: the rectangle hit-test and data-label providers do not call getIndicesRange. Evidence H kept: the engine receives viewportWidth/Height (:94) and may skip off-screen rectangles before generating vertices, so the GPU part is uncertain. Corrected: why_it_costs no longer asserts that off-screen vertices reach the GPU; scale and call_path add the certain data-label and palette paths and the resampling branch; fix_diff now searches only the X column with the exported getIndicesRange helper (BaseDataSeries.js:1403), because ds.getIndicesRange on an XyxyDataSeries (XyxyDataSeries.js:156-162) also binary-searches the unsorted x1 column, and it excludes FIFO series, whose sweep path overrides args.count (RectangleSeriesDrawingProvider.js:131-133); trade_off notes the data-label behaviour change. Severity medium kept: per-render, but cost is unproven for the native part.

