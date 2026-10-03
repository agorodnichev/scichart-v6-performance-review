# 011 · TextureManager clears its entire 1920x1080 CPU scratch canvas (8.3 MB) for every label texture, whatever the label size

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/TextureManager/TextureManager.js:92` |
| Severity | **high** |
| Pipeline stage | Paint and raster (`paint`) |
| Metric | frame time |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/cbdcf49a1f960a3cb3ffc194ee38deb2/): reproduced on WebGL and WebGPU ([source](../demos/011-texture-manager-full-canvas-clear/)) |
| Rule | GPU-24, CNV-12 (web-performance skill) |
| Effort to fix | small |

## Code

```js
        // Save state
        this.ctx.save();
        this.ctx.globalAlpha = opacity !== null && opacity !== void 0 ? opacity : 1;
        this.ctx.textBaseline = "alphabetic";
        // Switched this back to alphabetic because...reasons
        // https://html.spec.whatwg.org/multipage/canvas.html#dom-context-2d-textbaseline-alphabetic
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.fillStyle = color;
        this.ctx.font = getFontString(fontStyle, fontWeight, fontSizePx, fontFamily);
```

## Call path and frequency

Runs on every texture that TextureManager rasterizes. Per render, per labelled annotation (SciChartRenderer.js:429 drawWithContext): AxisMarkerAnnotation.js:262 -> drawLabel.js:52 -> AxisRenderer.createAxisMarker (AxisRenderer.js:541) -> createAxisMarkerTexture (TextureManager.js:189). Horizontal/VerticalLineAnnotation with showLabel (HorizontalLineAnnotation.js:114, VerticalLineAnnotation.js:116) -> drawLabel.js:34 -> AxisRenderer.createAnnotationLabelTexture (AxisRenderer.js:553) -> createSimpleTextTexture -> createTextTexture (TextureManager.js:92). NativeAxisRenderer does not override this method, so it also runs with the default useNativeText:true. Modifier axis labels (drawModifiersAxisLabel, AxisRenderer.js:473/480/533, e.g. LineAnnotation labels from CursorModifier or RolloverModifier with isSvgOnly:false) on the default native renderer: NativeAxisRenderer.js:78 createFilledRectTexture (when fill is set) -> getTextureContext (TextureManager.js:283). On the canvas-text renderer: TextureAxisRenderer.js:29/39 createSimpleTextTexture. On the base AxisRenderer: :453 and :464. Canvas-text axis tick labels (useNativeText:false, opt-in): LabelProviderBase2D.getLabels -> getLabelTexture (LabelProviderBase2D.js:163 -> :383) only on a shared LabelCache miss, i.e. once per new label text (new tick values while panning or zooming). With useCache:false it runs per label per render (TextureAxisRenderer.js:17/23).

## Why it costs

The canvas uses willReadFrequently:true, so it is a CPU bitmap. clearRect over the whole canvas rasterizes as a write over all 8.3 MB of pixels when getImageData flushes the canvas. Only the w x h rectangle at the origin is then read back, so the work is proportional to the scratch canvas size, not to the label.

**Scale where it matters:** 1920 x 1080 x 4 = 8,294,400 bytes cleared per texture (more if getTextureContext has grown the canvas), while a typical label is about 60 x 20 px (4.8 KB) and only that rectangle is read back. The cost multiplies by textures per frame: one per AxisMarkerAnnotation, per labelled line annotation and per filled modifier axis label on every render, plus one per new tick-label text in canvas-text mode.

## Fix (library side)

```diff
--- esm/Charting/Visuals/TextureManager/TextureManager.js (createTextTexture)
         this.ctx.textBaseline = "alphabetic";
-        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
         this.ctx.fillStyle = color;
@@
         if (!textureWidth || !textureHeight) {
+            this.ctx.restore(); // also balances the save() above, which this early return currently leaks
             return { bitmapTexture: undefined, textureWidth, textureHeight };
         }
         let newTextureWidth = textureWidth;
         let newTextureHeight = textureHeight;
+        const rotationRad = (rotation * Math.PI) / 180;
         if (rotation) {
-            // convert to radians
-            const rotationRad = (rotation * Math.PI) / 180;
             newTextureWidth = Math.round(textureWidth * Math.abs(Math.cos(rotationRad)) + textureHeight * Math.abs(Math.sin(rotationRad)));
             newTextureHeight = Math.round(textureWidth * Math.abs(Math.sin(rotationRad)) + textureHeight * Math.abs(Math.cos(rotationRad)));
+        }
+        // clear only the rectangle that getImageData reads below (identity transform here)
+        this.ctx.clearRect(0, 0, newTextureWidth, newTextureHeight);
+        if (rotation) {
             this.ctx.translate(newTextureWidth / 2, newTextureHeight / 2);
@@ getTextureContext(width, height)
-        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
+        this.ctx.clearRect(0, 0, width, height);
 (same in createAxisMarkerTexture: clear finalTextureWidth x finalTextureHeight after calcAxisMarkerTextureParams; createTextureFromImage: clearRect(0, 0, width, height))
```

**Trade-off:** No functional change. Pixels outside the read-back rectangle may keep stale content, but they are never read, and each call still clears exactly the rectangle it reads.

## App-side workaround

Keep useNativeText: true (the default) so axis labels never use this path, and avoid the per-frame texture paths (see the annotation label texture finding).

## Verify

measure.md#fps, stream scenario on a chart with two AxisMarkerAnnotations and one HorizontalLineAnnotation (showLabel: true). Add a zoom scenario with useNativeText: false, where new tick texts create textures. 5 runs per side. Pass: the self time of TextureManager.createTextTexture and createAxisMarkerTexture in the trace and in __wpProbe.loaf.read() drops, and compare-runs shows "win" on frameP95Ms.

## Other locations

- `esm/Charting/Visuals/TextureManager/TextureManager.js:189` — createAxisMarkerTexture clears the full canvas
- `esm/Charting/Visuals/TextureManager/TextureManager.js:233` — createTextureFromImage clears the full canvas
- `esm/Charting/Visuals/TextureManager/TextureManager.js:283` — getTextureContext, used by createFilledRectTexture, clears the full canvas; its comment says "it's slow"
- `esm/Charting/Visuals/TextureManager/TextureManager.js:122` — The early return skips ctx.restore(), so the 2D state stack grows for every empty, zero-padding label

## Review notes

- Found by reviewer slice `s06-axis-text`.
- Adversarial verification (corrected): Re-read esm/Charting/Visuals/TextureManager/TextureManager.js:1-300. The code_quote matches lines 86-94 verbatim, and the primary :92 is the clearRect line inside it. The constructor (:22-26) makes a 1920x1080 canvas with getContext("2d", {willReadFrequently:true}), which is a CPU-backed bitmap. Each raster entry point clears the whole canvas: createTextTexture :92, createAxisMarkerTexture :189, createTextureFromImage :233, and getTextureContext :283, which createFilledRectTexture :245 uses. Each then reads back only a w x h rectangle at the origin via createTextureFromCtxBuffer -> getImageData (:286-287). getTextureContext can also grow the canvas past 1920x1080 (:276-281). The early return at :122-123 skips the restore() for the save() at :87. Callers re-established with rg. Per render (SciChartRenderer.js:429 drawWithContext for each visible render-context annotation): AxisMarkerAnnotation.js:262 -> drawLabel.js:49-52 -> AxisRenderer.createAxisMarker :541 -> createAxisMarkerTexture. HorizontalLineAnnotation.js:114 and VerticalLineAnnotation.js:116 with showLabel -> drawLabel.js:34 -> AxisRenderer.createAnnotationLabelTexture :553 -> createSimpleTextTexture -> createTextTexture. NativeAxisRenderer does not override that method, so this path runs with the default useNativeText:true too. drawModifiersAxisLabel (AxisRenderer.js:473/480/533), on the default native renderer (SciChartDefaults.useNativeText = true; AxisBase2D.js:1069-1073) -> NativeAxisRenderer.js:77-78 createFilledRectTexture when fill is set -> getTextureContext :283. On the canvas-text renderer -> TextureAxisRenderer.js:29/39. AxisRenderer.js:453/464 is the base path, rasterized twice. Correction: canvas-text axis tick labels (useNativeText:false, opt-in) create a texture only on a shared LabelCache miss (LabelProviderBase2D.js:132-168 -> :383). That is per new label text, not every label in every frame of a zoom. Titles go through their own texture cache (ChartTitleRenderer.js:36). Mechanism: clearRect ignores globalAlpha but applies to the full bitmap here, so Skia raster (Chrome, Firefox) writes every pixel of the 8,294,400-byte surface when the recording flushes at getImageData. The work therefore scales with the scratch canvas, not with the label. No rule Avoid clause (GPU-24, CNV-12) excuses it. Fix checked: at each new clearRect site the transform is identity. createTextTexture is after save() and before translate/rotate. createAxisMarkerTexture is before its save() at :194. The getTextureContext and createTextureFromImage clears happen before any draw. Each clear covers exactly the rectangle that getImageData reads afterwards, so stale pixels can only lie outside that rectangle, and those are never read. Output is identical. The added restore() on the early return correctly balances the save() at :87. Severity high is kept: per render while streaming, panning or animating, for each AxisMarkerAnnotation, labelled line annotation or filled native modifier label. Evidence S is kept. CORRECTED call_path, scale and verify: tick labels hit this path only on cache misses (no fixed per-frame count), and the default-renderer facts are stated.

