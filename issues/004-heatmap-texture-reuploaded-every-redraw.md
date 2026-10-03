# 004 · The uniform heatmap, polar heatmap and contour providers re-upload the whole W x H float texture on every redraw, even when the data and colour map have not changed

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/DrawingProviders/UniformHeatmapDrawingProvider.js:80` |
| Severity | **high** |
| Pipeline stage | GPU upload (`gpu-upload`) |
| Metric | frame time (also GPU-process time) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | GPU-08, SC-09 (web-performance skill) |
| Effort to fix | small |

## Code

```js
            const zValuesVector = dataSeries.getNormalizedVector(this.parentSeries.colorMap, this.parentSeries.fillValuesOutOfRange);
            this.packedFloatParams = this.webAssemblyContext.SCRTFillTextureFloat32(heatTexture, dataSeries.arrayWidth, dataSeries.arrayHeight, zValuesVector);
            this.packedFloatParams.x = 0;
            this.packedFloatParams.y = 1;
            this.packedFloatParams.z = this.parentSeries.linearTextureFilteringIntensity;
            this.packedFloatParams.w = this.parentSeries.useLinearTextureFiltering ? 1 : 0;
```

## Call path and frequency

SciChartRenderer.js:354 rs.draw -> BaseRenderableSeries.js:628 dp.draw -> UniformHeatmapDrawingProvider.draw (:63) -> dataSeries.getNormalizedVector (BaseHeatmapDataSeries.js:350, cached) -> SCRTFillTextureFloat32(heatTexture, arrayWidth, arrayHeight, ...) (:80). Rate: every redraw of the surface, per heatmap series. That covers pan, zoom, modifier-driven redraws and any other series streaming on the same surface. Data changes already reach the provider separately: seriesHasDataChanges (:114) -> onSeriesPropertyChange(DATA_SERIES) (:40-58).

## Why it costs

The texture contents depend only on zValues, colorMap.minimum/maximum and fillValuesOutOfRange, and getNormalizedVector already caches on those inputs. The upload itself has no dirty check, so every redraw sends the full array through the GL texture-upload path: a driver copy plus a transfer to the GPU process. It gets worse when a heatmap and a contour series share one data series. The heatmap passes fillValuesOutOfRange=true (the default, BaseHeatmapRenderableSeries.js:60). The contours pass undefined, usually with a different min and max (UniformContoursDrawingProvider.js:64-66). The single-slot normalized-vector cache (BaseHeatmapDataSeries.js:355-360) then misses on every call, so recreateNormalizedVector (an O(W x H) JS loop) runs twice per redraw on top of the two uploads.

**Scale where it matters:** arrayWidth x arrayHeight x 4 bytes per redraw (R32F). A 1000 x 1000 heatmap moves 4 MB per redraw, or 240 MB/s at 60 redraws/s while you pan a static heatmap.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/DrawingProviders/UniformHeatmapDrawingProvider.js
+++ b/esm/Charting/Visuals/RenderableSeries/DrawingProviders/UniformHeatmapDrawingProvider.js
-import { getTextureVertex, getVectorColorTextureVertex } from "../../../Visuals/Helpers/NativeObject";
+import { getTextureVertex, getVector4, getVectorColorTextureVertex } from "../../../Visuals/Helpers/NativeObject";
@@ onSeriesPropertyChange(propertyName) {
         if (recreateHeat) {
+            this.heatDirty = true;
             const dataSeries = this.parentSeries.dataSeries;
@@ draw(renderContext, renderPassData) {
             const dataSeries = this.parentSeries.dataSeries;
-            const zValuesVector = dataSeries.getNormalizedVector(this.parentSeries.colorMap, this.parentSeries.fillValuesOutOfRange);
-            this.packedFloatParams = this.webAssemblyContext.SCRTFillTextureFloat32(heatTexture, dataSeries.arrayWidth, dataSeries.arrayHeight, zValuesVector);
-            this.packedFloatParams.x = 0;
-            this.packedFloatParams.y = 1;
-            this.packedFloatParams.z = this.parentSeries.linearTextureFilteringIntensity;
-            this.packedFloatParams.w = this.parentSeries.useLinearTextureFiltering ? 1 : 0;
+            const { colorMap, fillValuesOutOfRange } = this.parentSeries;
+            if (this.heatDirty || heatTexture !== this.uploadedTexture ||
+                colorMap.minimum !== this.uploadedMin || colorMap.maximum !== this.uploadedMax ||
+                fillValuesOutOfRange !== this.uploadedFill) {
+                const zValuesVector = dataSeries.getNormalizedVector(colorMap, fillValuesOutOfRange);
+                this.webAssemblyContext.SCRTFillTextureFloat32(heatTexture, dataSeries.arrayWidth, dataSeries.arrayHeight, zValuesVector).delete();
+                this.heatDirty = false;
+                this.uploadedTexture = heatTexture;
+                this.uploadedMin = colorMap.minimum;
+                this.uploadedMax = colorMap.maximum;
+                this.uploadedFill = fillValuesOutOfRange;
+            }
+            // shared cached TSRVector4 (NativeObject.getVector4): never delete it
+            this.packedFloatParams = getVector4(this.webAssemblyContext, 0, 1, this.parentSeries.linearTextureFilteringIntensity, this.parentSeries.useLinearTextureFiltering ? 1 : 0);
@@ drawHeatmap(nativeContext, x, y, width, height) {
         contourParams.delete();
         drawParams.delete();
-        v4.delete();
// Apply the same gate in PolarHeatmapDrawingProvider.draw (lines 16-21, and drop v4.delete() at line 38).
// Apply it in UniformContoursDrawingProvider.draw (line 66) with its own uploaded* fields, set dirty in its
// onSeriesPropertyChange(DATA_SERIES), and add a seriesHasDataChanges override that sets heatDirty.
```

**Trade-off:** This adds a few fields per provider. Every input that changes the texture must set heatDirty: data changes, the DATA_SERIES and USE_LINEAR_TEXTURE_FILTERING property changes, and the colorMap min/max/fill values compared on each draw. Comparing texture identity covers TextureCache recreation. If the engine drops texture contents on a WebGL context restore without changing the TSRTexture handle, the context-restore path must also set heatDirty. packedFloatParams becomes the shared cached vector, so drawHeatmap must stop deleting it. With the gate in place, each provider calls getNormalizedVector only when its own inputs change, which also removes the per-frame cache thrash between a heatmap and a contour series.

## App-side workaround

Keep the heatmap on a surface that redraws only when its data changes: no streaming series or frequently redrawing modifiers on the same surface, and freezeWhenOutOfView. For a contour overlay, give it its own copy of the data series (more memory) so the normalized cache is not shared.

## Verify

measure.md#fps, `pan` scenario on a 1000 x 1000 UniformHeatmapRenderableSeries with static data, plus a run with a heatmap and contours sharing one data series, 5 runs per side. Pass: compare-runs reports 'win' on frameP95Ms, GPUTask time per frame in trace-summary goes down, and a dev counter on SCRTFillTextureFloat32 reads 0 calls in the pan window. Then run measure.md#gpu to confirm that the limiting stage moved.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/Polar/DrawingProviders/PolarHeatmapDrawingProvider.js:17` — same full upload on every redraw
- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/UniformContoursDrawingProvider.js:66` — same upload on every redraw. The getNormalizedVector call omits fillValuesOutOfRange, so the shared cache thrashes against the heatmap.
- `esm/Charting/Model/BaseHeatmapDataSeries.js:355` — single-slot normalized-vector cache keyed on min/max/fill

## Review notes

- Found by reviewer slice `s04-drawing-providers`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

