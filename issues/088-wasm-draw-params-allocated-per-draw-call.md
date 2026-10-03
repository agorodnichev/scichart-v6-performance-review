# 088 · WebGlRenderContext2D constructs and deletes a wasm Draw*Params object on every draw call, where one cached instance per entry point would do

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Drawing/WebGlRenderContext2D.js:357` |
| Severity | **low** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/4f2995f0c5ffcec17848f04d4620befe/): reproduced on WebGL and WebGPU ([source](../demos/088-wasm-draw-params-per-draw/)) |
| Rule | none (web-performance skill) |
| Effort to fix | medium |

## Code

```js
        const drawParams = new this.webAssemblyContext.SCRTDrawPrimitivesParams();
        drawParams.SetVerticesVec(quadVerts);
        drawParams.SetBrush(brush);
        nativeContext.DrawPrimitives(drawParams);
        brush === null || brush === void 0 ? void 0 : brush.delete();
        drawParams.delete();
```

## Call path and frequency

SciChartRenderer.render -> renderContext.drawLayers (esm/Charting/Services/SciChartRenderer.js:305) -> per-annotation drawFn (:429) -> BoxAnnotation.drawWithContext (esm/Charting/Visuals/Annotations/BoxAnnotation.js:146/151, fill-only or dashed boxes) -> WebGlRenderContext2D.drawRect (:417-435); LineAnnotation.js:296 -> drawLine (:249-275); drawLabel.js:41/57, NativeAxisRenderer.js:79, TextureAxisRenderer.js:21 (useNativeText:false), TitleRenderer.js:110 -> drawTexture (:344-363). Once per draw call: per render-context annotation, per texture label, per border or band, on every rendered frame.

## Why it costs

Each `new wasmContext.X()` is an embind constructor: a JS-to-wasm call, a C++ malloc and constructor, and a JS handle built by makeClassHandle with Object.create plus record objects (_glue-pretty/scichart.js:4256-4268). Each delete() calls detachFinalizer (FinalizationRegistry.unregister once a registry exists) and the raw destructor, another crossing and a free (_glue-pretty/scichart.js:3982-3994, 3723-3757). These params are scratch blocks that the engine reads only during the Draw* call; the current code deletes them immediately after, so one cached instance per entry point does the same job. The library already does this for SCRTDictTextParams (NativeObject.js:217-239, 'one cached instance keeps the per-label draw allocation-free') and the vertex vectors. The saving is 2 of roughly 10 JS-to-wasm crossings per draw call and excludes the GPU-side work, hence low and H.

**Scale where it matters:** Matters only with hundreds of render-context annotations (fill-only or dashed BoxAnnotations, LineAnnotations, arrows), or with texture-mode axis labels (useNativeText:false) on surfaces that redraw at display rate. With the defaults (native-text axes, a few annotations) it is tens of constructions per frame.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/Helpers/NativeObject.js
+++ b/esm/Charting/Visuals/Helpers/NativeObject.js
@@ getCache
             dictTextParams: undefined,
             arcParams: undefined,
+            drawPrimitivesParams: undefined,
+            drawRectsParams: undefined,
+            drawLinesParams: undefined,
             keyCache: new Map()
@@ deleteCache
         deleteSafe(cache.dictTextParams);
+        deleteSafe(cache.drawPrimitivesParams);
+        deleteSafe(cache.drawRectsParams);
+        deleteSafe(cache.drawLinesParams);
@@
+// Scratch params blocks: the engine reads them only during the Draw* call (callers already delete them right after it)
+export const getDrawPrimitivesParams = (wasmContext) => {
+    const cache = getCache(wasmContext);
+    return cache.drawPrimitivesParams || (cache.drawPrimitivesParams = new wasmContext.SCRTDrawPrimitivesParams());
+};
+export const getDrawRectsParams = (wasmContext) => {
+    const cache = getCache(wasmContext);
+    return cache.drawRectsParams || (cache.drawRectsParams = new wasmContext.SCRTDrawRectsParams());
+};
+export const getDrawLinesParams = (wasmContext) => {
+    const cache = getCache(wasmContext);
+    return cache.drawLinesParams || (cache.drawLinesParams = new wasmContext.SCRTDrawLinesParams());
+};
--- a/esm/Charting/Drawing/WebGlRenderContext2D.js
+++ b/esm/Charting/Drawing/WebGlRenderContext2D.js
@@ drawTexture (:357-362), same in drawTriangleStrip (:327-331)
-        const drawParams = new this.webAssemblyContext.SCRTDrawPrimitivesParams();
+        const drawParams = getDrawPrimitivesParams(this.webAssemblyContext);
         drawParams.SetVerticesVec(quadVerts);
         drawParams.SetBrush(brush);
         nativeContext.DrawPrimitives(drawParams);
         brush === null || brush === void 0 ? void 0 : brush.delete();
-        drawParams.delete();
@@ drawRects (:107), drawRotatedRect (:407), drawRect (:429): each sets vertices, brush and anchor
-        const drawRectsParams = new this.webAssemblyContext.SCRTDrawRectsParams();
+        const drawRectsParams = getDrawRectsParams(this.webAssemblyContext);
 ...
-        drawRectsParams === null || drawRectsParams === void 0 ? void 0 : drawRectsParams.delete();
@@ drawLinesNative (:84), drawLine (:267), drawLines (:298): each sets m_Type, pen and points
-        const drawLineParams = new this.webAssemblyContext.SCRTDrawLinesParams();
+        const drawLineParams = getDrawLinesParams(this.webAssemblyContext);
 ...
-        drawLineParams.delete();
# Leave drawEllipses (:118, sets pen, brush null and m_bIsEllipses = true) on its own per-call instance so the shared rects params never inherit those fields. Keep the per-call SCRTTextureBrush in drawTexture: callers delete the texture right after the draw, so a cached brush would outlive its texture.
```

**Trade-off:** Adds three long-lived wasm objects per context, released in deleteCache (context loss and chart cleanup already call it). A cached params block keeps a stale brush/pen pointer between draws; every entry point sets brush/pen before each Draw*, and today's code already lets the params outlive the brush briefly (brush.delete() before drawParams.delete()), so the destructor does not dereference it. This still relies on the engine not touching the previous pointer inside SetBrush/SetPen, which only the C++ source can confirm. Batching texture labels into one draw needs an atlas and is a larger change.

## App-side workaround

Keep SciChartDefaults.useNativeText true so axis labels do not go through drawTexture. Keep the number of render-context annotations low, for example draw many boxes as one rectangle/column series instead of BoxAnnotations.

## Verify

measure.md#fps, `pan` scenario with 500 fill-only BoxAnnotations and a second run with useNativeText:false on 4 axes, 5 runs per side. In a dev build, count embind constructions of SCRTDraw*Params in window.__perf.counters(). Pass: the counter stays flat after the first frame; compare-runs gives 'win' or neutral on frameP95Ms. Not measured; a neutral verdict keeps it only as a consistency change.

## Other locations

- `esm/Charting/Drawing/WebGlRenderContext2D.js:429` — drawRect: new SCRTDrawRectsParams per call (fill-only or dashed BoxAnnotation, BoxAnnotation.js:146/151); its stroke goes through drawLines (:298 new SCRTDrawLinesParams)
- `esm/Charting/Drawing/WebGlRenderContext2D.js:267` — drawLine: new SCRTDrawLinesParams (LineAnnotation.js:296, drawLabel.js:31)
- `esm/Charting/Drawing/WebGlRenderContext2D.js:107` — drawRects (borders, axis bands, sub-chart background)
- `esm/Charting/Drawing/WebGlRenderContext2D.js:327` — drawTriangleStrip
- `esm/Charting/Drawing/WebGlRenderContext2D.js:407` — drawRotatedRect (native text backgrounds)
- `esm/Charting/Drawing/WebGlRenderContext2D.js:84` — drawLinesNative (axis gridlines)
- `esm/Charting/Visuals/Annotations/BoxAnnotation.js:353` — stroked, undashed BoxAnnotations use drawWithProvider instead, which also constructs a new SCRTColumnDrawingParams per draw (same pattern, outside the render context)

## Review notes

- Found by reviewer slice `s01-surface-render`.
- Adversarial verification (corrected): Quote matches verbatim at WebGlRenderContext2D.js:357-362 (primary moved from :346 to :357; :346 brush noted). Listed every per-call embind construction in the file with rg (:84, :107, :118, :153, :267, :298, :327, :346, :357, :407, :429). Read the glue: makeClassHandle (:4256-4268) uses Object.create with a descriptor; attachFinalizer registers only smart pointers, but delete() always calls detachFinalizer -> FinalizationRegistry.unregister once a registry exists (:3723-3757, :3982-3994). Corrected the scale example: a stroked, undashed BoxAnnotation goes through drawWithProvider (BoxAnnotation.js:146-148, :351) with its own per-draw SCRTColumnDrawingParams, not drawRect; drawRect is used for fill-only or dashed boxes. Narrowed the fix to the params objects only: the reviewer's cached SCRTTextureBrush (SetTexture exists in types/types/TSciChart.d.ts:1241) would outlive the texture that drawLabel.js/NativeAxisRenderer delete right after the draw, an ordering the engine is not exercised with today; drawEllipses stays separate because it sets m_bIsEllipses and the pen. Downgraded medium to low: the removable work is 2 of about 10 crossings per draw call, and the default configuration issues only tens of such calls per frame.

