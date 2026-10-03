# 059 · Point-marker style animations create 3 canvases, 3 GPU textures and run getImageData on every animation frame

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/Animations/SeriesAnimation.js:149` |
| Severity | **medium** |
| Pipeline stage | GPU upload (`gpu-upload`) |
| Metric | frame time during style animations (also GPU and wasm allocation churn) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | GPU-05, SC-46 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
            if (this.styles.pointMarker !== undefined) {
                rs.pointMarker.suspendUpdates();
                const initialWidth = (_b = (_a = initialStyles.pointMarker) === null || _a === void 0 ? void 0 : _a.width) !== null && _b !== void 0 ? _b : 0;
                const initialHeight = (_d = (_c = initialStyles.pointMarker) === null || _c === void 0 ? void 0 : _c.height) !== null && _d !== void 0 ? _d : 0;
                rs.pointMarker.width = animationHelpers.interpolateNumber(initialWidth, this.styles.pointMarker.width, animationProgress);
                rs.pointMarker.height = animationHelpers.interpolateNumber(initialHeight, this.styles.pointMarker.height, animationProgress);
```

## Call path and frequency

Charting/Services/SciChartRenderer.js:55/116 sciChartSurface.onAnimate -> Charting/Visuals/SciChartSurface.js:953 rs.onAnimate -> Charting/Visuals/RenderableSeries/BaseRenderableSeries.js:1072 animationHelpers.animationUpdate -> Animations/animationHelpers.js:48 updateAnimationProperties -> BaseRenderableSeries.js:1335 animation.updateSeriesProperties -> Animations/SeriesAnimation.js:149-166 -> PointMarkers/BasePointMarker.js:328 resumeUpdates (rebuilds unconditionally) -> :350 recreateSpriteTextures -> :253 createCanvasTexture -> 3 x TextureManager/CanvasTexture.js:40 (document.createElement('canvas') :47, 2 UIntVectors :55-59, texture :63) + drawSprite + copyTexture (:106 getImageData, per-pixel embind set()). Frequency: every animation frame, per animated series, for the animation duration (default 3000 ms).

## Why it costs

Any style animation with styles.pointMarker interpolates the marker's width, height, strokeThickness, fill and stroke every frame. BasePointMarker.resumeUpdates rebuilds the sprite even when nothing changed, and every rebuild deletes the 3 CanvasTextures and builds new ones: a new canvas, context, wasm vectors and GPU texture each time, a raster pass, a getImageData copy, a pixel-by-pixel swizzle through embind, and a texture upload. That is GPU object creation and upload inside the frame (GPU-05), repeated for the whole animation and for every animated series. Most consecutive frames even produce the same device-pixel size, because CanvasTexture floors the sprite size.

**Scale where it matters:** Per series per frame: 3 canvas elements and 2D contexts, 3 getImageData copies, 6 wasm UIntVector allocations, 3 texture creations, and 2 embind set() calls per opaque pixel (a 10 px marker at DPR 2 is a 21x21 texture). 10 series x 180 frames (3 s at 60 Hz) = 5,400 canvases and 5,400 textures created and deleted.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/PointMarkers/BasePointMarker.js
+++ b/esm/Charting/Visuals/PointMarkers/BasePointMarker.js
@@ resumeUpdates() {
     this.isUpdateSuspended = false;
-    this.recreateSpriteTextures();
+    // Rebuild only if a texture-affecting property changed while suspended
+    if (this.changedWhileSuspended) {
+        this.changedWhileSuspended = false;
+        this.recreateSpriteTextures();
+    }
@@ notifyPropertyChanged(propertyName, newValue, oldValue) {
     if (newValue === oldValue || propertyName === PROPERTY.OPACITY) {
         return;
     }
-    if (!this.isUpdateSuspended) {
-        this.recreateSpriteTextures();
-    }
+    if (this.isUpdateSuspended) {
+        this.changedWhileSuspended = true;
+    } else {
+        this.recreateSpriteTextures();
+    }
@@ recreateSpriteTextures() {
+    const w = Math.floor(DpiHelper.PIXEL_RATIO * (this.width + this.strokeThickness) + 1);
+    const h = Math.floor(DpiHelper.PIXEL_RATIO * (this.height + this.strokeThickness) + 1);
+    const t = this.spriteTextures;
+    if (t && t.spriteTexture && t.spriteTexture.width === w && t.spriteTexture.height === h) {
+        // Same size: clear() + drawSprite() + copyTexture() into the existing 3 CanvasTextures,
+        // exactly as createCanvasTexture draws them; no new canvas, vectors or GPU textures
+        this.redrawCanvasTextures(t);
+    } else {
         ...existing delete of the 3 textures + this.spriteTextures = this.createCanvasTexture();
+    }
--- a/esm/Charting/Visuals/RenderableSeries/Animations/SeriesAnimation.js
+++ b/esm/Charting/Visuals/RenderableSeries/Animations/SeriesAnimation.js
@@ updateSeriesProperties
-                rs.pointMarker.width = animationHelpers.interpolateNumber(initialWidth, this.styles.pointMarker.width, animationProgress);
-                rs.pointMarker.height = animationHelpers.interpolateNumber(initialHeight, this.styles.pointMarker.height, animationProgress);
+                // The sprite is rasterized in whole device pixels: snap intermediate sizes so that frames
+                // drawing the same sprite set the same value (no rebuild); the end frames stay exact
+                const snap = (v) => animationProgress <= 0 || animationProgress >= 1
+                    ? v
+                    : Math.round(v * DpiHelper.PIXEL_RATIO) / DpiHelper.PIXEL_RATIO;
+                rs.pointMarker.width = snap(animationHelpers.interpolateNumber(initialWidth, this.styles.pointMarker.width, animationProgress));
+                rs.pointMarker.height = snap(animationHelpers.interpolateNumber(initialHeight, this.styles.pointMarker.height, animationProgress));
```

**Trade-off:** Intermediate marker sizes step in whole device pixels instead of sub-pixel anti-aliased sizes. Start and end frames are exact. A colour transition still re-rasterizes and re-uploads each frame while the colour changes; the fix only removes the object churn (canvas, vectors, texture creation) for those frames. The redraw path keeps 3 canvases per marker alive between frames, as the current code already does between rebuilds. SeriesAnimation is the only caller of point-marker suspendUpdates/resumeUpdates in the package, so the dirty flag changes no other behaviour.

## App-side workaround

Avoid styles.pointMarker in style animations on many series or long durations. Animate opacity instead (pointMarker opacity changes skip the rebuild: BasePointMarker.notifyPropertyChanged returns early for OPACITY), or shorten the duration.

## Verify

measure.md#fps from runAnimation() to completion: 10 XyScatter series with a ScatterAnimation whose styles.pointMarker grows from 4 to 16 px over 3 s, 5 runs per side, plus a dev counter of CanvasTexture constructions. Pass: CanvasTexture constructions during the animation drop from 3 x series x frames to at most 3 x series x distinct device-pixel sizes; compare-runs 'win' on longFramesPer10s or frameP99Ms; the final frame is identical.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/Animations/SeriesAnimation.js:166` — resumeUpdates every frame
- `esm/Charting/Visuals/PointMarkers/BasePointMarker.js:328` — resumeUpdates always calls recreateSpriteTextures
- `esm/Charting/Visuals/PointMarkers/BasePointMarker.js:350` — recreateSpriteTextures deletes and recreates all 3 CanvasTextures
- `esm/Charting/Visuals/TextureManager/CanvasTexture.js:47` — document.createElement('canvas') per texture; 2 UIntVectors at :55-59; texture at :63
- `esm/Charting/Visuals/TextureManager/CanvasTexture.js:106` — getImageData plus a per-pixel embind set() swizzle on every rebuild

## Review notes

- Found by reviewer slice `s05-labels-hittest-anim`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

