# 033 · Style animations with a pointMarker style replace series.pointMarker without deleting the old one, leaking 3 sprite textures per run

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/BaseRenderableSeries.js:1313` |
| Severity | **high** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory (wasm heap, GPU textures) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/a26100968d9eac6cb77506b82d30534e/): reproduced on WebGL and WebGPU ([source](../demos/033-style-animation-pointmarker-leak/)) |
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

BasePointMarker owns native textures that only delete() frees (invalidateCache, BasePointMarker.js:211-218, called from delete() at :231). The JS wrapper is not collected either: the constructor adds every marker to the global WebGlRenderContext2D.webGlResourcesRefs Set (BasePointMarker.js:49; Set at esm/Charting/Drawing/WebGlRenderContext2D.js:622), and only delete() removes it (:233). So each replaced marker, its canvases, its wasm vectors (wasm memory never returns to the OS) and its GPU textures stay reachable for the life of the page. The context-lost handler (esm/Charting/Visuals/createMaster.js:249-251) only invalidates the caches of these markers and never removes them from the Set.

**Scale where it matters:** Each orphaned marker keeps three CanvasTexture objects (sprite, stroke mask, fill mask; created lazily in createCanvasTexture, esm/Charting/Visuals/PointMarkers/BasePointMarker.js:253-270, and already built because the old marker was drawn). Each CanvasTexture owns a canvas element (esm/Charting/Visuals/TextureManager/CanvasTexture.js:47), two wasm UIntVectors of width x height (:55, :58) and a TextureCache with its GPU texture (:62). Growth is one marker per style animation run that carries styles.pointMarker, for example two per hover if hover-in and hover-out each animate the marker, without bound over a session.

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
- Adversarial verification (corrected): Re-read BaseRenderableSeries.js:1307-1315 (quote verbatim; assignment at :1313) and the pointMarker setter :337-346, which only clears invalidateParentCallback on the old marker. Call chain confirmed: runAnimation/enqueueAnimation (:1022-1032) push to animationQueue -> SciChartRenderer.js:55/:116 -> SciChartSurface.onAnimate (:952-953) -> BaseRenderableSeries.onAnimate (:1056-1073) -> animationHelpers.animationUpdate (Animations/animationHelpers.js:37-46) calls beforeAnimationStart once per animation (InitialState_Running, or Delayed_Running for non-start animations) -> createPointMarker (:63-86) builds a new marker from styles.pointMarker. Nothing frees the replaced marker: series delete() (:671-681) deletes only the current pointMarker, BaseStackedRenderableSeries.beforeAnimationStart (:214-221) just delegates, and the only global sweep, the WebGL context-lost handler (createMaster.js:249-251), calls invalidateCache, not delete. Corrected why_it_costs: the JS wrapper is NOT garbage-collected, because the BasePointMarker constructor adds every marker to the global WebGlRenderContext2D.webGlResourcesRefs Set (BasePointMarker.js:49, Set created at WebGlRenderContext2D.js:622) and only delete() removes it (:233), so the orphan, its 3 CanvasTextures and their canvases stay reachable for the life of the page. Corrected scale with CanvasTexture contents (CanvasTexture.js:47 canvas element, :55/:58 two UIntVectors, :62 TextureCache). Severity raised to high: review.md section B rates a leak that grows with each repeated action as high, SC-29 impact is high, and a hover in/out style animation leaks one marker per run. Fix diff checked: deletes only markers the animation created, runs inside onAnimate before the frame draw, no double delete with series delete(); kept.

