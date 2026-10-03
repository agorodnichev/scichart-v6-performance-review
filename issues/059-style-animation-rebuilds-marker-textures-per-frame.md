# 059 · Point-marker style animations create 3 canvases, 3 GPU textures and run getImageData on every animation frame

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/Animations/SeriesAnimation.js:149` |
| Severity | **medium** |
| Pipeline stage | GPU upload (`gpu-upload`) |
| Metric | frame time during style animations (also GPU and wasm allocation churn) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/88741873b41ba402ce827cd778624ccd/): reproduced on WebGL and WebGPU ([source](../demos/059-style-animation-marker-texture-rebuild/)) |
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
@@ createCanvasTexture() (:253-276): construct the 3 CanvasTextures as today, then paint them through one helper
         const spriteTexture = new CanvasTexture(this.webAssemblyContext, widthPadded, heightPadded);
-        spriteTexture.clear();
-        this.drawSprite(spriteTexture.getContext(), ...);
-        spriteTexture.copyTexture();
         const strokeMask = new CanvasTexture(this.webAssemblyContext, widthPadded, heightPadded);
-        ... (clear, drawSprite, copyTexture for strokeMask and fillMask)
         const fillMask = new CanvasTexture(this.webAssemblyContext, widthPadded, heightPadded);
-        return { spriteTexture, strokeMask, fillMask };
+        const textures = { spriteTexture, strokeMask, fillMask };
+        this.paintCanvasTextures(textures);
+        return textures;
+    }
+    /** Clears and redraws the 3 sprites into existing CanvasTextures (same drawSprite calls as before) */
+    paintCanvasTextures(t) {
+        const r = DpiHelper.PIXEL_RATIO;
+        const w = this.width * r, h = this.height * r, st = this.strokeThickness * r;
+        t.spriteTexture.clear();
+        this.drawSprite(t.spriteTexture.getContext(), w, h, this.stroke, st, this.fill);
+        t.spriteTexture.copyTexture();
+        t.strokeMask.clear();
+        this.drawSprite(t.strokeMask.getContext(), w, h, "#ffffffff", st, "#00000000");
+        t.strokeMask.copyTexture();
+        t.fillMask.clear();
+        this.drawSprite(t.fillMask.getContext(), w, h, "#00000000", st, "#ffffffff");
+        t.fillMask.copyTexture();
     }
@@ resumeUpdates() (:328)
     this.isUpdateSuspended = false;
-    this.recreateSpriteTextures();
+    // Rebuild only if a texture-affecting property changed while suspended
+    if (this.changedWhileSuspended) {
+        this.changedWhileSuspended = false;
+        this.recreateSpriteTextures();
+    }
@@ notifyPropertyChanged(propertyName, newValue, oldValue) (:342)
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
@@ recreateSpriteTextures() (:350)
+    const r = DpiHelper.PIXEL_RATIO;
+    const w = Math.floor(r * (this.width + this.strokeThickness) + 1); // same size CanvasTexture would get
+    const h = Math.floor(r * (this.height + this.strokeThickness) + 1);
+    const t = this.spriteTextures;
+    if (t && t.spriteTexture && t.spriteTexture.width === w && t.spriteTexture.height === h &&
+        this.createCanvasTexture === BasePointMarker.prototype.createCanvasTexture) {
+        // Same size and the stock texture layout: repaint and re-upload into the existing
+        // canvases, UIntVectors and GPU textures instead of creating new ones
+        this.paintCanvasTextures(t);
+    } else {
         if (this.spriteTextures) {
             ...existing delete of the 3 textures...
         }
         this.spriteTextures = this.createCanvasTexture();
+    }
     if (this.invalidateParentCallback) {
         this.invalidateParentCallback();
     }
--- a/esm/Charting/Visuals/RenderableSeries/Animations/SeriesAnimation.js
+++ b/esm/Charting/Visuals/RenderableSeries/Animations/SeriesAnimation.js
+import { DpiHelper } from "../../TextureManager/DpiHelper";
@@ updateSeriesProperties (:152-153)
-                rs.pointMarker.width = animationHelpers.interpolateNumber(initialWidth, this.styles.pointMarker.width, animationProgress);
-                rs.pointMarker.height = animationHelpers.interpolateNumber(initialHeight, this.styles.pointMarker.height, animationProgress);
+                // The sprite is rasterized in whole device pixels: snap intermediate sizes so that frames
+                // that would draw the same sprite set the same value (no rebuild); the end frames stay exact
+                const snap = (v) => animationProgress <= 0 || animationProgress >= 1
+                    ? v
+                    : Math.round(v * DpiHelper.PIXEL_RATIO) / DpiHelper.PIXEL_RATIO;
+                rs.pointMarker.width = snap(animationHelpers.interpolateNumber(initialWidth, this.styles.pointMarker.width, animationProgress));
+                rs.pointMarker.height = snap(animationHelpers.interpolateNumber(initialHeight, this.styles.pointMarker.height, animationProgress));
```

**Trade-off:** Intermediate marker sizes step in whole device pixels instead of sub-pixel anti-aliased sizes; start and end frames are exact. A colour or stroke-thickness transition still repaints and re-uploads the 3 textures on each frame where the value changes; the fix only removes the object churn (canvas, context, UIntVectors, GPU textures) on those frames, and frames whose snapped size changes still create new textures. The same-size path keeps 3 canvases per marker alive between frames, as the current code already does between rebuilds. resumeUpdates is public API (IPointMarker: 'Resumes recreation of the PointMarker'): with the dirty flag it no longer rebuilds when no notified property changed while suspended, so app code that mutates unnotified state and calls resumeUpdates to force a rebuild must call invalidateCache() instead. A subclass that overrides createCanvasTexture keeps today's delete-and-create path.

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
- Adversarial verification (corrected): Re-read SeriesAnimation.js:128-176 (code_quote matches :149-154 verbatim apart from the file's CRLF line endings; resumeUpdates at :166), BasePointMarker.js:60-175 (setters), :176-232 (lazy getters, invalidateCache), :253-276 createCanvasTexture, :328-370 resumeUpdates/notifyPropertyChanged/recreateSpriteTextures/applyOpacity, CanvasTexture.js:40-134, TextureCache.js:17-34 and animationHelpers.js:36-58 and :93-112. Call chain confirmed: SciChartRenderer.js:55/116 sciChartSurface.onAnimate -> SciChartSurface.js:952-953 rs.onAnimate for every series -> BaseRenderableSeries.js:1072 animationHelpers.animationUpdate -> animationHelpers.js:48 updateAnimationProperties while Running (and once on Completed) -> BaseRenderableSeries.js:1335 animation.updateSeriesProperties -> SeriesAnimation.js:149-166. Each frame sets width, height, strokeThickness, fill and stroke inside suspendUpdates; resumeUpdates (:328-330) calls recreateSpriteTextures unconditionally, which deletes the 3 CanvasTextures (:352-356) and createCanvasTexture builds 3 new ones: document.createElement('canvas') (CanvasTexture.js:47), 2 UIntVector allocations + resize (:55-59), a native texture via TextureCache.create (:62-63), a clear, a drawSprite raster, getImageData (:106) and 2 embind set() calls per non-transparent pixel (:122-123), then SCRTFillTextureAbgr (:128). No guard: no size check, no dirty flag; SeriesAnimation.js:150/166 is the only caller of point-marker suspend/resume in esm. Default duration is 3000 ms (SeriesAnimation.js:25). interpolateNumber(a, a, p) returns a exactly, so properties that do not animate do not notify. Mechanism certain per animation frame -> S. Kept medium: per frame, but only while a style animation with styles.pointMarker runs, and the cost scales with series count and marker pixels, not with data size. Corrections to the fix: (1) the same-size branch called an undefined redrawCanvasTextures; replaced it with an explicit paintCanvasTextures helper that createCanvasTexture also uses, so both paths draw identically; (2) the same-size branch now also requires that createCanvasTexture is not overridden, so a subclass with its own texture layout keeps the delete-and-create path; (3) SeriesAnimation.js does not import DpiHelper, so the snap needs the import; (4) trade_off: resumeUpdates is public API (IPointMarker.d.ts:93-96, 'Resumes recreation of the PointMarker'), so the dirty flag changes behaviour for app code that relies on it to force a rebuild after mutating unnotified state.

