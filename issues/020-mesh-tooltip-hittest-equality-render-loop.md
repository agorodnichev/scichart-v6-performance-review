# 020 · TooltipModifier3D over a surface mesh re-renders the chart every frame forever: HitTestInfo3D.isEqual compares selectionIjIndices by reference

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting3D/Visuals/RenderableSeries/HitTestInfo3D.js:25` |
| Severity | **high** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | frame time (also idle CPU/GPU power, style/layout/paint) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | CNV-02 (web-performance skill) |
| Effort to fix | small |

## Code

```js
        return !(info1.isEmpty !== info2.isEmpty ||
            info1.associatedSeries !== info2.associatedSeries ||
            !Point.isEqual(info1.hitTestPoint, info2.hitTestPoint) ||
            info1.isHit !== info2.isHit ||
            info1.selectionIndex !== info2.selectionIndex ||
            info1.selectionIjIndices !== info2.selectionIjIndices);
```

## Call path and frequency

Per display frame, indefinitely: SciChart3DRenderer.js:144 render() -> scs.onSciChartRendered() -> SciChart3DSurface.js:623 cm.onParentSurfaceRendered() -> TooltipModifier3D.js:249-250 update() -> :257-259 rs.hitTest(mousePoint) -> BaseRenderableSeries3D.js:267/290 new SurfaceMeshSeriesInfo3D(hitTestInfo with a new selectionIjIndices Point, SurfaceMeshSceneEntity.js:136) -> TooltipModifier3D.js:292 tooltipAnnotation.seriesInfo = ... -> TooltipSvgAnnotation3D.js:50 !SeriesInfo3D.isEqual(...) -> SeriesInfo3D.js:48 -> HitTestInfo3D.js:25 returns false -> TooltipSvgAnnotation3D.js:52 notifyPropertyChanged -> AnnotationBase.js:957-959 invalidateParentCallback -> SciChart3DSurface.js:569-586 invalidateElement (isInvalidated was reset at SciChart3DRenderer.js:72, so a new draw is requested via TSRRequestCanvasDraw) -> next frame SciChart3DRenderer.js:126-133 svg.update() (TooltipSvgAnnotation3D.js:139-152: removes and re-parses the tooltip SVG with a feGaussianBlur filter) -> :144 onSciChartRendered -> repeat. Entry also from MouseManager.js:107-114 pointermove -> TooltipModifier3D.js:242-247. Verified the equality result with the shipped cjs HitTestInfo3D: two hits on the same cell at the same pixel -> isEqual false (mesh), true (xyz).

## Why it costs

The render-on-demand contract breaks: a render triggers a hit test whose result never compares equal to the previous one, which invalidates the tooltip annotation, which requests the next render. The chart runs the full JS render pass, the wasm scene draw and selection pass, and a tooltip SVG remove/parse/insert (style, layout and filtered paint) on every frame with no input and no data change, until the pointer moves off the mesh. Hidden-tab rAF throttling is the only stop.

**Scale where it matters:** Any SurfaceMeshRenderableSeries3D with TooltipModifier3D (the standard surface-plot-with-tooltip setup) once the pointer rests over the mesh; independent of data size. Each iteration costs a full 3D scene draw plus the selection pass (grows with mesh size and series count) plus an SVG DOM rebuild. Because TooltipModifier3D never clears mousePoint on pointer leave (see F tooltip-keeps-hittesting-after-pointer-leave), the loop keeps running after the pointer leaves the chart if its last position was over the mesh.

## Fix (library side)

```diff
--- a/esm/Charting3D/Visuals/RenderableSeries/HitTestInfo3D.js
+++ b/esm/Charting3D/Visuals/RenderableSeries/HitTestInfo3D.js
@@ static isEqual(info1, info2) {
         return !(info1.isEmpty !== info2.isEmpty ||
             info1.associatedSeries !== info2.associatedSeries ||
             !Point.isEqual(info1.hitTestPoint, info2.hitTestPoint) ||
             info1.isHit !== info2.isHit ||
             info1.selectionIndex !== info2.selectionIndex ||
-            info1.selectionIjIndices !== info2.selectionIjIndices);
+            !Point.isEqual(info1.selectionIjIndices, info2.selectionIjIndices));
     }
(Point is already imported in this file; Point.isEqual(undefined, undefined) is true, so XYZ hits are unchanged.)
```

**Trade-off:** None in behaviour: two hits on the same cell are now equal, so the tooltip only re-renders when the hovered cell, value or pointer changes. Costs two number comparisons per update.

## App-side workaround

HitTestInfo3D is exported from 'scichart'; patch the static once at startup to compare selectionIjIndices by value, e.g. `const eq = HitTestInfo3D.isEqual; HitTestInfo3D.isEqual = (a, b) => eq(a, b) || (!!a && !!b && a.selectionIjIndices?.x === b.selectionIjIndices?.x && a.selectionIjIndices?.y === b.selectionIjIndices?.y && eq({ ...a, selectionIjIndices: undefined }, { ...b, selectionIjIndices: undefined }));`

## Verify

measure.md#fps idle check: SurfaceMeshRenderableSeries3D 100x100 + TooltipModifier3D, move the pointer onto the mesh and stop; mark wp:start/wp:end around 5 s with no input, trace without the frame probe. Baseline shows one DrawFrame/'Animation frame fired' per display frame; Pass: 0 'Animation frame fired' and 0 tooltip SVG Layout/Paint in the idle window after the fix.

## Other locations

- `esm/Charting3D/Visuals/Primitives/SurfaceMeshSceneEntity.js:136` — `new Point(selectionInfo.m_uiHeightMapIndexI, ...)` per mesh hit test, so two hits on the same cell never compare equal (s12 file, the allocation site)
- `esm/Charting3D/ChartModifiers/TooltipModifier3D.js:292` — `this.tooltipAnnotation.seriesInfo = seriesInfo` on every update()
- `esm/Charting3D/Visuals/RenderableSeries/SeriesInfo3D.js:48` — equals() delegates to HitTestInfo3D.isEqual
- `esm/Charting3D/ChartModifiers/TooltipModifier3D.js:249` — onParentSurfaceRendered() -> update() closes the loop on every rendered frame

## Review notes

- Found by reviewer slice `s13-3d-series-modifiers`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

