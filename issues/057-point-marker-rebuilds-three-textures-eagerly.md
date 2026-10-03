# 057 · Every point-marker property set, and every resumeUpdates, rebuilds three canvas textures (sprite, stroke mask, fill mask) at once, though the masks are used only with a point-marker palette provider

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/PointMarkers/BasePointMarker.js:347` |
| Severity | **medium** |
| Pipeline stage | GPU upload (`gpu-upload`) |
| Metric | frame time during style animations (also INP on style changes, memory) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | SC-46, GPU-24 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
    notifyPropertyChanged(propertyName, newValue, oldValue) {
        if (newValue === oldValue || propertyName === PROPERTY.OPACITY) {
            return;
        }
        if (!this.isUpdateSuspended) {
            this.recreateSpriteTextures();
        }
    }
```

## Call path and frequency

A setter (for example width, :100-104) -> notifyPropertyChanged (:342) -> recreateSpriteTextures (:350-362) -> createCanvasTexture (:253-276) -> 3 x new CanvasTexture (CanvasTexture.js:40-64: a new <canvas>, two w x h UIntVectors, a TSRTexture) -> drawSprite + copyTexture (CanvasTexture.js:99-129: getImageData readback, two embind .set calls per non-transparent pixel, full upload). Callers: (1) SeriesAnimation, once per animation frame: Animations/SeriesAnimation.js:150-166 suspends, runs 5 setters, then resumeUpdates rebuilds (:328-331). (2) The SpritePointMarker constructor: the image setter (SpritePointMarker.js:47) sets width (:69), height (:70) and image (:72), so 3 rebuilds create 9 CanvasTextures before the first draw. (3) FastImpulseRenderableSeries.js:79-96: 2 setters per series property change. lastPointOnly (:157-160) and antiAlias (:171-174) also trigger a rebuild, though they do not change pixels. Only PointMarkerDrawingProvider.js:43-45 reads the masks, and only when hasPointMarkerPaletteProvider() is true.

## Why it costs

The rebuild happens in the setter instead of at the next draw, so N property changes cost N rebuilds. Two of the three textures are needed only with a point-marker palette provider. An opacity change also re-uploads all three textures (applyOpacity, :363-370).

**Scale where it matters:** Each rebuild costs 3 canvases, 3 readbacks and 3 uploads of (DPR x (size + strokeThickness) + 1)^2 pixels. That happens once per frame during a point-marker style animation, and N times when N setters run outside suspendUpdates.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/PointMarkers/BasePointMarker.js
+++ b/esm/Charting/Visuals/PointMarkers/BasePointMarker.js
@@ notifyPropertyChanged(propertyName, newValue, oldValue) {
         if (newValue === oldValue || propertyName === PROPERTY.OPACITY) {
             return;
         }
-        if (!this.isUpdateSuspended) {
-            this.recreateSpriteTextures();
-        }
+        // lastPointOnly / antiAlias change draw args only, not pixels
+        if (propertyName !== PROPERTY.LAST_POINT_ONLY && propertyName !== PROPERTY.ANTIALIAS) {
+            this.invalidateCache(); // rebuilt by getSprite()/getFillMask()/getStrokeMask() at the next draw
+        }
+        if (!this.isUpdateSuspended && this.invalidateParentCallback) {
+            this.invalidateParentCallback();
+        }
     }
@@ resumeUpdates() {
         this.isUpdateSuspended = false;
-        this.recreateSpriteTextures();
+        if (this.invalidateParentCallback) {
+            this.invalidateParentCallback();
+        }
     }
@@ createCanvasTexture() {
-        const strokeMask = new CanvasTexture(...); ... strokeMask.copyTexture();
-        const fillMask = new CanvasTexture(...); ... fillMask.copyTexture();
-        return { spriteTexture, strokeMask, fillMask };
+        // masks are built on first getStrokeMask()/getFillMask()
+        return { spriteTexture, strokeMask: undefined, fillMask: undefined };
@@ getStrokeMask() {
-        if (this.spriteTextures === undefined) {
-            this.spriteTextures = this.createCanvasTexture();
-            this.applyOpacity(this.opacityProperty);
-        }
+        this.getSprite();
+        if (!this.spriteTextures.strokeMask && !IS_TEST_ENV) {
+            // same drawSprite arguments as today (lines 263-266), moved into a helper
+            this.spriteTextures.strokeMask = this.createMaskTexture("#ffffffff", "#00000000");
+            this.spriteTextures.strokeMask.applyOpacity(this.opacityProperty);
+        }
         return this.spriteTextures.strokeMask;
// getFillMask(): the same, with createMaskTexture("#00000000", "#ffffffff") (lines 267-274)
```

**Trade-off:** Textures are created on the first draw after a change, so that first-frame cost moves from the setter into the draw. Code that reads spriteTextures right after a setter must call getSprite() first.

## App-side workaround

SC-46: set point-marker styles once, through constructor options rather than setters. Wrap multiple setters in suspendUpdates()/resumeUpdates(). Animate opacity, not size or colour. Set lastPointOnly in the constructor options.

## Verify

measure.md#fps on a scatter series whose SeriesAnimation animates the point-marker style, plus a separate run that sets fill, stroke and width in one task, with a dev counter on `new CanvasTexture`. Pass: the counter reads 1 per frame (was 3) without a point-marker palette provider and 1 per task for multiple setters, and compare-runs reports 'win' on frameP95Ms during the animation. Then measure.md#mem: canvases and the wasm heap stay flat after repeated style changes.

## Other locations

- `esm/Charting/Visuals/PointMarkers/SpritePointMarker.js:67` — the image setter triggers width, height and image rebuilds: 9 CanvasTextures during construction
- `esm/Charting/Visuals/PointMarkers/BasePointMarker.js:328` — resumeUpdates always rebuilds
- `esm/Charting/Visuals/TextureManager/CanvasTexture.js:122` — two embind .set calls per pixel in copyTexture (this file belongs to slice s06)

## Review notes

- Found by reviewer slice `s04-drawing-providers`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

