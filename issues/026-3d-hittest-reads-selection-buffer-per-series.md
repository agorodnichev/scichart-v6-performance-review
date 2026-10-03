# 026 · 3D tooltip and hover hit tests repeat the same selection lookup once per series (x17-33 sample pixels for SeriesSelectionModifier3D hover), on every pointermove and again on every render

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting3D/ChartModifiers/TooltipModifier3D.js:257` |
| Severity | **medium** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | frame time during hover/orbit with many series (also INP for click selection) |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/31083c7d2abcb756d8bc1ee0b9adb7d2/): reproduced on WebGL and WebGPU ([source](../demos/026-3d-hittest-per-series/)) |
| Rule | EVT-03, SC-27 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
        const seriesInfo = this.getIncludedRenderableSeries()
            .map(rs => rs.hitTest(this.mousePoint))
            .find(result => result.isHit);
```

## Call path and frequency

Per pointermove: MouseManager.js:107-114 onPointerMove -> :322 cm.modifierMouseMove -> TooltipModifier3D.js:242-247 update() -> :257-259 N x BaseRenderableSeries3D.js:257-269 hitTest -> SciChart3DSurface.js:532-540 prepareSelectionBuffer (SCRTSetActiveWorld) -> RenderableSeriesSceneEntity.js:61 / SurfaceMeshSceneEntity.js:132 SCRTGetSelectionInfo + GetEntity().GetEntityId(). With SeriesSelectionModifier3D({ enableHover: true }) (default false, SeriesSelectionModifier3D.js:36): :124-131 modifierMouseMove -> :210-231 updateHoverState -> :236-263 findFirstHit -> :314-318 per sample point N x hitTest. Again per rendered frame: SciChart3DRenderer.js:144 -> SciChart3DSurface.js:623 -> TooltipModifier3D.js:249 and SeriesSelectionModifier3D.js:133-139. Click selection: :165-191 modifierMouseUp -> findFirstHit (once per click). hitTestXyz (RenderableSeriesSceneEntity.js:63-64) shows the selection info holds a single entity id per pixel, so all N calls at one pixel return the same answer and at most one can match. In the wasm, SCRTGetSelectionInfo reads a CPU-side copy of the selection buffer under a lock (TSRSelectionPass::ReadPixel); the GPU readback happens once per selection pass, not per call.

## Why it costs

Each hitTest crosses into wasm about five times (SCRTSetActiveWorld, SCRTGetSelectionInfo, GetEntity, GetEntityId, the m_uiSelectionIndex getter) and allocates embind handles, a HitTestInfo3D and a SeriesInfo3D. The shipped binary shows no per-call GPU sync: TSRSelectionPass::ReadPixel indexes a CPU-side copy under a lock, and the readback happens once per selection pass (WebGPU: async mapAsync). The cost is therefore CPU work and garbage multiplied by N series x sample pixels x (pointermove + render), where one lookup per sample pixel answers the question. Hypothesis, not measured: at 10 series with hover enabled that is about 340 hit tests per pointermove-plus-render, and it grows linearly with series count.

**Scale where it matters:** N series per 3D surface (multi-series scatter/column dashboards: 5-50). Tooltip: N hit tests per pointermove plus N per render. SeriesSelectionModifier3D with enableHover: true and default hitTestRadius 2, hovering empty space: 17N hit tests per pointermove plus 17N per render (33N with prioritizeClosestToCamera); during an orbit drag both run every frame. Each hit test is about five embind calls plus several small JS allocations.

## Fix (library side)

```diff
--- a/esm/Charting3D/ChartModifiers/ChartModifierBase3D.js
+++ b/esm/Charting3D/ChartModifiers/ChartModifierBase3D.js
@@ getIncludedRenderableSeries() {
         return this.getAllSeries().filter(rs => this.testIsIncludedSeries(rs));
     }
+    /** One selection read per pixel: find the series that owns the pixel, hit-test only that one */
+    hitTestOwner(series, point) {
+        const scs = this.parentSurface;
+        scs.prepareSelectionBuffer();
+        const sel = scs.webAssemblyContext3D.SCRTGetSelectionInfo(Math.round(point.x), Math.round(point.y));
+        const entity = sel.GetEntity();
+        const entityId = entity ? entity.GetEntityId() : undefined;
+        if (entityId === undefined) return undefined;
+        const owner = series.find(rs => rs.sceneEntity && rs.sceneEntity.entityId === entityId);
+        return owner ? owner.hitTest(point) : undefined;
+    }
--- a/esm/Charting3D/ChartModifiers/TooltipModifier3D.js
+++ b/esm/Charting3D/ChartModifiers/TooltipModifier3D.js
@@ update() {
-        const seriesInfo = this.getIncludedRenderableSeries()
-            .map(rs => rs.hitTest(this.mousePoint))
-            .find(result => result.isHit);
+        const seriesInfo = this.hitTestOwner(this.getIncludedRenderableSeries(), this.mousePoint);
--- a/esm/Charting3D/ChartModifiers/SeriesSelectionModifier3D.js
+++ b/esm/Charting3D/ChartModifiers/SeriesSelectionModifier3D.js
@@
     hitTestAtPoint(allSeries, point) {
-        return this.hitTestAtPointAllSeries(allSeries, point)[0];
+        const hit = this.hitTestOwner(allSeries, point);
+        return (hit === null || hit === void 0 ? void 0 : hit.isHit) ? hit : undefined;
     }
     hitTestAtPointAllSeries(allSeries, point) {
-        return allSeries.map(rs => rs.hitTest(point)).filter(ht => ht === null || ht === void 0 ? void 0 : ht.isHit);
+        const hit = this.hitTestAtPoint(allSeries, point); // one pixel holds one entity id
+        return hit ? [hit] : [];
     }
```

**Trade-off:** A miss costs 1 selection read per sample pixel instead of N; a hit costs 2 (owner lookup + the owner's own hitTest). Results are unchanged because a pixel stores one entity id. A custom series whose scene entity has no entityId would no longer be found; keep the old per-series loop as a fallback when no owner matches if custom 3D series must be supported. Coalescing (doing the tooltip/hover hit test once per frame in onParentSurfaceRendered instead of also in pointermove) would remove the remaining duplicate pass but changes when hover events fire.

## App-side workaround

Restrict hit-tested series with includedSeriesIds/excludedSeriesIds, construct SeriesSelectionModifier3D with hitTestRadius: 0 (1 sample point instead of 17) and leave prioritizeClosestToCamera false.

## Verify

measure.md#fps: 3D surface with 10 ScatterRenderableSeries3D, SeriesSelectionModifier3D({ enableHover: true }) + TooltipModifier3D + OrbitModifier3D; scenario = 5 s hover sweep over empty space, then 5 s orbit drag. Add a dev counter wrapping wasmContext3D.SCRTGetSelectionInfo. Pass: counter <= 2 per sample pixel (baseline N per pixel), __wpProbe.loaf script time attributed to hitTest/findFirstHit goes down, and compare-runs shows frameP95Ms and longFramesPer10s win or stay neutral. Repeat at 50 series to see the scaling.

## Other locations

- `esm/Charting3D/ChartModifiers/SeriesSelectionModifier3D.js:318` — hitTestAtPointAllSeries: allSeries.map(rs => rs.hitTest(point)).filter(...) for every sample point
- `esm/Charting3D/ChartModifiers/SeriesSelectionModifier3D.js:246` — findFirstHit on a miss samples 1 + 8*hitTestRadius points (default radius 2 -> 17), each x N series
- `esm/Charting3D/ChartModifiers/SeriesSelectionModifier3D.js:309` — prioritizeClosestToCamera (default false) always samples 1 + 16*radius points (33, some duplicated by rounding) x N series, even when the centre hits
- `esm/Charting3D/ChartModifiers/SeriesSelectionModifier3D.js:138` — onParentSurfaceRendered repeats the whole hover hit test on every render (only with enableHover: true; default false at :36)
- `esm/Charting3D/ChartModifiers/TooltipModifier3D.js:250` — onParentSurfaceRendered repeats update() after the pointermove already ran it
- `esm/Charting3D/Visuals/RenderableSeries/BaseRenderableSeries3D.js:264` — prepareSelectionBuffer() -> SCRTSetActiveWorld per series per sample
- `esm/Charting3D/Visuals/Primitives/RenderableSeriesSceneEntity.js:61` — SCRTGetSelectionInfo(x, y) per call (SurfaceMeshSceneEntity.js:132 same). It returns a handle to one static native struct, so not deleting it is correct; the per-call cost is embind crossings and garbage, not a GPU readback

## Review notes

- Found by reviewer slice `s13-3d-series-modifiers`.
- Adversarial verification (corrected): Re-read TooltipModifier3D.js:242-259 (quote at :257-259 matches verbatim; file is CRLF), SeriesSelectionModifier3D.js:115-319, BaseRenderableSeries3D.js:257-294, SciChart3DSurface.js:532-540/621-625, RenderableSeriesSceneEntity.js:57-68, SurfaceMeshSceneEntity.js:128-140, ChartModifierBase3D.js:42-72. Confirmed: TooltipModifier3D.update maps rs.hitTest over every included series before find() (no short-circuit), from pointermove (MouseManager.js:107-114 -> :322 -> TooltipModifier3D.js:242-247) and again on every render (SciChart3DRenderer.js:144 -> SciChart3DSurface.js:623 -> TooltipModifier3D.js:249-250). SeriesSelectionModifier3D does the same per sample pixel (hitTestAtPointAllSeries :317-318); findFirstHit samples 1+8*radius pixels on a miss (:236-263, default radius 2 -> 17) and findClosestHitToCamera 1+16*radius (:268-313 -> 33) - but the hover path (:124-131, :133-139) only runs with enableHover: true, which defaults to false (:36); click selection (:165-191) is once per click. A pixel yields one entity id (RenderableSeriesSceneEntity.js:63-64, SurfaceMeshSceneEntity.js:135), so N-1 of the N calls per pixel are redundant. Refuted the cost premise (GPU sync per call) by decoding the shipped nosimd wasm binaries with a scratch call-graph script: charting3d f442 (SCRTGetSelectionInfo; invoker f441 calls it and returns its i32 unchanged) rounds x,y, calls core TSRSelectionPass::ReadPixel, then TSRSelectionManager Lock/GetSelectionInfo/Unlock, and returns a pointer to one static struct (__memory_base+264212). Core ReadPixel (f4020) either calls the render target's 7-arg virtual (vtable slot 6; the only 7-arg function at slot 6 in any vtable found is f1074, an empty body) or indexes a CPU-side array under a mutex. The core's only glReadPixels call site (f3937) reads the whole GL_VIEWPORT as RGBA and flips it (a frame-level copy), has no direct callers and a (i32,i32)->void signature that none of ReadPixel's or f442's call_indirect types can dispatch to; WebGPU reads back asynchronously (ScheduleWebGPUReadback -> CopyTextureToBuffer + emwgpuBufferMapAsync). So each hitTest costs about five embind crossings (SCRTSetActiveWorld via prepareSelectionBuffer, SCRTGetSelectionInfo, GetEntity, GetEntityId, m_uiSelectionIndex) plus JS garbage (embind handles, HitTestInfo3D, SeriesInfo3D), not a GPU readback. Also corrected the 'result handle never deleted' note: the handle wraps a static struct, so not deleting it is correct and nothing leaks. Severity high -> medium and evidence S -> H: the path is per pointermove/per render, but the remaining cost is CPU boundary crossings and allocations whose size depends on N, hitTestRadius and the non-default enableHover; with defaults it is N calls per pointermove plus N per render. Rules GPU-27/GPU-28 dropped (no synchronous readback per call); EVT-03/SC-27 kept. Fix diff checked: entityId getter exists (BaseSceneEntity3D.js:74), sceneEntity getter (BaseRenderableSeries3D.js:104), Math.round matches hitTestXyz, isHitTestEnabled is forced on by both modifiers' onAttach, and results are unchanged because one pixel holds one entity id. Verify recipe updated to drop the GPUTask criterion.

