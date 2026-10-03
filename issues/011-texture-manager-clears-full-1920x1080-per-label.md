# 011 · TextureManager clears its entire 1920x1080 CPU scratch canvas (8.3 MB) for every label texture, whatever the label size

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/TextureManager/TextureManager.js:92` |
| Severity | **high** |
| Pipeline stage | Paint and raster (`paint`) |
| Metric | frame time |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
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

Runs on every texture created by TextureManager. TextureManager.createTextTexture (TextureManager.js:92) is called from: LabelProviderBase2D.getLabels → getLabelTexture (LabelProviderBase2D.js:163/383) once per new label in canvas-text mode (useNativeText:false), i.e. for every label in every frame of a zoom; AxisRenderer.createAnnotationLabelTexture (AxisRenderer.js:553) ← drawLabel.js:34, per render per line-annotation label; TextureAxisRenderer.measureModifierAxisLabel (TextureAxisRenderer.js:29), per render per modifier label. createAxisMarkerTexture (TextureManager.js:189) ← AxisRenderer.js:541 ← drawLabel.js:52, per render per AxisMarkerAnnotation. getTextureContext (TextureManager.js:283) ← createFilledRectTexture:245 ← NativeAxisRenderer.js:78, per render per filled modifier label on the default native path.

## Why it costs

The canvas uses willReadFrequently:true, so it is a CPU bitmap. clearRect over the whole canvas rasterizes as a write over all 8.3 MB of pixels when getImageData flushes the canvas. Only the w x h rectangle at the origin is then read back, so the work is proportional to the scratch canvas size, not to the label.

**Scale where it matters:** 1920 x 1080 x 4 = 8,294,400 bytes cleared per texture, while a typical label is about 60 x 20 px (4.8 KB). The cost multiplies by labels per frame: per-frame annotation labels, and about 10 new labels per axis per frame while zooming in canvas-text mode.

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

measure.md#fps, zoom scenario on a chart with useNativeText: false (new label textures every frame), plus the AxisMarkerAnnotation stream scenario, 5 runs per side. Pass: TextureManager.createTextTexture and createAxisMarkerTexture self time in the trace and in __wpProbe.loaf.read() drops, and compare-runs shows "win" on frameP95Ms.

## Other locations

- `esm/Charting/Visuals/TextureManager/TextureManager.js:189` — createAxisMarkerTexture clears the full canvas
- `esm/Charting/Visuals/TextureManager/TextureManager.js:233` — createTextureFromImage clears the full canvas
- `esm/Charting/Visuals/TextureManager/TextureManager.js:283` — getTextureContext, used by createFilledRectTexture, clears the full canvas; its comment says "it's slow"
- `esm/Charting/Visuals/TextureManager/TextureManager.js:122` — The early return skips ctx.restore(), so the 2D state stack grows for every empty, zero-padding label

## Review notes

- Found by reviewer slice `s06-axis-text`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

