# 022 · Axis-marker, line-annotation and modifier axis labels are re-rasterized on a Canvas 2D, read back, uploaded and deleted on every render, even when the text is unchanged

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Axis/AxisRenderer.js:539` |
| Severity | **high** |
| Pipeline stage | GPU upload (`gpu-upload`) |
| Metric | frame time (also memory churn: ImageData and wasm heap allocations per frame) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/07293834b91a3a1a9aed495bbb318790/): reproduced on WebGL and WebGPU ([source](../demos/022-axis-marker-modifier-label-texture-per-frame/)) |
| Rule | GPU-24, GPU-05, SC-21 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
    createAxisMarker(axisAlignment, text, textStyle, backgroundColor, opacity) {
        const { fontStyle, fontWeight, fontSize, fontFamily, color } = textStyle;
        return this.textureManager.createAxisMarkerTexture(axisAlignment, text, fontStyle, fontWeight, fontSize, fontFamily, color, 2 * DpiHelper.PIXEL_RATIO, backgroundColor, opacity);
    }
```

## Call path and frequency

Runs per render (every frame while streaming, panning or animating), per labelled annotation: esm/Charting/Services/SciChartRenderer.js:429 annotation.drawWithContext → esm/Charting/Visuals/Annotations/AxisMarkerAnnotation.js:262 drawAxisMarkerAnnotation → esm/Charting/Visuals/Helpers/drawLabel.js:52 AxisRenderer.createAxisMarker (AxisRenderer.js:541) → TextureManager.createAxisMarkerTexture (TextureManager.js:186-224: full-canvas clearRect, measureText, Path2D fill, fillText, getImageData, then SCRTCreateBitmapTexture with _malloc, HEAP8.set and a ccall upload) → drawTexture → drawLabel.js:58 bitmapTexture.delete(). The same pattern: HorizontalLineAnnotation.js:114 → drawLabel.js:34 createAnnotationLabelTexture (AxisRenderer.js:553) → drawLabel.js:42 delete. LineAnnotation.js:303, which CursorModifier uses with isSvgOnly:false → drawLabel.js:10 → AxisRenderer.drawModifiersAxisLabel (AxisRenderer.js:473/480/533) → NativeAxisRenderer.js:78 createFilledRectTexture → :80 delete.

## Why it costs

The label text and style rarely change between frames, but every render repeats the whole text-to-texture pipeline: Canvas 2D text raster on a CPU canvas, a getImageData copy into a new ImageData, a wasm malloc and copy, creation of a GPU texture and its upload, then deletion of that texture right after one draw. The skill's SC-21 advises these WebGL-drawn annotations as the cheap option, but in this build they recreate a GPU resource on every frame. On the default native-text path, NativeAxisRenderer still rasterizes the rounded background rectangle through the canvas on every render.

**Scale where it matters:** Any chart that redraws continuously (streaming, pan, zoom, animation) with at least one AxisMarkerAnnotation, Horizontal/VerticalLineAnnotation with showLabel, or LineAnnotation axis labels. That is one Canvas 2D raster, one getImageData, one texture create/upload and one delete per label per render, i.e. 60 per second per label at 60 Hz. Each of these also clears a 1920x1080 canvas (see the TextureManager full-clear finding).

## Fix (library side)

```diff
--- esm/Charting/Visuals/Axis/AxisRenderer.js
+const LABEL_TEXTURE_CACHE_SIZE = 16;
+const styleKey = s => { var _a; const p = s.padding; return `${s.fontStyle}|${s.fontWeight}|${s.fontSize}|${s.fontFamily}|${s.color}|${(_a = s.multilineAlignment) !== null && _a !== void 0 ? _a : s.alignment}|${p ? `${p.top},${p.right},${p.bottom},${p.left}` : ""}`; };
@@ class AxisRenderer
+    /** @internal Small per-renderer LRU of label textures. The cache owns them: callers must not delete() them. */
+    getCachedLabelTexture(key, create) {
+        if (!this.labelTextureCache) {
+            this.labelTextureCache = new Map();
+        }
+        let entry = this.labelTextureCache.get(key);
+        if (entry) {
+            this.labelTextureCache.delete(key); // refresh LRU position
+        }
+        else {
+            entry = create();
+            if (!entry.bitmapTexture) {
+                return entry; // empty text or test env: nothing to own
+            }
+            if (this.labelTextureCache.size >= LABEL_TEXTURE_CACHE_SIZE) {
+                const [oldKey, old] = this.labelTextureCache.entries().next().value;
+                deleteSafe(old.bitmapTexture);
+                this.labelTextureCache.delete(oldKey);
+            }
+        }
+        this.labelTextureCache.set(key, entry);
+        return entry;
+    }
+    /** @internal Also call this from the context-lost handler, next to labelCache.resetCache() (createMaster.js:253) */
+    clearLabelTextureCache() {
+        var _a;
+        (_a = this.labelTextureCache) === null || _a === void 0 ? void 0 : _a.forEach(e => { try { deleteSafe(e.bitmapTexture); } catch (err) { Logger.debug(err); } });
+        this.labelTextureCache = undefined;
+    }
+    /** @internal Cached variant for drawAxisMarkerAnnotation. createAxisMarker stays uncached for external callers that delete its result */
+    getAxisMarkerTextureCached(axisAlignment, text, textStyle, backgroundColor, opacity) {
+        const key = `m|${axisAlignment}|${text}|${styleKey(textStyle)}|${backgroundColor}|${opacity}|${DpiHelper.PIXEL_RATIO}`;
+        return this.getCachedLabelTexture(key, () => this.createAxisMarker(axisAlignment, text, textStyle, backgroundColor, opacity));
+    }
+    /** @internal Cached variant for drawLineAnnotation. createAnnotationLabelTexture stays uncached */
+    getAnnotationLabelTextureCached(text, textStyle, backgroundColor, displayVertically, displayMirrored, opacity, cornerRadius) {
+        const key = `a|${text}|${styleKey(textStyle)}|${backgroundColor}|${displayVertically}|${displayMirrored}|${opacity}|${cornerRadius}|${DpiHelper.PIXEL_RATIO}`;
+        return this.getCachedLabelTexture(key, () => this.createAnnotationLabelTexture(text, textStyle, backgroundColor, displayVertically, displayMirrored, opacity, cornerRadius));
+    }
     delete() {
+        this.clearLabelTextureCache(); // before webAssemblyContext is dropped
         this.webAssemblyContext = undefined;
--- esm/Charting/Visuals/Helpers/drawLabel.js
@@ drawLineAnnotation
-        const { bitmapTexture, textureHeight, textureWidth } = currentAxis.axisRenderer.createAnnotationLabelTexture(text, labelTextStyle, labelBackgroundColor, displayVertically, displayMirrored, opacity);
+        const { bitmapTexture, textureHeight, textureWidth } = currentAxis.axisRenderer.getAnnotationLabelTextureCached(text, labelTextStyle, labelBackgroundColor, displayVertically, displayMirrored, opacity);
@@
         renderContext.drawTexture(bitmapTexture, Math.round(xPosition), Math.round(yPosition), textureWidth, textureHeight);
-        bitmapTexture.delete();
+        // owned by the axis renderer's label texture cache
@@ drawAxisMarkerAnnotation
     const { bitmapTexture, textureHeight, textureWidth } = image
         ? currentAxis.axisRenderer.createAxisMarkerFromImage(image, imageWidth, imageHeight)
-        : currentAxis.axisRenderer.createAxisMarker(axisAlignment, text, textStyle, fill, opacity);
+        : currentAxis.axisRenderer.getAxisMarkerTextureCached(axisAlignment, text, textStyle, fill, opacity);
@@
         renderContext.drawTexture(bitmapTexture, Math.round(xPosition), Math.round(yPosition), textureWidth, textureHeight);
-        bitmapTexture.delete();
+        if (image) {
+            bitmapTexture.delete(); // image markers are not cached
+        }
--- esm/Charting/Visuals/Axis/NativeAxisRenderer.js
+import { DpiHelper } from "../TextureManager/DpiHelper";
@@ drawModifierAxisLabelSpecific
-            const roundedRectTexture = this.textureManager.createFilledRectTexture(textureWidth, textureHeight, fill, cornerRadius);
+            // createFilledRectTexture rasterizes ceil(w) x ceil(h) with cornerRadius * PIXEL_RATIO
+            const roundedRectTexture = this.getCachedLabelTexture(`r|${Math.ceil(textureWidth)}|${Math.ceil(textureHeight)}|${fill}|${cornerRadius}|${DpiHelper.PIXEL_RATIO}`, () => this.textureManager.createFilledRectTexture(textureWidth, textureHeight, fill, cornerRadius));
             renderContext.drawTexture(roundedRectTexture.bitmapTexture, Math.round(xPosition), Math.round(yPosition), textureWidth, textureHeight);
-            roundedRectTexture.bitmapTexture.delete();
--- esm/Charting/Visuals/Axis/TextureAxisRenderer.js
@@ measureModifierAxisLabel (:29) and the fallback at :39
-        this.cachedModifierAxisLabelTexture = this.textureManager.createSimpleTextTexture(displayValue, { ...textStyle, padding: effectivePadding }, fill, undefined, undefined, undefined, cornerRadius);
+        const style = { ...textStyle, padding: effectivePadding };
+        this.cachedModifierAxisLabelTexture = this.getCachedLabelTexture(`t|${displayValue}|${styleKey(style)}|${fill}|${cornerRadius}|${DpiHelper.PIXEL_RATIO}`, () => this.textureManager.createSimpleTextTexture(displayValue, style, fill, undefined, undefined, undefined, cornerRadius));
@@ drawModifierAxisLabelSpecific
             renderContext.drawTexture(this.cachedModifierAxisLabelTexture.bitmapTexture, Math.round(xPosition), Math.round(yPosition), textureWidth, textureHeight);
-            this.cachedModifierAxisLabelTexture.bitmapTexture.delete();
 (export styleKey from AxisRenderer.js, or move it to a small helper, and import it with DpiHelper in TextureAxisRenderer.js)
```

**Trade-off:** Up to 16 small textures per axis renderer stay in GPU memory, a few KB each. One key string is built per label per frame. If more than 16 distinct labels are drawn on one axis per frame, the LRU thrashes and does the same create/delete work as today. When the value changes every frame (a last-price marker on a tick-per-frame feed), every lookup misses, and only the TextureManager clear fix (issue 011) helps. A DPI change needs no hook, because the key includes PIXEL_RATIO and the DPI-scaled font size, so stale entries age out. On WebGL context loss the cached textures are invalid: call clearLabelTextureCache() on each axis renderer where the context-lost handler resets the shared labelCache (createMaster.js:253). The public createAxisMarker, createAxisMarkerFromImage and createAnnotationLabelTexture stay uncached, so external callers that delete their result keep working. Image markers stay uncached and keep their per-render delete.

## App-side workaround

Keep isSvgOnly: true (the default) on CursorModifier and RolloverModifier. For Horizontal/VerticalLineAnnotation, set showLabel: false and draw the value with a NativeTextAnnotation. There is no workaround for AxisMarkerAnnotation other than using fewer markers.

## Verify

measure.md#fps, stream scenario on a chart with one AxisMarkerAnnotation and one HorizontalLineAnnotation (showLabel: true) whose values change rarely, 5 runs per side. Pass: a dev counter wrapped around TextureManager.createAxisMarkerTexture, createTextTexture and createFilledRectTexture rises only when a label's text changes. LoAF script time attributed to drawWithContext drops, and compare-runs shows "win" on frameP95Ms with no regression on the other four metrics.

## Other locations

- `esm/Charting/Visuals/Axis/AxisRenderer.js:552` — createAnnotationLabelTexture has no cache; drawLabel.js:34 creates it and :42 deletes it on every render
- `esm/Charting/Visuals/Axis/NativeAxisRenderer.js:78` — Default native-text path: the label background rectangle is rasterized through Canvas 2D and uploaded per render, then deleted at :80
- `esm/Charting/Visuals/Axis/TextureAxisRenderer.js:29` — Canvas-text path: one text texture per modifier label per render, deleted at :43
- `esm/Charting/Visuals/Axis/AxisRenderer.js:453` — The base measureModifierAxisLabel rasterizes and deletes a texture only to measure it, then :464 rasterizes it again. PolarAxisRenderer inherits both, but no built-in caller reaches them on a polar surface: the only drawModifiersAxisLabel caller, LineAnnotation.js:303, sits behind !parentSurface.isPolar (:259). So this is double work only for custom AxisRenderer subclasses.
- `esm/Charting/Visuals/Axis/AxisRenderer.js:546` — createAxisMarkerFromImage redraws the image to canvas and re-uploads it per render for image markers
- `esm/Charting/Visuals/Helpers/drawLabel.js:58` — Deletes the texture after a single draw
- `esm/Charting/Visuals/Annotations/VerticalLineAnnotation.js:116` — Same per-render createAnnotationLabelTexture + delete through drawLineAnnotation when showLabel is set

## Review notes

- Found by reviewer slice `s06-axis-text`.
- Adversarial verification (corrected): Re-read AxisRenderer.js:440-560. The code_quote matches :539-542 verbatim. createAxisMarker (:539/541), createAxisMarkerFromImage (:546-547) and createAnnotationLabelTexture (:552-553) forward to TextureManager with no cache. Per-render chain confirmed. SciChartRenderer.getAnnotationDrawFunctions (:360-379) adds every visible render-context annotation, user or modifier, and :429 calls drawWithContext with no dirty or texture-reuse guard. AxisMarkerAnnotation.js:262 -> drawLabel.js:49-52 -> createAxisMarker -> TextureManager.createAxisMarkerTexture (:186-224: full clearRect, measureText, Path2D fill, fillText) -> createTextureFromCtxBuffer getImageData (:287) -> createTextureFromImageData (:290-323: SCRTCreateBitmapTexture, _malloc, HEAP8.set, ccall SCRTFillActiveTextureCharArray, _free) -> drawTexture (drawLabel.js:57) -> bitmapTexture.delete() (:58). HorizontalLineAnnotation.js:114 and VerticalLineAnnotation.js:116 (showLabel) -> drawLabel.js:34 createAnnotationLabelTexture -> :42 delete. NativeAxisRenderer does not override this method, so it runs with the default useNativeText:true (SciChartDefaults.js:39). LineAnnotation.js:303 (non-polar only, :259; CursorModifier with isSvgOnly:false, axisLabelFill defaults to #228B22 at CursorModifier.js:86) -> drawLabel.js:10 -> AxisRenderer.drawModifiersAxisLabel :473 -> NativeAxisRenderer.js:78 createFilledRectTexture -> :80 delete, or TextureAxisRenderer.js:29 -> :43 delete. Rules: GPU-24 and GPU-05 apply directly. GPU-05 Avoid also flags deleting right after the draw. SC-21 Avoid does not excuse it. Fix diff problems found and corrected. (1) It removed bitmapTexture.delete() in drawAxisMarkerAnnotation for both branches, but createAxisMarkerFromImage stays uncached, so image markers would have leaked one texture per render. The corrected diff keeps the delete for the image branch. (2) It changed the public createAxisMarker to return cached textures, which contradicts its own trade_off: external callers that delete the result would free a cached texture. The corrected diff adds internal cached variants (getAxisMarkerTextureCached, getAnnotationLabelTextureCached) and leaves the existing methods uncached. (3) The annotation-label key now includes padding, alignment and cornerRadius. The filled-rect key uses ceil(w), ceil(h) and PIXEL_RATIO, matching what createFilledRectTexture rasterizes (TextureManager.js:243-252). NativeAxisRenderer needs a DpiHelper import. (4) Empty textures are not cached. delete() clears the cache before webAssemblyContext is dropped. The AxisBase2D.axisRenderer setter (:105-108) deletes the old renderer on a useNativeText switch, so the cache is freed there too. trade_off corrected. A DPI change needs no hook, because the key includes PIXEL_RATIO and the DPI-scaled font size, so old entries age out of the LRU. Context loss: createMaster.js:242-257 resets the shared labelCache and shuts the engine down, and the new cache must be dropped there too. If more than 16 distinct labels are drawn on one axis per frame, the LRU thrashes, which is no worse than today. other_locations: the AxisRenderer.js:453 note claimed PolarAxisRenderer rasterizes twice per label per render, but the only drawModifiersAxisLabel caller (LineAnnotation.js:303) is skipped on polar surfaces (:259), so the note is corrected. Added VerticalLineAnnotation.js:116. Severity high (per render while streaming, panning or animating, per labelled annotation) and evidence S are kept.

