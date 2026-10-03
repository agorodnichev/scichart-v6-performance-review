# 022 · Axis-marker, line-annotation and modifier axis labels are re-rasterized on a Canvas 2D, read back, uploaded and deleted on every render, even when the text is unchanged

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Axis/AxisRenderer.js:539` |
| Severity | **high** |
| Pipeline stage | GPU upload (`gpu-upload`) |
| Metric | frame time (also memory churn: ImageData and wasm heap allocations per frame) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
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
+    /** Small per-axis LRU of label textures; text and style rarely change between frames */
+    getCachedTexture(key, create) {
+        if (!this.labelTextureCache) {
+            this.labelTextureCache = new Map();
+        }
+        let entry = this.labelTextureCache.get(key);
+        if (entry) {
+            this.labelTextureCache.delete(key); // refresh LRU position
+        }
+        else {
+            if (this.labelTextureCache.size >= 16) {
+                const [oldKey, old] = this.labelTextureCache.entries().next().value;
+                deleteSafe(old.bitmapTexture);
+                this.labelTextureCache.delete(oldKey);
+            }
+            entry = create();
+        }
+        this.labelTextureCache.set(key, entry);
+        return entry;
+    }
     createAxisMarker(axisAlignment, text, textStyle, backgroundColor, opacity) {
         const { fontStyle, fontWeight, fontSize, fontFamily, color } = textStyle;
-        return this.textureManager.createAxisMarkerTexture(axisAlignment, text, fontStyle, fontWeight, fontSize, fontFamily, color, 2 * DpiHelper.PIXEL_RATIO, backgroundColor, opacity);
+        const key = `m|${axisAlignment}|${text}|${fontStyle}|${fontWeight}|${fontSize}|${fontFamily}|${color}|${backgroundColor}|${opacity}|${DpiHelper.PIXEL_RATIO}`;
+        return this.getCachedTexture(key, () => this.textureManager.createAxisMarkerTexture(axisAlignment, text, fontStyle, fontWeight, fontSize, fontFamily, color, 2 * DpiHelper.PIXEL_RATIO, backgroundColor, opacity));
     }
     delete() {
+        if (this.labelTextureCache) {
+            this.labelTextureCache.forEach(e => deleteSafe(e.bitmapTexture));
+            this.labelTextureCache = undefined;
+        }
--- esm/Charting/Visuals/Helpers/drawLabel.js (drawAxisMarkerAnnotation)
         renderContext.drawTexture(bitmapTexture, Math.round(xPosition), Math.round(yPosition), textureWidth, textureHeight);
-        bitmapTexture.delete();
+        // owned by axisRenderer's label texture cache
--- esm/Charting/Visuals/Axis/NativeAxisRenderer.js
-            const roundedRectTexture = this.textureManager.createFilledRectTexture(textureWidth, textureHeight, fill, cornerRadius);
+            const roundedRectTexture = this.getCachedTexture(`r|${textureWidth}|${textureHeight}|${fill}|${cornerRadius}`, () => this.textureManager.createFilledRectTexture(textureWidth, textureHeight, fill, cornerRadius));
             renderContext.drawTexture(roundedRectTexture.bitmapTexture, Math.round(xPosition), Math.round(yPosition), textureWidth, textureHeight);
-            roundedRectTexture.bitmapTexture.delete();
 (same keyed cache for createAnnotationLabelTexture + drawLabel.js:42, and for TextureAxisRenderer modifier labels)
```

**Trade-off:** Up to 16 small textures per axis stay in GPU memory, a few KB each. One key string is built per label per frame. The cache must be dropped on WebGL context loss and on DPI change; hook into the existing labelProvider.delete() error path and onDpiChanged. When the value changes every frame (a last-price marker on a tick-per-frame feed), the cache misses and only the TextureManager clear fix helps. External code that calls createAxisMarker or createAnnotationLabelTexture and then deletes the result would delete a cached texture, so add cached variants for the built-in callers and keep the old methods uncached.

## App-side workaround

Keep isSvgOnly: true (the default) on CursorModifier and RolloverModifier. For Horizontal/VerticalLineAnnotation, set showLabel: false and draw the value with a NativeTextAnnotation. There is no workaround for AxisMarkerAnnotation other than using fewer markers.

## Verify

measure.md#fps, stream scenario on a chart with one AxisMarkerAnnotation and one HorizontalLineAnnotation (showLabel: true) whose values change rarely, 5 runs per side. Pass: a dev counter wrapped around TextureManager.createAxisMarkerTexture, createTextTexture and createFilledRectTexture rises only when a label's text changes. LoAF script time attributed to drawWithContext drops, and compare-runs shows "win" on frameP95Ms with no regression on the other four metrics.

## Other locations

- `esm/Charting/Visuals/Axis/AxisRenderer.js:552` — createAnnotationLabelTexture has no cache; drawLabel.js:34 creates it and :42 deletes it on every render
- `esm/Charting/Visuals/Axis/NativeAxisRenderer.js:78` — Default native-text path: the label background rectangle is rasterized through Canvas 2D and uploaded per render, then deleted at :80
- `esm/Charting/Visuals/Axis/TextureAxisRenderer.js:29` — Canvas-text path: one text texture per modifier label per render, deleted at :43
- `esm/Charting/Visuals/Axis/AxisRenderer.js:453` — The base measureModifierAxisLabel rasterizes and deletes a texture only to measure it, then :464 rasterizes it again; PolarAxisRenderer inherits both, so it rasterizes twice per label per render
- `esm/Charting/Visuals/Axis/AxisRenderer.js:546` — createAxisMarkerFromImage redraws the image to canvas and re-uploads it per render for image markers
- `esm/Charting/Visuals/Helpers/drawLabel.js:58` — Deletes the texture after a single draw

## Review notes

- Found by reviewer slice `s06-axis-text`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

