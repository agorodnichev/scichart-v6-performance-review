# 002 · Line-annotation labels and AxisMarkerAnnotation are re-rasterized on a 1920x1080 CPU canvas, read back with getImageData and uploaded to a new GPU texture on every frame, then deleted

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Helpers/drawLabel.js:33` |
| Severity | **high** |
| Pipeline stage | GPU upload (`gpu-upload`) |
| Metric | frame time (also INP while dragging or panning) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Rule | GPU-24, GPU-05, CNV-15 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
    if (showLabel) {
        const { bitmapTexture, textureHeight, textureWidth } = currentAxis.axisRenderer.createAnnotationLabelTexture(text, labelTextStyle, labelBackgroundColor, displayVertically, displayMirrored, opacity);
        const { xPosition, yPosition } = getLabelCoordinates(currentAxis, labelPlacement, x1Coord, x2Coord, y1Coord, y2Coord, textureHeight, textureWidth, horizontalAlignment, verticalAlignment);
        labelHeight = textureHeight;
        labelWidth = textureWidth;
        labelRect = new Rect(xPosition, yPosition, textureWidth, textureHeight);
        const clipRect = currentAxis.parentSurface.viewRect;
        renderContext.resetAndClip(clipRect);
        renderContext.drawTexture(bitmapTexture, Math.round(xPosition), Math.round(yPosition), textureWidth, textureHeight);
        bitmapTexture.delete();
    }
```

## Call path and frequency

Engine frame -> SciChartSurface.onRenderSurfaceDraw (esm/Charting/Visuals/SciChartSurface.js:1331; :1352 per sub-chart, else :1356) -> doDrawingLoop (:640 sciChartRenderer.render) -> SciChartRenderer.render (esm/Charting/Services/SciChartRenderer.js:201 getAnnotationDrawFunctions) -> getRenderContextAnnotationDrawFunction (:370/:378, only an isVisible check; drawFn queued at :438, no dirty flag or cache) -> renderContext.drawLayers (:305) -> drawFn (:429) annotation.drawWithContext -> HorizontalLineAnnotation.js:114 / VerticalLineAnnotation.js:116 -> drawLineAnnotation (drawLabel.js:33-42); AxisMarkerAnnotation.js:262 -> drawAxisMarkerAnnotation (drawLabel.js:50-58) -> AxisRenderer.createAnnotationLabelTexture (AxisRenderer.js:552) / createAxisMarker (:539) -> TextureManager.createTextTexture (clearRect :92, font :94, measureText :103, fillText :175) / createAxisMarkerTexture (:186) -> createTextureFromCtxBuffer (:287 getImageData) -> createTextureFromImageData (:294-313) -> WebGlRenderContext2D.drawTexture (:344) -> bitmapTexture.delete(). Once per visible labelled line annotation and per visible axis marker on every rendered frame (any pan or zoom step, data append, or cursor move that redraws).

## Why it costs

For each label, every frame repeats the whole chain from scratch: a clearRect over the 1920x1080 willReadFrequently (CPU-backed) canvas, about 8.3 MB of pixels; a ctx.font parse; measureText (twice for centred or right-aligned text); fillText; getImageData (a new Uint8ClampedArray, which also flushes the recorded canvas ops); _malloc plus a HEAP8 copy into wasm; a new GPU texture with a full upload; one draw; then a texture delete right after the draw that used it (GPU-05 Avoid / GPU-30). Between frames the string and style are almost always unchanged (pan, zoom, appends to other series), so all of it is repeated work. GPU-24 says to rasterize and upload only when the string changes. The library already does this for axis tick labels (labelCache, getCachedLabelTexture) but not for these annotation labels.

**Scale where it matters:** Any surface with HorizontalLine/VerticalLine annotations with showLabel:true, or AxisMarkerAnnotations (a trading chart often has one 'last value' marker per series). Cost is linear in their count times the redraw rate: 10 markers on a chart that redraws at display rate is 10 full-canvas clears, 10 getImageData copies, 10 texture creates+uploads and 10 texture deletes per frame, even when no label text changed.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/Helpers/drawLabel.js
+++ b/esm/Charting/Visuals/Helpers/drawLabel.js
@@
 import { Rect } from "../../../Core/Rect";
+import { deleteSafe } from "../../../Core/Deleter";
+import { DpiHelper } from "../TextureManager/DpiHelper";
+// One label texture per annotation (cache object owned by the annotation), kept until an input of the raster changes
+const getCachedLabelTexture = (cache, key, create) => {
+    if (!cache) return { tex: create(), owned: false };
+    if (!cache.tex || cache.key !== key) {
+        deleteSafe(cache.tex && cache.tex.bitmapTexture);
+        cache.tex = create();
+        cache.key = key;
+    }
+    return { tex: cache.tex, owned: true };
+};
+const styleKey = (s) => [s.fontFamily, s.fontSize, s.fontStyle, s.fontWeight, s.color,
+    s.padding ? [s.padding.top, s.padding.right, s.padding.bottom, s.padding.left].join(",") : "",
+    s.multilineAlignment, s.alignment].join("|");
-export const drawLineAnnotation = (currentAxis, renderContext, labelPlacement, displayValue, x1Coord, x2Coord, y1Coord, y2Coord, textStyle, fill, strokePen, viewRect, showLabel, opacity, horizontalAlignment, verticalAlignment) => {
+export const drawLineAnnotation = (currentAxis, renderContext, labelPlacement, displayValue, x1Coord, x2Coord, y1Coord, y2Coord, textStyle, fill, strokePen, viewRect, showLabel, opacity, horizontalAlignment, verticalAlignment, labelTextureCache) => {
@@
     if (showLabel) {
-        const { bitmapTexture, textureHeight, textureWidth } = currentAxis.axisRenderer.createAnnotationLabelTexture(text, labelTextStyle, labelBackgroundColor, displayVertically, displayMirrored, opacity);
+        const key = [text, styleKey(labelTextStyle), labelBackgroundColor, displayVertically, displayMirrored, opacity, DpiHelper.PIXEL_RATIO].join("|");
+        const { tex, owned } = getCachedLabelTexture(labelTextureCache, key, () => currentAxis.axisRenderer.createAnnotationLabelTexture(text, labelTextStyle, labelBackgroundColor, displayVertically, displayMirrored, opacity));
+        const { bitmapTexture, textureHeight, textureWidth } = tex;
@@
         renderContext.drawTexture(bitmapTexture, Math.round(xPosition), Math.round(yPosition), textureWidth, textureHeight);
-        bitmapTexture.delete();
+        if (!owned) bitmapTexture.delete();
     }
# drawAxisMarkerAnnotation (:46-58): same pattern with an extra labelTextureCache parameter; key = image ? [image src identity via cache.image === image, imageWidth, imageHeight, DPR] : [axisAlignment, text, styleKey(textStyle), fill, opacity, DPR].
--- a/esm/Charting/Visuals/Annotations/HorizontalLineAnnotation.js   (likewise VerticalLineAnnotation.js:116 and AxisMarkerAnnotation.js:262)
-            const labelRect = drawLineAnnotation(verticalAxis, renderContext, this.labelPlacement, this.labelValue, borderX1, borderX2, borderY1, borderY2, textStyle, this.axisLabelFill, strokePen, seriesViewRect, this.showLabel, this.opacity, this.horizontalAlignment);
+            this.labelTextureCache = this.labelTextureCache || {};
+            const labelRect = drawLineAnnotation(verticalAxis, renderContext, this.labelPlacement, this.labelValue, borderX1, borderX2, borderY1, borderY2, textStyle, this.axisLabelFill, strokePen, seriesViewRect, this.showLabel, this.opacity, this.horizontalAlignment, undefined, this.labelTextureCache);
# Release the cached texture in delete() (LineAnnotation.js:227; AxisMarkerAnnotation.js:67, empty today), onDetach() and onDpiChanged():
#   if (this.labelTextureCache) { deleteSafe(this.labelTextureCache.tex && this.labelTextureCache.tex.bitmapTexture); this.labelTextureCache = undefined; }
```

**Trade-off:** Each labelled annotation keeps one small live texture (w x h x 4 bytes; 120x30 px is about 14 KB). The cache must be released on delete, detach (an annotation re-attached to another surface may be on another wasm context), DPR change and WebGL context loss (register with WebGlRenderContext2D.webGlResourcesRefs as BaseCache does). A label rasterized before a web font loads keeps the fallback font until its key changes, so also drop the cache on document.fonts 'loadingdone' (CNV-15). A label whose text changes every frame (a streaming last-price marker) still re-rasterizes on those frames. A complementary change that also helps those frames: in createTextTexture / createAxisMarkerTexture / getTextureContext, clear only the (0,0,w,h) region that getImageData reads, after measuring, instead of the whole 1920x1080 canvas.

## App-side workaround

Set showLabel:false on HorizontalLine/VerticalLine annotations and draw the label with a NativeTextAnnotation (native glyph path, background brush) at the same y1/x1. For AxisMarkerAnnotation there is no direct equivalent: keep the number of markers low, or use a NativeTextAnnotation anchored at the axis edge.

## Verify

measure.md#fps, `pan` scenario then `stream` scenario on a surface with 10 HorizontalLineAnnotation(showLabel:true) and 10 AxisMarkerAnnotation, desktop profile, DPR 2, 5 runs per side. In a dev build, count wasmContext.SCRTCreateBitmapTexture calls through window.__perf.counters(). Pass: while panning with constant label text the texture-create counter stays flat; compare-runs gives 'win' or neutral on frameP95Ms and longFramesPer10s; LoAF script time attributed to drawWithContext goes down. Not measured.

## Other locations

- `esm/Charting/Visuals/Helpers/drawLabel.js:50` — drawAxisMarkerAnnotation: createAxisMarker / createAxisMarkerFromImage on every call, delete at :58. An image marker redraws and re-uploads the same static bitmap every frame
- `esm/Charting/Visuals/Axis/NativeAxisRenderer.js:78` — LineAnnotation axis labels (drawModifiersAxisLabel, drawLabel.js:10 from LineAnnotation.js:303): with the default native-text renderer the text uses the glyph path, but the label background is still a per-call canvas texture (createFilledRectTexture), deleted at :80
- `esm/Charting/Visuals/Axis/AxisRenderer.js:552` — createAnnotationLabelTexture -> TextureManager.createSimpleTextTexture. NativeAxisRenderer does not override it
- `esm/Charting/Visuals/TextureManager/TextureManager.js:92` — clearRect of the whole canvas for every label. The canvas is DEFAULT_WIDTH x DEFAULT_HEIGHT = 1920x1080 (:11-13, :24-26), created with willReadFrequently, so CPU-backed: about 8.3 MB cleared per label
- `esm/Charting/Visuals/TextureManager/TextureManager.js:283` — getTextureContext (used by createFilledRectTexture) clears the whole canvas too; the source comment says 'it's not clear if this is actually required, and it's slow'
- `esm/Charting/Visuals/TextureManager/TextureManager.js:287` — getImageData copy, then SCRTCreateBitmapTexture (:294), _malloc + HEAP8.set (:303-306) and ccall SCRTFillActiveTextureCharArray (:309) upload
- `esm/Charting/Visuals/Annotations/HorizontalLineAnnotation.js:114`
- `esm/Charting/Visuals/Annotations/VerticalLineAnnotation.js:116`
- `esm/Charting/Visuals/Annotations/AxisMarkerAnnotation.js:262`
- `esm/Charting/Visuals/Annotations/AxisMarkerAnnotation.js:67` — delete() is empty today; a cached texture needs releasing here

## Review notes

- Found by reviewer slice `s01-surface-render`.
- Adversarial verification (corrected): Re-read drawLabel.js:15-61 (quote matches verbatim at :33-43, primary moved from :34 to :33). Confirmed callers with rg: drawLineAnnotation only from HorizontalLineAnnotation.js:114 and VerticalLineAnnotation.js:116; drawAxisMarkerAnnotation only from AxisMarkerAnnotation.js:262; both inside drawWithContext. SciChartRenderer.getRenderContextAnnotationDrawFunction (:405-440) queues drawWithContext for every visible annotation on every render with no dirty flag or texture cache; onRenderSurfaceDraw (:1331-1357) runs doDrawingLoop -> render for each rendered frame. AxisRenderer.createAnnotationLabelTexture (:552) and createAxisMarker (:539) create a fresh texture per call; NativeAxisRenderer does not override them (its drawModifierAxisLabelSpecific still calls createFilledRectTexture at :78 and deletes at :80). Corrected the canvas size: TextureManager uses DEFAULT_WIDTH=1920, DEFAULT_HEIGHT=1080 (:11-13, :24-26), not 900x600, so each full clearRect covers about 8.3 MB on a willReadFrequently canvas. Checked deleteSafe (Core/Deleter.js) handles undefined. Added detach, font-load invalidation and the empty AxisMarkerAnnotation.delete() to the fix and trade-off. GPU-24's Do (skip all work when the string did not change) matches; its Avoid (per-glyph atlas, DPR change) does not exempt this case.

