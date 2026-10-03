# 056 · The error-bar provider draws and pre-processes every data point on each redraw, ignoring the visible index range; on log axes it makes about 20 wasm calls per point

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/DrawingProviders/ErrorSeriesDrawingProvider.js:101` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (pan/zoom) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/caa67b597d5608519fc7fec5c7b9eb69/): reproduced on WebGL and WebGPU ([source](../demos/056-error-bars-full-dataset-per-frame/)) |
| Rule | CNV-21, TASK-13 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
        const dataPointsCount = xDrawValues.size();
        const xView = vectorToArrayViewF64(xDrawValues, this.webAssemblyContext);
        const yView = vectorToArrayViewF64(yDrawValues, this.webAssemblyContext);
        const hView = vectorToArrayViewF64(hDrawValues, this.webAssemblyContext);
        const lView = vectorToArrayViewF64(lDrawValues, this.webAssemblyContext);
        this.args.Reset();
        this.args.SetLinesPen(linesPen);
        this.args.forceShaderMethod = true;
        this.args.verticalChart = renderPassData.isVerticalChart;
        this.args.startIndex = 0;
        this.args.count = dataPointsCount;
```

## Call path and frequency

SciChartRenderer.js:641 builds RenderPassData from ExtremeResamplerHelper.resampleSeries. Error bars do not support resampling (BaseRenderableSeries.js:1167-1176), so it uses pointSeries = rs.toPointSeries() and indicesRange = rs.getIndicesRange(visibleRange) (ExtremeResamplerHelper.js:24-29). FastErrorBarsRenderableSeries.toPointSeries wraps the full data series (:289-295). Then SciChartRenderer.js:354 -> BaseRenderableSeries.js:628 -> ErrorSeriesDrawingProvider.draw (:60). count = xDrawValues.size() over the whole series (:101), DrawLinesVec over all points (:124/:140), and the prepareTempCapVectors(0, all) JS loop (:126/:142 -> :244-283). On a log Y axis the branch at :146-217 instead does, per point, 4 getCoordinate wasm calls (CoordinateCalculatorBase.js:52-53) and up to 3 addLineVertices calls. Each of those makes 2 getVertex calls (SetPosition plus the m_uiColor setter) and 2 push_back calls (:311-321, NativeObject.js:129-142). Rate: per render.

## Why it costs

Every other non-heatmap provider clips to renderPassData.indexRange through getStartAndCount. This one passes startIndex 0 and the full count, although the renderer already computed the visible indicesRange for it (ExtremeResamplerHelper.js:28). The JS cap preparation (prepareTempCapVectors) therefore loops over every point on every render, and the native DrawLinesVec is handed every point. Whether the engine culls off-screen segments before generating vertices is not visible from JS, so the native and GPU share is not established. On a log Y axis the provider instead builds geometry one vertex at a time through embind (getCoordinate x4, then getVertex SetPosition + colour setter + push_back per vertex), for every point in the series. The linear path fills the existing temp vectors through typed-array views and makes one DrawLinesVec call.

**Scale where it matters:** n is the full error-bar data size, not the visible part: 100k bars zoomed to 1k visible still processes 100k per frame. On log axes that is roughly 20 embind calls x n per frame.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/DrawingProviders/ErrorSeriesDrawingProvider.js
+++ b/esm/Charting/Visuals/RenderableSeries/DrawingProviders/ErrorSeriesDrawingProvider.js
@@ draw(renderContext, renderPassData) {
-        const dataPointsCount = xDrawValues.size();
+        // Vertical error bars: clip to the visible X index range with the helper the other providers use.
+        // renderPassData.indexRange is already set for this series (ExtremeResamplerHelper.js:24-29).
+        // Horizontal error bars keep the full range, because a bar whose centre is outside the X range can reach into view.
+        const { startIndex, count: dataPointsCount } = isVerticalDirection
+            ? this.getStartAndCount(renderPassData, xDrawValues)
+            : { startIndex: 0, count: xDrawValues.size() };
@@
-        this.args.startIndex = 0;
+        this.args.startIndex = startIndex;
         this.args.count = dataPointsCount;
@@ (vertical direction)
-                const capCount = this.prepareTempCapVectors(0, dataPointsCount, dataPointWidth, xDrawValues, lDrawValues, hDrawValues, true, hasHighCap, hasLowCap);
+                const capCount = this.prepareTempCapVectors(startIndex, dataPointsCount, dataPointWidth, xDrawValues, lDrawValues, hDrawValues, true, hasHighCap, hasLowCap);
@@ (horizontal direction)
-                const capCount = this.prepareTempCapVectors(0, dataPointsCount, dataPointWidth, yDrawValues, lDrawValues, hDrawValues, false, hasHighCap, hasLowCap);
+                const capCount = this.prepareTempCapVectors(startIndex, dataPointsCount, dataPointWidth, yDrawValues, lDrawValues, hDrawValues, false, hasHighCap, hasLowCap);
@@ (both log loops, :148 and :182)
-                for (let i = 0; i < dataPointsCount; ++i) {
+                for (let i = startIndex; i < startIndex + dataPointsCount; ++i) {
@@ prepareTempCapVectors(...)   // the temp vectors are sized count * s, so the output index must start at 0
-                const outI = i * 4;
+                const outI = (i - startIndex) * 4;
@@
-                const outI = i * 2;
+                const outI = (i - startIndex) * 2;
// drawCaps keeps args.startIndex = 0 and count = capCount, because it reads the compacted temp vectors.
// Log-path follow-up: write the clamped segment end points into tempXVec/tempYVec through vectorToArrayViewF64
// (as prepareTempCapVectors does) and draw them with one DrawLinesVec, instead of getCoordinate + getVertex + push_back per vertex.
```

**Trade-off:** Only vertical error bars are clipped: a horizontal error bar (errorDirection Horizontal) can reach into view from a centre outside the X index range, so that mode keeps the full range. getIndicesRange rounds down and up to the neighbouring points, so whiskers that straddle the edge are still drawn. The log-path rewrite must keep the clamp-to-axis-limit rules at :153-160 and :187-194.

## App-side workaround

Keep error-bar series small, or filter them to the visible window in app code. Avoid log axes with large error-bar series.

## Verify

measure.md#fps, `zoom` then `pan` on a FastErrorBarsRenderableSeries with 100k points zoomed to about 1k visible, on linear and on log Y axes, 5 runs per side. Pass: compare-runs reports 'win' on frameP95Ms, and LoAF script time in ErrorSeriesDrawingProvider.draw drops.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/ErrorSeriesDrawingProvider.js:148` — per-point getCoordinate plus embind vertex loop on log axes
- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/ErrorSeriesDrawingProvider.js:312` — addLineVertices reads xAxis.isVerticalChart and calls push_back for every vertex

## Review notes

- Found by reviewer slice `s04-drawing-providers`.
- Adversarial verification (corrected): Re-read DrawingProviders/ErrorSeriesDrawingProvider.js:60-322. The code_quote matches :101-111 verbatim. Chain: SciChartRenderer.js:354 rs.draw -> BaseRenderableSeries.js:628 dp.draw -> ErrorSeriesDrawingProvider.draw (:60), once per series per render. ErrorBarsSeries is excluded from resampling (BaseRenderableSeries.js:1167-1176), so ExtremeResamplerHelper.resampleSeries returns pointSeries = rs.toPointSeries() (:24-29), and FastErrorBarsRenderableSeries.toPointSeries wraps the whole data series (HlcPointSeriesWrapped, :289-295). It still sets indicesRange = rs.getIndicesRange(visibleRange) (:28), which reaches RenderPassData (SciChartRenderer.js:641), so the visible range is available and ignored. dataPointsCount = xDrawValues.size() (:101), args.startIndex = 0 and args.count = n (:110-111), and DrawLinesVec gets all points (:124/:140). The JS prepareTempCapVectors loop runs over 0..n (:126/:142 -> :244-283). ErrorSeriesDrawingProvider is the only non-heatmap provider in DrawingProviders/ that never calls getStartAndCount. The log-Y branch (:146-217) makes 4 getCoordinate calls per point (CoordinateCalculatorBase.js:52-53 -> nativeCalculator.GetCoordinate; the log calculator does not override it) and up to 3 addLineVertices calls. Each addLineVertices call does 2 x (getVertex: SetPosition + m_uiColor set, NativeObject.js:129-142) + 2 push_back (:311-321), so up to 22 embind calls per point. Corrections: (1) the fix diff clipped every direction, which drops horizontal error bars whose centre lies outside the visible X range but whose bar reaches into view, and padding by one point (the old trade_off) does not fix that. The fix now clips only for errorDirection Vertical; whiskers are at most one point spacing wide, and getIndicesRange already rounds down and up to the neighbouring points (BaseDataSeries.js:767-770). The prepareTempCapVectors outI rebasing is kept; it is needed because the temp vectors are sized count*s (:246-247). (2) why_it_costs no longer asserts that GPU draw cost grows: the native DrawLinesVec receives all n points, but whether it culls off-screen segments is not visible from JS (the same caveat as verified finding 075). The certain parts are the JS cap loop over all n and, on log axes, the per-point embind loop. Severity stays medium: it is per render, but it matters only for large error-bar series viewed zoomed in, consistent with 075. Evidence S for the JS loops.

