# 026 · 3D hover/tooltip hit tests read the same selection-buffer pixel once per series (and up to 17-33 pixels per sample), on every pointermove and again on every rendered frame

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting3D/ChartModifiers/TooltipModifier3D.js:257` |
| Severity | **high** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | frame time during hover/orbit (also INP for click selection) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | GPU-28, GPU-27, EVT-03, SC-27 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
        const seriesInfo = this.getIncludedRenderableSeries()
            .map(rs => rs.hitTest(this.mousePoint))
            .find(result => result.isHit);
```

## Call path and frequency

Per pointermove: MouseManager.js:107-114 onPointerMove -> :322 cm.modifierMouseMove -> TooltipModifier3D.js:242-247 update() -> :257-259 N x BaseRenderableSeries3D.js:257-269 hitTest -> SciChart3DSurface.js:532-540 prepareSelectionBuffer (SCRTSetActiveWorld) -> RenderableSeriesSceneEntity.js:61 / SurfaceMeshSceneEntity.js:132 SCRTGetSelectionInfo. SeriesSelectionModifier3D.js:124-131 modifierMouseMove -> :210-231 updateHoverState -> :236-263 findFirstHit -> :314-318 per sample point N x hitTest. Again per rendered frame: SciChart3DRenderer.js:144 -> SciChart3DSurface.js:623 -> TooltipModifier3D.js:249 and SeriesSelectionModifier3D.js:133-139. hitTestXyz (RenderableSeriesSceneEntity.js:63-64) shows the selection info holds a single entity id per pixel, so all N calls at one pixel return the same answer and at most one can match.

## Why it costs

Each hitTest is a JS->wasm round trip into the selection manager plus HitTestInfo3D/SeriesInfo3D allocations. The 3D side module imports TSRSelectionPass::ReadPixel and the core module imports glReadPixels, so each SCRTGetSelectionInfo is likely a synchronous 1x1 readback that waits for queued GPU work (hypothesis: engine code is out of scope). Multiplying that by series count and sample points on every pointer event and every frame puts many GPU sync points on the input and frame path where one read per sample pixel answers the question.

**Scale where it matters:** N series per 3D surface (multi-series scatter/column dashboards: 5-50). Hover over empty space with SeriesSelectionModifier3D defaults = 17N selection reads per pointermove; during an orbit drag with a render every frame that doubles. Tooltip adds N reads per pointermove plus N per render.

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

measure.md#fps: 3D surface with 10 ScatterRenderableSeries3D, SeriesSelectionModifier3D({ enableHover: true }) + TooltipModifier3D + OrbitModifier3D; scenario = 5 s hover sweep over empty space, then 5 s orbit drag. Add a dev counter wrapping wasmContext3D.SCRTGetSelectionInfo. Pass: counter <= 2 per sample pixel (baseline N per pixel), compare-runs 'win' on frameP95Ms and longFramesPer10s, and trace-summary GPUTask time / LoAF time in hitTest goes down.

## Other locations

- `esm/Charting3D/ChartModifiers/SeriesSelectionModifier3D.js:318` — hitTestAtPointAllSeries: allSeries.map(rs => rs.hitTest(point)).filter(...) for every sample point
- `esm/Charting3D/ChartModifiers/SeriesSelectionModifier3D.js:246` — findFirstHit on a miss samples 1 + 8*hitTestRadius points (default radius 2 -> 17), each x N series
- `esm/Charting3D/ChartModifiers/SeriesSelectionModifier3D.js:309` — prioritizeClosestToCamera always samples 1 + 16*radius points (33) x N series, even when the centre hits
- `esm/Charting3D/ChartModifiers/SeriesSelectionModifier3D.js:138` — onParentSurfaceRendered repeats the whole hover hit test on every render
- `esm/Charting3D/ChartModifiers/TooltipModifier3D.js:250` — onParentSurfaceRendered repeats update() after the pointermove already ran it
- `esm/Charting3D/Visuals/RenderableSeries/BaseRenderableSeries3D.js:264` — prepareSelectionBuffer() -> SCRTSetActiveWorld per series per sample
- `esm/Charting3D/Visuals/Primitives/RenderableSeriesSceneEntity.js:61` — SCRTGetSelectionInfo(x, y) per call; result handle never deleted (s12 file). SurfaceMeshSceneEntity.js:132 same

## Review notes

- Found by reviewer slice `s13-3d-series-modifiers`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

