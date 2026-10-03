# 004 · The uniform heatmap, polar heatmap and contour providers re-upload the whole W x H float texture on every redraw, even when the data and colour map have not changed

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/DrawingProviders/UniformHeatmapDrawingProvider.js:80` |
| Severity | **high** |
| Pipeline stage | GPU upload (`gpu-upload`) |
| Metric | frame time (also GPU-process time) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/41b48f656c2abe156283db825db9f746/): reproduced on WebGL and WebGPU ([source](../demos/004-heatmap-texture-reupload/)) |
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

SciChartRenderer.render (SciChartRenderer.js:88) -> rs.draw (:354) -> BaseRenderableSeries.draw (BaseRenderableSeries.js:593) -> dp.draw (:628) -> UniformHeatmapDrawingProvider.draw (:63) -> dataSeries.getNormalizedVector (BaseHeatmapDataSeries.js:350, cached) -> SCRTFillTextureFloat32(heatTexture, arrayWidth, arrayHeight, ...) (:80) -> native fn (wasm func 3516 -> 2293, virtual call to the backend texture upload). Rate: every redraw of the surface, per heatmap series. That covers pan, zoom, modifier-driven redraws and any other series streaming on the same surface. Data changes reach the provider separately through seriesHasDataChanges (:114) -> onSeriesPropertyChange(DATA_SERIES) (:40-58), but only for the data series present at construction: the override does not call super, so the dataChanged subscription made in BaseSeriesDrawingProvider.js:46-48 is never moved to a swapped-in series.

## Why it costs

The texture contents depend only on zValues, colorMap.minimum/maximum and fillValuesOutOfRange, and getNormalizedVector already caches on those inputs. The upload itself has no dirty check, so every redraw sends the full array through the GL texture-upload path: a driver copy plus a transfer to the GPU process. It gets worse when a heatmap and a contour series share one data series. The heatmap passes fillValuesOutOfRange=true (the default, BaseHeatmapRenderableSeries.js:60). The contours pass undefined, usually with a different min and max (UniformContoursDrawingProvider.js:64-66). The single-slot normalized-vector cache (BaseHeatmapDataSeries.js:355-360) then misses on every call, so recreateNormalizedVector (an O(W x H) JS loop) runs twice per redraw on top of the two uploads.

**Scale where it matters:** arrayWidth x arrayHeight x 4 bytes per redraw (R32F). A 1000 x 1000 heatmap moves 4 MB per redraw, or 240 MB/s at 60 redraws/s while you pan a static heatmap.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/DrawingProviders/UniformHeatmapDrawingProvider.js
+++ b/esm/Charting/Visuals/RenderableSeries/DrawingProviders/UniformHeatmapDrawingProvider.js
-import { getTextureVertex, getVectorColorTextureVertex } from "../../../Visuals/Helpers/NativeObject";
+import { getTextureVertex, getVector4, getVectorColorTextureVertex } from "../../../Visuals/Helpers/NativeObject";
@@ draw(renderContext, renderPassData) {
             const dataSeries = this.parentSeries.dataSeries;
-            const zValuesVector = dataSeries.getNormalizedVector(this.parentSeries.colorMap, this.parentSeries.fillValuesOutOfRange);
-            this.packedFloatParams = this.webAssemblyContext.SCRTFillTextureFloat32(heatTexture, dataSeries.arrayWidth, dataSeries.arrayHeight, zValuesVector);
-            this.packedFloatParams.x = 0;
-            this.packedFloatParams.y = 1;
-            this.packedFloatParams.z = this.parentSeries.linearTextureFilteringIntensity;
-            this.packedFloatParams.w = this.parentSeries.useLinearTextureFiltering ? 1 : 0;
+            this.uploadHeatTextureIfChanged(heatTexture, dataSeries);
+            // shared cached TSRVector4 (NativeObject.getVector4); drawParams copies it, so never delete it
+            this.packedFloatParams = getVector4(this.webAssemblyContext, 0, 1, this.parentSeries.linearTextureFilteringIntensity, this.parentSeries.useLinearTextureFiltering ? 1 : 0);
@@
+    uploadHeatTextureIfChanged(heatTexture, dataSeries) {
+        const { colorMap, fillValuesOutOfRange } = this.parentSeries;
+        const u = this.uploaded;
+        // Every heatmap data write goes through notifyDataChanged, which bumps changeCount (BaseHeatmapDataSeries.js:341).
+        // Do not rely on seriesHasDataChanges: onSeriesPropertyChange here does not call super, so the dataChanged
+        // subscription stays on the data series present at construction. Comparing the series itself covers a swap,
+        // and comparing the texture covers TextureCache recreation (new size, invalidateCache).
+        if (u && u.texture === heatTexture && u.dataSeries === dataSeries && u.changeCount === dataSeries.changeCount &&
+            u.min === colorMap?.minimum && u.max === colorMap?.maximum && u.fill === fillValuesOutOfRange) {
+            return;
+        }
+        const zValuesVector = dataSeries.getNormalizedVector(colorMap, fillValuesOutOfRange);
+        // TSRVector4 returned by value: owned by JS, no finalizer
+        this.webAssemblyContext.SCRTFillTextureFloat32(heatTexture, dataSeries.arrayWidth, dataSeries.arrayHeight, zValuesVector).delete();
+        this.uploaded = { texture: heatTexture, dataSeries, changeCount: dataSeries.changeCount,
+            min: colorMap.minimum, max: colorMap.maximum, fill: fillValuesOutOfRange };
+    }
@@ drawHeatmap(nativeContext, x, y, width, height) {
         contourParams.delete();
         drawParams.delete();
-        v4.delete();
// PolarHeatmapDrawingProvider.draw: replace lines 16-21 with the same two statements (it inherits
// uploadHeatTextureIfChanged), and drop v4.delete() at line 38.
// UniformContoursDrawingProvider.draw: replace line 66 with the same gate keyed on heightsTexture, dataSeries,
// dataSeries.changeCount and colorMapParams.minimum/maximum, and call .delete() on the returned TSRVector4.
```

**Trade-off:** This adds one small record per provider. The gate relies on every data write going through notifyDataChanged (changeCount), which the existing getNormalizedVector cache already relies on (hasDataChangesProperty, BaseHeatmapDataSeries.js:342 and :355). Code that mutates zValues in place without notifying is already stale today. Comparing the texture handle covers TextureCache recreation, including invalidateCache after context loss, because TextureCache.value then creates a new handle. If an engine backend drops texture contents without changing the TSRTexture handle (not visible from JS, hypothesis), that path must clear `uploaded`. packedFloatParams becomes the shared cached vector, so drawHeatmap and PolarHeatmapDrawingProvider must stop deleting it. Each provider then calls getNormalizedVector only when its own inputs change, which also stops the per-frame cache thrash between a heatmap and a contour series that share one data series.

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
- Adversarial verification (corrected): Re-read UniformHeatmapDrawingProvider.js:63-113: code_quote matches lines 79-84 verbatim. Line 80 calls SCRTFillTextureFloat32 on every draw with no gate; only the JS normalization is cached (BaseHeatmapDataSeries.js:350-366, single slot keyed on hasDataChangesProperty, size, min, max and fill). Caller chain: SciChartRenderer.render (SciChartRenderer.js:88) -> rs.draw (:354, skipped only when !isVisible) -> BaseRenderableSeries.draw (:593, canDraw guard :602) -> dp.draw (:628) -> UniformHeatmapDrawingProvider.draw (:63). There is no dirty check, so pan, zoom and any other redraw of the surface re-runs it. PolarHeatmapDrawingProvider.js:17 and UniformContoursDrawingProvider.js:66 do the same. Native side: I parsed _wasm/scichart.wasm. The embind registration of SCRTFillTextureFloat32 (name string at 22126, registered in func 3503) points to fn func 3516 -> func 2293, which makes a virtual call (call_indirect). Every caller of the glTexImage2D import (funcs 3899, 3904, 3956-3958) is a table (virtual) function, which fits a backend texture upload through a virtual call. No dirty or version argument is passed, and the same normalizedVector object is refilled in place, so the engine cannot skip the work without an O(WxH) compare. This is also the only place the texture is ever filled, so the upload mechanism is certain: S is kept. Thrash claim confirmed: the heatmap passes fillValuesOutOfRange=true (BaseHeatmapRenderableSeries.js:60), and contours call getNormalizedVector(colorMapParams) with no fill argument (:66), so a shared data series misses the cache on both calls every redraw. Severity high is kept: per frame while panning. The rules' Avoid fields (GPU-08, SC-09) do not excuse a static texture re-filled every frame. CORRECTED fix_diff: the original gated on a heatDirty flag set from seriesHasDataChanges. UniformHeatmapDrawingProvider.onSeriesPropertyChange (:40-59) does not call super, so BaseSeriesDrawingProvider never moves its dataChanged subscription (subscribed once in the constructor at BaseSeriesDrawingProvider.js:46-48, moved only in the base onSeriesPropertyChange at :326-334). After `series.dataSeries = newDs`, later setZValues/setZValue calls on newDs would not set heatDirty, and the heatmap would show stale data. The new gate keys on dataSeries identity plus dataSeries.changeCount (bumped by every notifyDataChanged, BaseHeatmapDataSeries.js:341 and :448; setZValues :155, setZValue :175, the xStart/xStep setters in UniformHeatmapDataSeries.js:47-86) plus texture identity (TextureCache.create returns the same handle for the same size, and value recreates it after invalidateCache) plus min, max and fill. It keeps the getVector4 shared vector (NativeObject.js:240-251). Nothing between draw() and drawHeatmap() calls getVector4, and drawParams.m_vPackedFloatParams copies the value. Updated call_path and trade_off to match.

