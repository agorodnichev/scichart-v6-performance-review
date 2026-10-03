# 037 · CanvasTexture.copyTexture copies pixels into wasm with two embind UIntVector.set() calls per pixel: up to 131,072 boundary calls for one 256x256 gradient

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/TextureManager/CanvasTexture.js:122` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time during series fade animations and resizes (also brush creation time) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | SC-06, TASK-13 (web-performance skill) |
| Effort to fix | small |

## Code

```js
        const size = this.width * this.height;
        for (let i = 0; i < size; i++) {
            const el = i * 4;
            const a = imageArr[el + 3];
            // Only set pixels that are not alpha=0
            if (a !== 0) {
                const r = imageArr[el];
                const g = imageArr[el + 1];
                const b = imageArr[el + 2];
                // tslint:disable-next-line:no-bitwise
                const pixel = (a << 24) | (r << 16) | (g << 8) | b;
                // tslint:disable-next-line:no-bitwise
                this.intermediateVector.set(i, pixel >>> 0);
                this.originalIntermediateVector.set(i, pixel >>> 0);
            }
```

## Call path and frequency

MountainSeriesDrawingProvider.draw → createBrush (esm/Charting/Visuals/RenderableSeries/DrawingProviders/MountainSeriesDrawingProvider.js:61, every draw) → BrushCache.create (esm/Charting/Drawing/BrushCache.js:30). The brush is rebuilt whenever fill, opacity, textureHeightRatio or textureWidthRatio changes → createGradientTexture: new CanvasTexture(256, 256) (BrushCache.js:108) and copyTexture (BrushCache.js:123) → CanvasTexture.js:99-128. Frequency: once per frame per gradient series while SeriesAnimation sets rs.opacity on each animation step (esm/Charting/Visuals/RenderableSeries/Animations/SeriesAnimation.js:147/171); once per frame during a resize, when the master-canvas ratio changes; and on every fill change. The same applies to Column, Band and StackedColumn providers and to custom-texture brushes (BrushCache.js:66/74). BasePointMarker.createCanvasTexture (BasePointMarker.js:259-274) builds 3 small CanvasTextures per style change.

## Why it costs

Each UIntVector.set is an embind method call. The JS wrapper validates `this`, converts both arguments and calls into wasm, once per pixel per vector. The same file family already has a bulk path: TextureManager.createTextureFromImageData uses HEAP8.set, and HeatmapHelpers.js:92-94 uses a HEAPU32 subarray at dataPtr. Here the per-pixel boundary crossings, not the swizzle arithmetic, dominate a rebuild.

**Scale where it matters:** A 256x256 gradient texture is 65,536 pixels, all opaque, so 131,072 embind method calls per gradient brush build. Each rebuild also creates a new <canvas> element, a 2D context, a getImageData copy and two 65,536-element UIntVectors.

## Fix (library side)

```diff
--- esm/Charting/Visuals/TextureManager/CanvasTexture.js (copyTexture)
         const imageArr = imageData.data;
-        const size = this.width * this.height;
-        for (let i = 0; i < size; i++) {
-            const el = i * 4;
-            const a = imageArr[el + 3];
-            if (a !== 0) {
-                const r = imageArr[el];
-                const g = imageArr[el + 1];
-                const b = imageArr[el + 2];
-                const pixel = (a << 24) | (r << 16) | (g << 8) | b;
-                this.intermediateVector.set(i, pixel >>> 0);
-                this.originalIntermediateVector.set(i, pixel >>> 0);
-            }
-        }
+        // swizzle RGBA bytes to ARGB words straight into wasm memory: no embind call per pixel
+        const size = this.width * this.height;
+        const src = new Uint32Array(imageArr.buffer, imageArr.byteOffset, size); // 0xAABBGGRR (little-endian)
+        const heap = this.wasmContext.HEAPU32; // view taken after the last wasm allocation
+        const dstStart = this.intermediateVector.dataPtr(0) / Uint32Array.BYTES_PER_ELEMENT;
+        const dst = heap.subarray(dstStart, dstStart + size);
+        for (let i = 0; i < size; i++) {
+            const p = src[i];
+            dst[i] = p >>> 24 ? ((p & 0xff00ff00) | ((p & 0xff) << 16) | ((p >>> 16) & 0xff)) >>> 0 : 0;
+        }
+        heap.set(dst, this.originalIntermediateVector.dataPtr(0) / Uint32Array.BYTES_PER_ELEMENT);
```

**Trade-off:** Relies on HEAPU32 views, which must be taken after the last wasm allocation in the function because memory growth detaches them. Fully transparent pixels are written as 0 instead of being skipped; this matches current output because every caller (BrushCache, BasePointMarker) runs clear() first. Separately, in BrushCache (out of this slice), the gradient brush ignores opacity, yet opacity is part of its cache key, so fade animations rebuild an identical texture every frame.

## App-side workaround

Do not animate opacity on gradient-filled series: animate the alpha in the gradient stops or the data instead. There is no workaround for resize-triggered rebuilds.

## Verify

measure.md#fps on a chart with 5 FastMountainRenderableSeries using fillLinearGradient and a fade SeriesAnimation (also a window-resize run), 5 runs per side. Pass: CanvasTexture.copyTexture leaves the __wpProbe.loaf.read() topScripts, and compare-runs shows "win" on frameP95Ms or longFramesPer10s during the animation window.

## Other locations

- `esm/Charting/Visuals/TextureManager/TextureManager.js:358` — createTextureFromCtx has the same aPixels.set(i) loop per pixel; no callers in esm (dead code)
- `esm/Charting/Visuals/TextureManager/CanvasTexture.js:47` — Each CanvasTexture creates a new <canvas> element and context, i.e. one per brush rebuild
- `esm/Charting/Drawing/BrushCache.js:108` — 256x256 gradient rebuilt into a new CanvasTexture whenever opacity or ratio changes

## Review notes

- Found by reviewer slice `s06-axis-text`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

