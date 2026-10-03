# 071 · Every axis owns two 1920x1080 willReadFrequently scratch canvases (axis renderer and title renderer), each about 7.9 MiB of CPU bitmap once used

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/TextureManager/TextureManager.js:23` |
| Severity | **medium** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
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

Runs once per axis, and again on each switchAxisRenderer: the AxisBase2D constructor creates AxisTitleRenderer (esm/Charting/Visuals/Axis/AxisBase2D.js:503 → esm/Charting/Services/TitleRenderer.js:44 new TextureManager) and the axis renderer (AxisBase2D.createAxisRender:1069 → esm/Charting/Visuals/Axis/AxisRenderer.js:45 new TextureManager) → TextureManager.js:23-26. Each surface title renderer adds one more. The backing store is allocated on the first 2D operation, which comes from canvas-text labels and titles (useNativeText:false) or from the per-frame annotation and modifier label paths (also on the default native-text path).

## Why it costs

Rasterization is synchronous on the main thread and every create call clears and reads back immediately, so one scratch canvas per page is enough. Instead, scratch memory scales with the number of axes, and the canvases stay alive until garbage collection after delete(): TextureManager.delete drops the references but never sets width and height to 0 (CNV-24). getTextureContext can grow the canvas and never shrinks it.

**Scale where it matters:** 1920 x 1080 x 4 bytes ≈ 7.9 MiB per canvas once drawn. A 20-chart dashboard in canvas-text mode with axis titles has 2 axes x 2 canvases + 1 title canvas = 5 per chart, up to about 100 canvases (≈ 790 MiB). In the default native-text mode, each axis that carries an AxisMarkerAnnotation, labelled line annotation or filled modifier label costs one 7.9 MiB canvas.

## Fix (library side)

```diff
--- esm/Charting/Visuals/TextureManager/TextureManager.js
+// one CPU-backed scratch canvas for every TextureManager on the page: each create call
+// sets its state, clears the rectangle it reads and reads back synchronously
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
```

**Trade-off:** All TextureManagers share one mutable 2D context. This is safe because each create call sets its own state and reads back synchronously, but a custom subclass that keeps content in textureManager.canvas across calls would break. One 1920x1080 bitmap per page remains once used. Starting smaller and growing on demand would cut that too, but resizing resets context state, so font, fill and alpha must be re-applied after a grow.

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
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

