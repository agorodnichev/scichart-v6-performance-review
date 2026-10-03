# 033 · Style animations with a pointMarker style replace series.pointMarker without deleting the old one, leaking 3 sprite textures per run

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/BaseRenderableSeries.js:1313` |
| Severity | **medium** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory (wasm heap, GPU textures) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | SC-29, GPU-30 (web-performance skill) |
| Effort to fix | small |

## Code

```js
    beforeAnimationStart() {
        var _a;
        const { animation } = this.animationFSM;
        this.setAnimationVectors(animation);
        const animationPointMarkerStyle = (_a = animation === null || animation === void 0 ? void 0 : animation.styles) === null || _a === void 0 ? void 0 : _a.pointMarker;
        if (animationPointMarkerStyle) {
            this.pointMarker = animationHelpers.createPointMarker(this.webAssemblyContext, animationPointMarkerStyle);
        }
    }
```

## Call path and frequency

App series.runAnimation(...) / enqueueAnimation(...) with styles.pointMarker (BaseRenderableSeries.js:1023-1033) -> next frame SciChartRenderer.render -> SciChartSurface.onAnimate (esm/Charting/Visuals/SciChartSurface.js:952-953) -> BaseRenderableSeries.onAnimate (:1056-1073) -> animationHelpers.animationUpdate (esm/Charting/Visuals/RenderableSeries/Animations/animationHelpers.js:37-46) -> beforeAnimationStart (:1307-1315) -> createPointMarker -> pointMarker setter (:337-346), which only clears invalidateParentCallback on the old marker. Rate: once per style animation start, repeated with every hover, selection or toggle animation the app runs.

## Why it costs

BasePointMarker owns native textures that only delete() frees (BasePointMarker.js:213-215, :231). When the marker is replaced without delete(), the JS wrapper is garbage-collected but the wasm allocations, which never return to the OS, and the GPU textures stay.

**Scale where it matters:** Each orphaned marker keeps three CanvasTexture objects (sprite, stroke mask, fill mask; esm/Charting/Visuals/PointMarkers/BasePointMarker.js:253-267), each a wasm texture plus intermediate vectors of width x height and a canvas. Growth is one marker per animation run, without bound over a session.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/BaseRenderableSeries.js
+++ b/esm/Charting/Visuals/RenderableSeries/BaseRenderableSeries.js
@@ beforeAnimationStart() {
         if (animationPointMarkerStyle) {
+            const previous = this.pointMarker;
             this.pointMarker = animationHelpers.createPointMarker(this.webAssemblyContext, animationPointMarkerStyle);
+            // free the marker an earlier style animation created; a marker the app passed in stays app-owned
+            if (previous && previous === this.animationOwnedPointMarker) {
+                previous.delete();
+            }
+            this.animationOwnedPointMarker = this.pointMarker;
         }
     }
@@ delete() {
+        this.animationOwnedPointMarker = undefined;
         this.drawingProviders.forEach(dp => dp.delete());

(Alternative: when the existing marker has the same type, keep it and let SeriesAnimation.updateSeriesProperties interpolate width/height/fill/stroke on it, which it already does.)
```

**Trade-off:** The first replacement still leaves the marker the app supplied to the app, because deleting it could break an app that keeps a reference; growth stops after the first animation. The delete runs at animation start, before this frame's draw, so no queued draw uses the freed textures.

## App-side workaround

Keep a reference to series.pointMarker before each style animation and delete() it in the animation's onCompleted callback when it is no longer series.pointMarker. Or animate the size and colours of the existing marker with your own GenericAnimation instead of a pointMarker style.

## Verify

measure.md#mem: run a style animation with a pointMarker style 10 times (for example hover in and out), with the wasm heap size as an app counter and MemoryUsageHelper.objectRegistry in development (SC-32). Pass: after warm-up, wasm heap growth per repetition is within noise and the count of live point markers and CanvasTextures stays flat. Not measured.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/BaseRenderableSeries.js:337` — pointMarker setter does not delete the replaced marker

## Review notes

- Found by reviewer slice `s03-renderable-series`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

