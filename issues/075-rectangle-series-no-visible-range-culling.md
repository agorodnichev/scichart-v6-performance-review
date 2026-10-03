# 075 · FastRectangleRenderableSeries always reports the full index range, so every frame processes every rectangle regardless of zoom

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/FastRectangleRenderableSeries.js:331` |
| Severity | **medium** |
| Pipeline stage | GPU draw (`gpu-draw`) |
| Metric | frame time (pan, zoom) |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | CNV-21, V8-01 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
    getIndicesRange(xRange, isCategoryData) {
        // Even for sorted data, trying to figure out which rectangles are in view when they can have variable widths is hard and slow.
        return new NumberRange(0, this.dataSeries.count() - 1);
    }
```

## Call path and frequency

SciChartRenderer.prepareSeriesRenderData (esm/Charting/Services/SciChartRenderer.js:610-643) -> ExtremeResamplerHelper.resampleSeries (esm/Charting/Numerics/Resamplers/ExtremeResamplerHelper.js:24-29; rectangle series default to resamplingMode None, FastRectangleRenderableSeries.js:41) -> rs.getIndicesRange -> FastRectangleRenderableSeries.getIndicesRange (:329-332) = [0, count-1] -> RenderPassData.indexRange -> RectangleSeriesDrawingProvider.draw -> getStartAndCount (DrawingProviders/BaseSeriesDrawingProvider.js:75-90) -> args.count = N (RectangleSeriesDrawingProvider.js:106); the palette and data-label passes run over the same full range. FastRectangleRenderableSeries.getYRange (:281) also takes the min/max over all N in TopHeight and CenterHeight modes. Rate: every frame per rectangle series.

## Why it costs

Vertex generation in wasm and the GPU vertex work grow with all N rectangles, not with the visible ones, and the off-screen ones are only clipped. CNV-21 asks to draw the visible range: with sorted X, a binary search finds it.

**Scale where it matters:** Rectangle series used for Gantt bars, timeline cells or histograms with 10^5 or more rectangles, viewed zoomed in, so that only a small fraction is on screen.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/FastRectangleRenderableSeries.js
+++ b/esm/Charting/Visuals/RenderableSeries/FastRectangleRenderableSeries.js
     getIndicesRange(xRange, isCategoryData) {
-        // Even for sorted data, trying to figure out which rectangles are in view when they can have variable widths is hard and slow.
-        return new NumberRange(0, this.dataSeries.count() - 1);
+        const ds = this.dataSeries;
+        const last = ds.count() - 1;
+        if (isCategoryData || !ds.dataDistributionCalculator.isSortedAscending || last < 1) {
+            return new NumberRange(0, last);
+        }
+        // the rectangle at i spans [x_i - left, x_i + right]; left/right = max extents for the columnXMode,
+        // cached per ds.changeCount (one MinMax of x1 - x for StartWidth/StartEnd/MidWidth, dataPointWidth otherwise)
+        const { left, right } = this.getMaxExtentCached();
+        const r = ds.getIndicesRange(new NumberRange(xRange.min - right, xRange.max + left), false);
+        return new NumberRange(Math.max(0, r.min - 1), Math.min(last, r.max + 1));
     }
```

**Trade-off:** It needs a cached maximum extent per data change. Unsorted X and category axes keep the full range. The Y autorange in TopHeight and CenterHeight modes then follows the visible window, like other series, which is a behaviour change; keep the old range behind yRangeMode if needed. A rectangle that is much wider than the others widens the culling margin for all of them.

## App-side workaround

Split long data into several rectangle series by time bucket and hide the off-screen buckets (isVisible = false), or feed the series only the rectangles near the visible range and refill it with clear() plus appendRange() on visibleRangeChanged.

## Verify

measure.md#fps, `zoom` scenario: zoom into 1% of a 200k-rectangle StartEnd series, then repeat with 400k rectangles and the same visible count, 5 runs per side. Pass (CNV-21): frameP95Ms stays within noise when the off-screen data doubles, and wins against the baseline. Not measured.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/FastRectangleRenderableSeries.js:281` — Y autorange scans all N through the same full range
- `esm/Charting/Visuals/RenderableSeries/FastRectangleRenderableSeries.js:223` — getXRange MidWidth/StartWidth: MinMaxPair over all N on every call, not memoized

## Review notes

- Found by reviewer slice `s03-renderable-series`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

