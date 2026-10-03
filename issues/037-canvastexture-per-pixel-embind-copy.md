# 037 · CanvasTexture.copyTexture copies pixels into wasm with two embind UIntVector.set() calls per pixel: up to 131,072 boundary calls for one 256x256 gradient

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/TextureManager/CanvasTexture.js:122` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time during series fade animations and resizes (also brush creation time) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
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

For series with fillLinearGradient, do not use FadeAnimation or style animations that change opacity. Use a Sweep, Scale or Wave animation instead, which change the data and not the brush key. Do not animate the gradient stops either: a new fillLinearGradient object is also part of the BrushCache key and rebuilds the texture every frame. There is no workaround for resize-triggered rebuilds.

## Verify

measure.md#fps on a chart with 5 FastMountainRenderableSeries using fillLinearGradient and a fade SeriesAnimation (also a window-resize run), 5 runs per side. Pass: CanvasTexture.copyTexture leaves the __wpProbe.loaf.read() topScripts, and compare-runs shows "win" on frameP95Ms or longFramesPer10s during the animation window.

## Other locations

- `esm/Charting/Visuals/TextureManager/TextureManager.js:358` — createTextureFromCtx has the same aPixels.set(i) loop per pixel; no callers in esm (dead code)
- `esm/Charting/Visuals/TextureManager/CanvasTexture.js:47` — Each CanvasTexture creates a new <canvas> element and context, i.e. one per brush rebuild
- `esm/Charting/Drawing/BrushCache.js:108` — 256x256 gradient rebuilt into a new CanvasTexture whenever opacity or ratio changes

## Review notes

- Found by reviewer slice `s06-axis-text`.
- Adversarial verification (corrected): Re-read esm/Charting/Visuals/TextureManager/CanvasTexture.js:40-135. The code_quote matches :110-124 verbatim, with the first UIntVector.set at the primary line :122 and the second at :123. UIntVector is an embind std::vector (types/types/TSciChart.d.ts:2109, set(index, element)), so each set is one JS-to-wasm embind call. Call path confirmed: MountainSeriesDrawingProvider.draw calls this.createBrush() on every draw (:61), which calls fillBrushCache.create(fill, opacity, textureHeightRatio, textureWidthRatio, fillLinearGradient, customTextureOptions) (:153-163). BrushCache.create (Drawing/BrushCache.js:30-63) returns the cached brush only when all of those are identical (:35-43), otherwise it calls invalidateCache and createGradientBrush -> createGradientTexture -> new CanvasTexture(256, 256) (:108) -> clear -> fillRect -> copyTexture (:123). opacity is part of the key although createGradientTexture never reads it. SeriesAnimation writes rs.opacity on every animation step for style animations with opacity (Animations/SeriesAnimation.js:146-147) and for fade animations (:170-172), so each animation frame rebuilds the gradient brush. The ratios come from domCanvas2D/domMasterCanvas sizes (MountainSeriesDrawingProvider.js:156-161), so a resize that changes them rebuilds too. Column, StackedColumn, Band, PolarBand and BoxPlot providers use the same isMasterCanvasRenderTarget ratio pattern. Every caller of copyTexture runs clear() first (BrushCache :67/:109, BasePointMarker :260/:264/:268, UniformHeatmapDrawingProvider :125, 3D GradientColorPalette :53 and SolidColorBrushPalette :54), so writing 0 for transparent pixels in the fix matches current output. Point markers handle opacity changes with applyOpacity (BasePointMarker.js:363-368, one SCRTMultiplyColorVectorOpacity call) and do not rebuild. other_locations checked: TextureManager.js:358 is aPixels.set inside createTextureFromCtx (:336), which has no caller in esm; CanvasTexture.js:47 and BrushCache.js:108 are correct. Fix checked: little-endian Uint32 view of RGBA gives 0xAABBGGRR; (p & 0xff00ff00) | (R << 16) | B yields (a<<24)|(r<<16)|(g<<8)|b, the same word as the original; HEAPU32 is exported on Module (_glue-pretty/scichart.js:58) and HeatmapHelpers.js:89-92 already writes UIntVectors this way; no wasm allocation happens between taking the view and the last write. Severity stays medium: the rebuild is per frame only inside fade/opacity animation and resize windows, not in steady state. Evidence S: the per-pixel embind calls and the per-frame rebuild during opacity animation follow directly from the code. Corrected app_workaround: animating gradient-stop alpha means assigning a new fillLinearGradient each frame, which is also in the BrushCache key (:40) and rebuilds the texture just the same, so that suggestion was wrong.

