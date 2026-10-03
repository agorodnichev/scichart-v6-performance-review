# 035 · Per-point palette loops call dataSeries.getMetadataAt for every point, which crosses into wasm (xValues.size(), plus getStartIndex() for FIFO) even when the series has no metadata

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/DrawingProviders/BaseSeriesDrawingProvider.js:262` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | TASK-13, SC-06 (web-performance skill) |
| Effort to fix | small |

## Code

```js
            for (let index = startIndex; index < startIndex + count; index++) {
                let originalDataIndex = hasPSIndexes ? indexView[index] : index;
                if (originalDataIndex < 0)
                    originalDataIndex = 0;
                else if (originalDataIndex >= dsCount)
                    originalDataIndex = dsCount - 1;
                const xValue = xView[index];
                const yValue = yValues ? yView[index] : undefined;
                const overriddenColors = this.overridePaletteProviderColors(this.parentSeries, xValue, yValue, originalDataIndex, opacity, dataSeries.getMetadataAt(originalDataIndex), otherValues);
```

## Call path and frequency

SciChartRenderer.js:354 -> BaseRenderableSeries.js:628 -> a paletted provider: ColumnSeriesDrawingProvider.draw (:93), PointMarkerDrawingProvider.draw (:97), MountainSeriesDrawingProvider.draw (:70) and others -> BaseSeriesDrawingProvider.applyStrokeFillPaletting loop (:254-276) -> dataSeries.getMetadataAt (esm/Charting/Model/BaseDataSeries.js:800) -> validateIndex (:801 -> :1225-1230) -> count() (:549-551) -> xValues.size() [wasm]. FIFO series also call xValues.getStartIndex() (:806). applyStrokePaletting (:156) and PolarBand (:180) do the same. Rate: per visible point on every palette update. That is every redraw for DefaultPaletteProvider subclasses, whose shouldUpdatePalette returns true (IPaletteProvider.js:56-58), for providers without shouldUpdatePalette, and always for mountain series.

## Why it costs

The loop already clamps originalDataIndex to [0, dsCount) with dsCount read once (:253, :256-259). getMetadataAt's validateIndex repeats that bounds check through a wasm count() call per point, and checks whether metadata exists only after that call. Each point also allocates a {stroke, fill} result object (overridePaletteProviderColors :398-409; the PointMarker and Bubble overrides return a fresh object at :133 and :84). Those objects are short-lived (V8-06) and minor next to the wasm call.

**Scale where it matters:** One or two embind calls per visible point per redraw. 100k visible paletted points means 100k-200k wasm calls per frame, on top of the user callback.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/DrawingProviders/BaseSeriesDrawingProvider.js
+++ b/esm/Charting/Visuals/RenderableSeries/DrawingProviders/BaseSeriesDrawingProvider.js
@@ applyStrokeFillPaletting(...) {
             const dsCount = dataSeries.count();
+            // index is clamped to [0, dsCount) below, so skip getMetadataAt's validateIndex -> count() -> xValues.size() wasm call
+            const hasMetadata = dataSeries.hasMetadata;
             for (let index = startIndex; index < startIndex + count; index++) {
@@
-                const overriddenColors = this.overridePaletteProviderColors(this.parentSeries, xValue, yValue, originalDataIndex, opacity, dataSeries.getMetadataAt(originalDataIndex), otherValues);
+                const metadata = hasMetadata ? dataSeries.getMetadataAt(originalDataIndex) : undefined;
+                const overriddenColors = this.overridePaletteProviderColors(this.parentSeries, xValue, yValue, originalDataIndex, opacity, metadata, otherValues);
// Make the same change in applyStrokePaletting (dsCount at :141, the call at :156) and in
// PolarBandSeriesDrawingProvider.applyFillFillPaletting (dsCount at :158, the call at :180).
```

**Trade-off:** No change for series without metadata. Series with metadata still pay the call and its wasm count(). A follow-up could add a BaseDataSeries helper that returns the metadata array and the FIFO start once per loop.

## App-side workaround

Make the provider cacheable (SC-23): shouldUpdatePalette() returns false while its inputs are unchanged, and isRangeIndependant returns true, so the loop runs only on data changes. This does not help mountain series (see the mountain finding).

## Verify

measure.md#fps, `pan` on a FastColumnRenderableSeries with 100k points and a fill palette provider (default shouldUpdatePalette), 5 runs per side. Pass: compare-runs reports 'win' on frameP95Ms, and the LoAF script time attributed to applyStrokeFillPaletting goes down.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/BaseSeriesDrawingProvider.js:156` — stroke-only palette loop
- `esm/Charting/Visuals/RenderableSeries/Polar/DrawingProviders/PolarBandSeriesDrawingProvider.js:180` — polar band fill palette loop
- `esm/Charting/Model/BaseDataSeries.js:1230` — validateIndex calls this.count(), which is xValues.size()
- `esm/Charting/Model/BaseDataSeries.js:801` — same root cause, also reported by slice s08-data-series: getMetadataAt calls wasm size() (plus getStartIndex() on FIFO) before checking for metadata, once per point in every palette loop
- `esm/Charting/Model/BaseDataSeries.js:1230` — validateIndex calls this.count() (:549), which calls xValues.size(), an embind call
- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/BaseSeriesDrawingProvider.js:156` — Per-point caller in the stroke palette loop
- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/BaseSeriesDrawingProvider.js:262` — Per-point caller in the stroke+fill palette loop (column, OHLC, band, box-plot series)
- `esm/Charting/ChartModifiers/DataPointSelectionModifier.js:174` — Calls it for every point when the modifier attaches

## Review notes

- Found by reviewer slice `s04-drawing-providers`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.
- Duplicate merged from slice `s08-data-series`: getMetadataAt calls wasm size() (plus getStartIndex() on FIFO) before checking for metadata, once per point in every palette loop
