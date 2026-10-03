# 071 · Every axis owns two 1920x1080 willReadFrequently scratch canvases (axis renderer and title renderer), each about 7.9 MiB of CPU bitmap once used

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/TextureManager/TextureManager.js:23` |
| Severity | **medium** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/4138403e416f8ed8083592da33ebc5a0/): reproduced on WebGL and WebGPU ([source](../demos/071-two-scratch-canvases-per-axis/)) |
| Rule | CNV-05, CNV-24 (web-performance skill) |
| Effort to fix | small |

## Code

```js
        this.webAssemblyContext = webAssemblyContext;
        if (!IS_TEST_ENV) {
            this.canvas = document.createElement("canvas");
            this.canvas.width = DEFAULT_WIDTH;
            this.canvas.height = DEFAULT_HEIGHT;
            this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
        }
```

## Call path and frequency

Runs once per axis, and again on each switchAxisRenderer: the AxisBase2D constructor creates AxisTitleRenderer (esm/Charting/Visuals/Axis/AxisBase2D.js:503 → esm/Charting/Services/TitleRenderer.js:44 new TextureManager) and the axis renderer (AxisBase2D.createAxisRender:1069 → esm/Charting/Visuals/Axis/AxisRenderer.js:45 new TextureManager) → TextureManager.js:23-26. Each surface's ChartTitleRenderer (SciChartSurface.js:319) adds one more. The backing store is allocated on the first 2D operation. That comes from canvas-text labels and titles (useNativeText: false), and also on the default native-text path from AxisMarkerAnnotation (drawLabel.js:50-52 → AxisRenderer.js:541/547), Horizontal/VerticalLineAnnotation labels (drawLabel.js:34 → AxisRenderer.js:553) and LineAnnotation axis labels (LineAnnotation.js:303 → NativeAxisRenderer.js:78 createFilledRectTexture, default fill #b36200), all drawn per frame.

## Why it costs

Rasterization is synchronous on the main thread and every create call clears and reads back immediately, so one scratch canvas per page is enough. Instead, scratch memory scales with the number of axes, and the canvases stay alive until garbage collection after delete(): TextureManager.delete drops the references but never sets width and height to 0 (CNV-24). getTextureContext can grow the canvas and never shrinks it.

**Scale where it matters:** 1920 x 1080 x 4 bytes ≈ 7.9 MiB per canvas once drawn. A 20-chart dashboard in canvas-text mode with axis titles has 2 axes x 2 canvases + 1 chart-title canvas = 5 per chart, up to about 100 canvases (≈ 790 MiB). In the default native-text mode, each axis that carries an AxisMarkerAnnotation, a labelled Horizontal/VerticalLineAnnotation or a LineAnnotation axis label costs one 7.9 MiB canvas.

## Fix (library side)

```diff
--- esm/Charting/Visuals/TextureManager/TextureManager.js
+// one CPU-backed scratch canvas for every TextureManager on the page: each create call
+// clears the rectangle it reads and reads back synchronously
+let sharedCanvas;
+let sharedCtx;
 export class TextureManager extends DeletableEntity {
     constructor(webAssemblyContext) {
         super();
         this.webAssemblyContext = webAssemblyContext;
         if (!IS_TEST_ENV) {
-            this.canvas = document.createElement("canvas");
-            this.canvas.width = DEFAULT_WIDTH;
-            this.canvas.height = DEFAULT_HEIGHT;
-            this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
+            if (!sharedCanvas) {
+                sharedCanvas = document.createElement("canvas");
+                sharedCanvas.width = DEFAULT_WIDTH;
+                sharedCanvas.height = DEFAULT_HEIGHT;
+                sharedCtx = sharedCanvas.getContext("2d", { willReadFrequently: true });
+            }
+            this.canvas = sharedCanvas;
+            this.ctx = sharedCtx;
         }
     }
@@
     createTextureFromImage(image, imageWidth, imageHeight) {
+        // the context is shared: createAxisMarkerTexture leaves globalAlpha set outside save/restore
+        this.ctx.globalAlpha = 1;
         this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
```

**Trade-off:** All TextureManagers share one mutable 2D context. Every create call runs synchronously from clear to getImageData, so contents never mix. State can leak, though: createAxisMarkerTexture leaves globalAlpha, textBaseline, font and sometimes fillStyle set outside its save/restore (TextureManager.js:187-190, :216-218). The fix therefore resets globalAlpha in createTextureFromImage, the only create call that does not set it. As a result, an image marker no longer inherits the opacity of a text marker drawn just before on the same axis, which today is an accident of draw order. A custom getLabelTexture override that draws on textureManager.ctx without setting its own state, or that keeps content in textureManager.canvas across calls, could see another axis's state or content. One 1920x1080 bitmap per page remains once used. Starting smaller and growing on demand would cut that too, but resizing resets context state, so font, fill and alpha must be re-applied after a grow.

## App-side workaround

Keep useNativeText: true (the default) and keep labelled AxisMarker or line annotations to the axes that need them; there is no API to share or shrink the scratch canvas.

## Verify

measure.md#mem: mount and unmount a 20-chart view (useNativeText: false, axis titles, one AxisMarkerAnnotation per chart) 10 times, snapshots S0/S1/S2, plus a steady mounted sample. Pass: __wpProbe.memory.sample() canvas count per chart drops to 0 extra scratch canvases, retained memory per mounted chart drops by about 7.9 MiB per removed canvas, and S1→S2 growth per action stays within noise.

## Other locations

- `esm/Charting/Visuals/Axis/AxisRenderer.js:45` — One TextureManager per axis renderer
- `esm/Charting/Services/TitleRenderer.js:44` — One TextureManager per axis title renderer and per chart title
- `esm/Charting/Visuals/TextureManager/TextureManager.js:332` — delete() drops the references without releasing the bitmap (width/height = 0)

## Review notes

- Found by reviewer slice `s06-axis-text`.
- Adversarial verification (corrected): Re-read esm/Charting/Visuals/TextureManager/TextureManager.js:1-340. The code_quote matches :21-27 verbatim, with createElement at the primary line :23. DEFAULT_WIDTH/HEIGHT are 1920/1080 (:11-13), and 1920*1080*4 = 8,294,400 B, about 7.9 MiB. Construction sites confirmed with rg: there are only two `new TextureManager` calls in esm, AxisRenderer.js:45 (base class of both NativeAxisRenderer and TextureAxisRenderer, created by AxisBase2D.createAxisRender :1069-1074 from the constructor :497 and again by switchAxisRenderer :1080-1084, which drops the old renderer without delete) and TitleRenderer.js:44 (TitleRendererBase, used by AxisTitleRenderer from AxisBase2D.js:503 and by ChartTitleRenderer from SciChartSurface.js:319). Every axis therefore owns two canvas elements and every surface one more. Which paths touch the canvas, and so allocate its backing store: canvas-text labels (LabelProviderBase2D.js:163/:383 -> createTextTexture, which clears the full canvas at :92). Axis and chart titles in canvas-text mode (AxisTitleRenderer.js:87, ChartTitleRenderer.js:88). On the default native path too: AxisMarkerAnnotation (AxisMarkerAnnotation.js:262 -> drawLabel.js:50-52 -> AxisRenderer.createAxisMarker :541 / createAxisMarkerFromImage :547), Horizontal/VerticalLineAnnotation labels (HorizontalLineAnnotation.js:114 -> drawLabel.js:34 -> createAnnotationLabelTexture :553), and LineAnnotation axis labels (LineAnnotation.js:303 -> drawModifiersAxisLabel -> NativeAxisRenderer.js:76-80 createFilledRectTexture, with default axisLabelFill #b36200 at LineAnnotation.js:56). NativeAxisRenderer overrides none of the three annotation methods. TextureManager.delete (:332-336) only drops references, and getTextureContext (:273-284) only grows the canvas. No async code uses the context (rg finds no await or then in TextureManager or the label providers), and nothing outside TextureManager reads textureManager.canvas or .ctx in esm, so one shared canvas is workable. Correction to the fix: the claim that each create call sets its own state is not fully true. createAxisMarkerTexture sets globalAlpha, textBaseline and font before its save() (:187-190) and, for Right alignment, fillStyle after its restore() (:216-218), so that state persists. createTextureFromImage (:232-238) sets no globalAlpha. With a shared context, a text AxisMarkerAnnotation with opacity 0.5 on one axis would fade an image AxisMarkerAnnotation drawn next on any other axis. Today that leak can only come from the same axis. Added a globalAlpha reset to fix_diff and corrected trade_off. Also replaced 'filled modifier label' in call_path and scale with the real path, LineAnnotation axis labels. Severity stays medium: this is a memory cost per axis on multi-chart pages, not a growing leak; the canvases are not in the DOM and are freed at GC after delete. Evidence stays H: when the backing store is allocated (lazily on the first draw in Chromium and Firefox) and how many axes touch the canvas depend on the browser and the app config.

