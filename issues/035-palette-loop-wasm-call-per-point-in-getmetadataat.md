# 035 · Per-point palette loops call dataSeries.getMetadataAt for every point, which crosses into wasm (xValues.size(), plus getStartIndex() for FIFO) even when the series has no metadata

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/DrawingProviders/BaseSeriesDrawingProvider.js:262` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/702665e3ccacd450d8c39e25ec5d1a88/): reproduced on WebGL and WebGPU ([source](../demos/035-palette-getmetadataat-wasm-call-per-point/)) |
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

- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/BaseSeriesDrawingProvider.js:156` — per-point caller in the stroke-only palette loop (line and line-segment series)
- `esm/Charting/Visuals/RenderableSeries/Polar/DrawingProviders/PolarBandSeriesDrawingProvider.js:180` — polar band fill palette loop
- `esm/Charting/Model/BaseDataSeries.js:801` — getMetadataAt calls validateIndex, and so the wasm size() call (plus getStartIndex() on FIFO), before it checks for metadata. Also reported by slice s08-data-series.
- `esm/Charting/Model/BaseDataSeries.js:1230` — validateIndex calls this.count() (:549-551), which calls xValues.size(), an embind call
- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/MountainSeriesDrawingProvider.js:154` — createBrush(), called from every draw (:60), sets requiresUpdate = true, so mountain series run the loop every redraw
- `esm/Charting/ChartModifiers/DataPointSelectionModifier.js:174` — calls it for every point when the modifier attaches (once, not per frame)

## Review notes

- Found by reviewer slice `s04-drawing-providers`.
- Adversarial verification (corrected): Re-read DrawingProviders/BaseSeriesDrawingProvider.js:98-300 and :355-410. The code_quote matches :254-262 verbatim, with the getMetadataAt call at :262; dsCount is read once at :253 and the index is clamped at :256-259. BaseDataSeries.js:800-811: getMetadataAt calls validateIndex (:801 -> :1225-1231), whose range check calls this.count() (:1230 -> :549-551, this.xValues.size()); xValues is a native SCRTDoubleVector or SCRTFifoVector (DoubleVectorProvider.js:4-10, :24-26), so size() is an embind call. The metadataProperty check comes only after that (:802), and FIFO adds xValues.getStartIndex() (:806). The only overrides of getMetadataAt are in heatmap and 3D grid series, which these providers do not draw. Call chain: SciChartRenderer.js:354 rs.draw -> BaseRenderableSeries.js:628 dp.draw -> for example ColumnSeriesDrawingProvider.js:93, PointMarkerDrawingProvider.js:97, MountainSeriesDrawingProvider.js:70, BandSeriesDrawingProvider.js:123, OhlcSeriesDrawingProvider.js:101 (applyStrokeFillPaletting), and LineSeriesDrawingProvider.js:143 / LineSegmentSeriesDrawingProvider.js:120 (applyStrokePaletting, loop :148-159). The only guard is requiresUpdate (:137, :235). shouldUpdatePalette (:360-397) forces it true whenever the provider has no shouldUpdatePalette or it returns true; DefaultPaletteProvider returns true (IPaletteProvider.js:56-58). MountainSeriesDrawingProvider.draw calls createBrush() (:60), which sets requiresUpdate = true (:154), so mountain series always rerun the loop. PolarBandSeriesDrawingProvider.js:158/:180 does the same. Fix check: dataSeries.hasMetadata (BaseDataSeries.js:825-827) tests the same metadataProperty !== undefined condition that getMetadataAt tests, so results are unchanged. The only difference is that validateIndex no longer throws for an empty series (dsCount 0 clamps to -1) when it has no metadata, which is benign. The {stroke, fill} objects are at :398-409, PointMarkerDrawingProvider.js:133 and BubbleSeriesDrawingProvider.js:84, as stated. Severity: this is per visible point per frame, but only for a series with a non-cacheable palette provider, and it removes a constant per-point overhead from a loop that already calls the user callback per point. The rule's impact is medium, so medium stays. Evidence S. Corrected: removed the duplicated other_locations entries (BaseDataSeries.js:1230 and BaseSeriesDrawingProvider.js:156 were listed twice, and :262 duplicated the primary).
- Duplicate merged from slice `s08-data-series`: getMetadataAt calls wasm size() (plus getStartIndex() on FIFO) before checking for metadata, once per point in every palette loop
