# 003 · The polar heatmap creates a native SCRTHeatmapSeriesDrawingProvider on every redraw and never deletes it, and the contour series leaks the TSRVector4 returned by each texture fill

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/Polar/DrawingProviders/PolarHeatmapDrawingProvider.js:31` |
| Severity | **high** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory (wasm heap growth), also frame time |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (confirmed) |
| Rule | GPU-05, SC-29 (web-performance skill) |
| Effort to fix | small |

## Code

```js
            const contourParams = new this.webAssemblyContext.SCRTContourParams();
            const nativeDrawingProvider = new this.webAssemblyContext.SCRTHeatmapSeriesDrawingProvider();
            this.recreatePalette();
            const axis = this.parentSeries.xAxis;
            const polarTransform = axis.getTransform();
            nativeDrawingProvider.DrawPolarHeatmap(polarTransform, innerRadius, outerRadius, xStartCoord, this.paletteTexture.getTexture(), // this.paletteTexture.getTexture
            heatTexture, v4, contourParams, xEndCoord);
            contourParams.delete();
            v4.delete();
```

## Call path and frequency

SciChartRenderer.render (esm/Charting/Services/SciChartRenderer.js:88) -> per-series drawFn rs.draw (SciChartRenderer.js:354) -> BaseRenderableSeries.draw (esm/Charting/Visuals/RenderableSeries/BaseRenderableSeries.js:593) -> dp.draw (BaseRenderableSeries.js:628) -> PolarHeatmapDrawingProvider.draw (PolarHeatmapDrawingProvider.js:6) -> new SCRTHeatmapSeriesDrawingProvider (:31), which is never deleted. The contour series takes the same route: UniformContoursDrawingProvider.draw (UniformContoursDrawingProvider.js:56) drops the TSRVector4 returned by SCRTFillTextureFloat32 (:66). Rate: once per redraw for each PolarUniformHeatmapRenderableSeries or UniformContoursRenderableSeries, so on every pan, zoom or stream frame.

## Why it costs

Embind objects made with `new`, and class values returned by value (the typings say `=> TSRVector4`), live in the wasm heap until someone calls `.delete()`. The glue registers a FinalizationRegistry only for smart-pointer handles (_glue-pretty/scichart.js:3739-3757, attachFinalizer, `if (hasSmartPtr)`), so these objects are never reclaimed. Wasm memory only grows, so the page's memory rises for good. Building a native drawing provider each frame also repeats whatever its C++ constructor does. That part is not visible from JS (hypothesis).

**Scale where it matters:** Any polar heatmap or contour series on a view that redraws continuously. At 60 redraws/s that is 216,000 leaked native objects per series per hour. The leak has no bound for the life of the session.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/Polar/DrawingProviders/PolarHeatmapDrawingProvider.js
+++ b/esm/Charting/Visuals/RenderableSeries/Polar/DrawingProviders/PolarHeatmapDrawingProvider.js
+import { deleteSafe } from "../../../../../Core/Deleter";
 import { UniformHeatmapDrawingProvider } from "../../DrawingProviders/UniformHeatmapDrawingProvider";
 export class PolarHeatmapDrawingProvider extends UniformHeatmapDrawingProvider {
+    delete() {
+        this.nativeHeatmapProvider = deleteSafe(this.nativeHeatmapProvider);
+        super.delete();
+    }
@@ draw(renderContext, renderPassData) {
             const contourParams = new this.webAssemblyContext.SCRTContourParams();
-            const nativeDrawingProvider = new this.webAssemblyContext.SCRTHeatmapSeriesDrawingProvider();
+            if (!this.nativeHeatmapProvider) {
+                this.nativeHeatmapProvider = new this.webAssemblyContext.SCRTHeatmapSeriesDrawingProvider();
+            }
+            const nativeDrawingProvider = this.nativeHeatmapProvider;
--- a/esm/Charting/Visuals/RenderableSeries/DrawingProviders/UniformContoursDrawingProvider.js
+++ b/esm/Charting/Visuals/RenderableSeries/DrawingProviders/UniformContoursDrawingProvider.js
@@ draw(renderContext, renderPassData) {
-            this.webAssemblyContext.SCRTFillTextureFloat32(heightsTexture, dataSeries.arrayWidth, dataSeries.arrayHeight, dataSeries.getNormalizedVector(colorMapParams));
+            // TSRVector4 returned by value: owned by JS, no finalizer
+            this.webAssemblyContext.SCRTFillTextureFloat32(heightsTexture, dataSeries.arrayWidth, dataSeries.arrayHeight, dataSeries.getNormalizedVector(colorMapParams)).delete();
--- a/esm/Charting/Visuals/RenderableSeries/DrawingProviders/ErrorSeriesDrawingProvider.js
+++ b/esm/Charting/Visuals/RenderableSeries/DrawingProviders/ErrorSeriesDrawingProvider.js
@@ onDetachSeries() {
         super.onDetachSeries();
+        this.nativeDrawingProvider = deleteSafe(this.nativeDrawingProvider);
+        this.args = deleteSafe(this.args);
     }
```

**Trade-off:** The functional cost is one long-lived native provider per polar heatmap series, freed in delete(). The patch assumes the engine keeps no per-call state in SCRTHeatmapSeriesDrawingProvider. Nothing in the JS suggests it does, but test a polar heatmap whose data changes.

## App-side workaround

For the polar heatmap: subclass PolarHeatmapDrawingProvider and cache the native provider (a patch). For contours: no workaround. In both cases, cut continuous redraws of the surfaces that hold these series: use freezeWhenOutOfView and keep streaming series off the same surface.

## Verify

measure.md#mem: pan a PolarUniformHeatmapRenderableSeries, and separately a UniformContoursRenderableSeries, for 10 repetitions of 300 redraws. Use a dev-only counter that wraps the construction and .delete() of wasmContext.SCRTHeatmapSeriesDrawingProvider and TSRVector4. Pass: the live-object count stays constant after warm-up, and wasmContext.HEAPU8.buffer.byteLength does not grow from S1 to S2.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/UniformContoursDrawingProvider.js:66` — the TSRVector4 returned by SCRTFillTextureFloat32 is never deleted (UniformHeatmapDrawingProvider deletes the same return value at line 196)
- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/ErrorSeriesDrawingProvider.js:35` — onAttachSeries creates new args and a new native provider on every attach. onDetachSeries (lines 43-45) does not delete the old ones, so each detach and re-attach leaks two objects.
- `_glue-pretty/scichart.js:3739` — attachFinalizer registers only smart-pointer handles, so raw embind objects are never finalized

## Review notes

- Found by reviewer slice `s04-drawing-providers`.
- Adversarial verification (confirmed): Re-read PolarHeatmapDrawingProvider.js:6-40: code_quote matches lines 30-38 verbatim; line 31 creates `new SCRTHeatmapSeriesDrawingProvider()` as a local, and only contourParams (:37) and v4 (:38) are deleted. The class has no delete() override and no field holds the provider, so nothing can free it later. Caller chain re-established: SciChartRenderer.render (SciChartRenderer.js:88) -> drawFn rs.draw (:354, skipped only when !rs.isVisible) -> BaseRenderableSeries.draw (BaseRenderableSeries.js:593, guarded only by canDraw :602) -> dp.draw (:628) -> PolarHeatmapDrawingProvider.draw; the provider is pushed in PolarUniformHeatmapRenderableSeries.addDrawingProviders (PolarUniformHeatmapRenderableSeries.js:34), and neither UniformHeatmapRenderableSeries nor BaseHeatmapRenderableSeries overrides draw. No caching, dirty flag or early return beyond the heatTexture null check, so it is one leaked native object per redraw. Every other native drawing provider in the library is held in a field and freed with deleteSafe (LineSegmentSeriesDrawingProvider.js:70, MountainSeriesDrawingProvider.js:30, etc.), which confirms these are raw embind handles; the glue attachFinalizer (_glue-pretty/scichart.js:3739-3757) registers only smart-pointer handles. Contours: UniformContoursDrawingProvider.js:66 discards the TSRVector4 that SCRTFillTextureFloat32 returns by value (types/types/TSciChart.d.ts:4), while UniformHeatmapDrawingProvider deletes the same value (UniformHeatmapDrawingProvider.js:196); the series registers this provider at UniformContoursRenderableSeries.js:91 and reaches it on the same per-redraw path. ErrorSeriesDrawingProvider.js:33-45: onAttachSeries allocates args and nativeDrawingProvider, and onDetachSeries does not free them (compare LineSegmentSeriesDrawingProvider.js:68-71). Attach and detach are called from BaseRenderableSeries.js:769/789, so this leak grows per detach and re-attach. Rule Avoid fields (GPU-05: do not delete right after the draw that used the resource; SC-29) do not excuse a per-frame create with no delete. The fix keeps one provider per series, which matches the library's pattern; the import path ../../../../../Core/Deleter resolves to esm/Core/Deleter. Severity high is kept: this is a leak on the per-frame redraw path. Evidence S is kept: the missing delete is certain in the code, and the native size per object is not claimed.

