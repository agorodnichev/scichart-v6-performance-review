# 057 · Every point-marker property set, and every resumeUpdates, rebuilds three canvas textures (sprite, stroke mask, fill mask) at once, though the masks are used only with a point-marker palette provider

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/PointMarkers/BasePointMarker.js:347` |
| Severity | **medium** |
| Pipeline stage | GPU upload (`gpu-upload`) |
| Metric | frame time during style animations (also INP on style changes, memory) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/b07d2c31b62f3ceae1fad73bec4c6f49/): reproduced on WebGL and WebGPU ([source](../demos/057-point-marker-three-textures-eager/)) |
| Rule | SC-46, GPU-24 (web-performance skill) |
| Effort to fix | medium |

## Demo findings

Also seen: a point marker passed in the series constructor options never gets a redraw callback, so changing its properties later requests no redraw. See the [demo](https://jsfiddle.net/gh/gist/library/pure/b07d2c31b62f3ceae1fad73bec4c6f49/).

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

A setter (for example width, :100-104) -> notifyPropertyChanged (:342) -> recreateSpriteTextures (:350-362) -> createCanvasTexture (:253-276) -> 3 x new CanvasTexture (CanvasTexture.js:40-64: a new <canvas>, two w x h UIntVectors, a TSRTexture) -> drawSprite + copyTexture (CanvasTexture.js:99-129: getImageData readback, two embind .set calls per non-transparent pixel, full upload). Callers: (1) SeriesAnimation, once per animation frame: SciChartRenderer.js:55/:116 -> SciChartSurface.onAnimate (:952-953) -> BaseRenderableSeries.onAnimate (:1056-1072) -> SeriesAnimation.updateSeriesProperties (:128), which suspends at :150, runs 5 setters, and resumes at :166; resumeUpdates rebuilds unconditionally (:328-331). (2) The SpritePointMarker constructor: the image setter (SpritePointMarker.js:47 -> :65-73) sets width (:69), height (:70) and image (:72), so up to 3 rebuilds create 9 CanvasTextures before the first draw. (3) FastImpulseRenderableSeries.js:75-97: 2 point-marker setters per fill or size change. lastPointOnly (:157-161) and antiAlias (:171-175) also trigger a rebuild, though they do not change pixels. Only PointMarkerDrawingProvider.js:43-45 reads the masks, and only when hasPointMarkerPaletteProvider() is true.

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
+        // lastPointOnly / antiAlias change only draw args (PointMarkerDrawingProvider.js:74, :81), not pixels
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
         const widthPadded = DpiHelper.PIXEL_RATIO * (this.width + this.strokeThickness) + 1;
         const heightPadded = DpiHelper.PIXEL_RATIO * (this.height + this.strokeThickness) + 1;
         const spriteTexture = new CanvasTexture(this.webAssemblyContext, widthPadded, heightPadded);
         spriteTexture.clear();
         this.drawSprite(spriteTexture.getContext(), this.width * DpiHelper.PIXEL_RATIO, this.height * DpiHelper.PIXEL_RATIO, this.stroke, this.strokeThickness * DpiHelper.PIXEL_RATIO, this.fill);
         spriteTexture.copyTexture();
-        const strokeMask = new CanvasTexture(...); ... strokeMask.copyTexture();   // lines 263-266
-        const fillMask = new CanvasTexture(...); ... fillMask.copyTexture();       // lines 267-274
-        return { spriteTexture, strokeMask, fillMask };
+        // the masks are read only with a point-marker palette provider (PointMarkerDrawingProvider.js:43-45): build them on first use
+        return { spriteTexture, strokeMask: undefined, fillMask: undefined };
+    }
+    /** Same canvas size and drawSprite arguments as the masks built in createCanvasTexture today */
+    createMaskTexture(stroke, fill) {
+        const widthPadded = DpiHelper.PIXEL_RATIO * (this.width + this.strokeThickness) + 1;
+        const heightPadded = DpiHelper.PIXEL_RATIO * (this.height + this.strokeThickness) + 1;
+        const mask = new CanvasTexture(this.webAssemblyContext, widthPadded, heightPadded);
+        mask.clear();
+        this.drawSprite(mask.getContext(), this.width * DpiHelper.PIXEL_RATIO, this.height * DpiHelper.PIXEL_RATIO, stroke, this.strokeThickness * DpiHelper.PIXEL_RATIO, fill);
+        mask.copyTexture();
+        mask.applyOpacity(this.opacityProperty);
+        return mask;
     }
@@ getStrokeMask() {
-        if (this.spriteTextures === undefined) {
-            this.spriteTextures = this.createCanvasTexture();
-            this.applyOpacity(this.opacityProperty);
-        }
+        this.getSprite(); // creates spriteTextures (and applies opacity) if it was invalidated
+        if (!this.spriteTextures.strokeMask && !IS_TEST_ENV) {
+            this.spriteTextures.strokeMask = this.createMaskTexture("#ffffffff", "#00000000");
+        }
         return this.spriteTextures.strokeMask;
     }
@@ getFillMask() {
-        if (this.spriteTextures === undefined) {
-            this.spriteTextures = this.createCanvasTexture();
-            this.applyOpacity(this.opacityProperty);
-        }
+        this.getSprite();
+        if (!this.spriteTextures.fillMask && !IS_TEST_ENV) {
+            this.spriteTextures.fillMask = this.createMaskTexture("#00000000", "#ffffffff");
+        }
         return this.spriteTextures.fillMask;
     }
// recreateSpriteTextures() then has no callers and can be removed; invalidateCache() and applyOpacity() already skip undefined masks.
```

**Trade-off:** Textures are created on the first draw after a change, so that first-frame cost moves from the setter into the draw. Code that reads spriteTextures right after a setter must call getSprite() first. Visible difference: recreateSpriteTextures today does not re-apply opacity, so after a style change a marker with opacity < 1 draws at full opacity until opacity is set again. The lazy path applies opacity on rebuild (as getSprite already does on a cold cache), which fixes that, but it changes what users see in that case.

## App-side workaround

SC-46: set point-marker styles once, through constructor options rather than setters. Wrap multiple setters in suspendUpdates()/resumeUpdates(). Animate opacity, not size or colour. Set lastPointOnly in the constructor options.

## Verify

measure.md#fps on a scatter series whose SeriesAnimation animates the point-marker style, plus a separate run that sets fill, stroke and width in one task, with a dev counter on `new CanvasTexture`. Pass: the counter reads 1 per frame (was 3) without a point-marker palette provider and 1 per task for multiple setters, and compare-runs reports 'win' on frameP95Ms during the animation. Then measure.md#mem: canvases and the wasm heap stay flat after repeated style changes.

## Other locations

- `esm/Charting/Visuals/PointMarkers/SpritePointMarker.js:65` — the image setter triggers width, height and image rebuilds: up to 9 CanvasTextures during construction
- `esm/Charting/Visuals/PointMarkers/BasePointMarker.js:328` — resumeUpdates always rebuilds
- `esm/Charting/Visuals/RenderableSeries/Animations/SeriesAnimation.js:150` — suspend, 5 setters, resume (:166): one rebuild of 3 textures per animation frame
- `esm/Charting/Visuals/TextureManager/CanvasTexture.js:122` — two embind .set calls per pixel in copyTexture (this file belongs to slice s06)

## Review notes

- Found by reviewer slice `s04-drawing-providers`.
- Adversarial verification (corrected): Re-read PointMarkers/BasePointMarker.js:1-371, SpritePointMarker.js:41-85, TextureManager/CanvasTexture.js:40-134, Animations/SeriesAnimation.js:128-170, FastImpulseRenderableSeries.js:75-97 and DrawingProviders/PointMarkerDrawingProvider.js:35-50. The code_quote matches :342-349 verbatim. Chain: setter (width :100-104, fill :66-70, stroke :86-90, strokeThickness :128-132, lastPointOnly :157-161, antiAlias :171-175) -> notifyPropertyChanged (:342) -> recreateSpriteTextures (:350-362) -> createCanvasTexture (:253-276) -> 3 x new CanvasTexture (CanvasTexture.js:40-64: a canvas element, two UIntVectors resized to w*h, a TSRTexture) and 3 x copyTexture (:99-129: getImageData, 2 embind .set calls per non-transparent pixel at :122-123, SCRTFillTextureAbgr upload). resumeUpdates (:328-331) rebuilds unconditionally. Per-frame caller: SciChartRenderer.js:55/:116 -> SciChartSurface.onAnimate (:952-953) -> BaseRenderableSeries.onAnimate (:1056-1072) -> animationUpdate -> SeriesAnimation.updateSeriesProperties (:128), which suspends at :150, runs 5 setters (:153-164) and resumes at :166, so 1 rebuild (3 textures) per animation frame. SpritePointMarker constructor: the image setter (:65-73) sets width (:69) and height (:70) and then notifies IMAGE (:72), so up to 3 rebuilds (9 CanvasTextures) when the image size differs from the current width/height. FastImpulseRenderableSeries fill (:75-85) and size (:91-97) each run 2 point-marker setters, so 2 rebuilds. The masks are read only at PointMarkerDrawingProvider.js:43-45 when hasPointMarkerPaletteProvider() is true; rg finds no other reader (Bubble uses getSprite only, :35). lastPointOnly and antiAlias are read only as draw args (PointMarkerDrawingProvider.js:74/:81/:103) and no drawSprite override uses them, so rebuilding for them is pure waste. Fix check: the fix diff referenced a createMaskTexture helper without defining it; it now gives the full helper, using the same canvas size and drawSprite arguments as :263-274. deleteSafe (Core/Deleter.js:5-8) and applyOpacity (:366-368) already tolerate undefined masks. New trade_off item: recreateSpriteTextures never re-applies opacity (only getSprite/getStrokeMask/getFillMask do, on a cold cache, :181-184), so today a style change on a marker with opacity < 1 leaves the textures at full opacity until opacity is set again. The lazy rebuild applies opacity, so the visible result changes in that case, which corrects that existing behaviour. Also corrected other_locations SpritePointMarker line 67 -> 65 (the start of the setter). Severity medium kept (SC-46 impact medium; per frame only while a point-marker style animation runs, otherwise per discrete style change). Evidence S.

