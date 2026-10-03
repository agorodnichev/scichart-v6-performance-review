# 056 · The error-bar provider draws and pre-processes every data point on each redraw, ignoring the visible index range; on log axes it makes about 20 wasm calls per point

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/DrawingProviders/ErrorSeriesDrawingProvider.js:101` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (pan/zoom) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
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

SciChartRenderer.js:354 -> BaseRenderableSeries.js:628 -> ErrorSeriesDrawingProvider.draw (:60). count = xDrawValues.size() over the whole series, because FastErrorBarsRenderableSeries.toPointSeries always wraps the full data series and never resamples (FastErrorBarsRenderableSeries.js:289-295). It then calls DrawLinesVec over all points (:124/:140) and runs the prepareTempCapVectors(0, all) JS loop (:126/:142 -> :244-283). On a log axis the branch at :146-217 instead does, per point, 4 getCoordinate wasm calls (CoordinateCalculatorBase.js:52-53) and up to 3 addLineVertices calls. Each of those makes 2 getVertex calls, and each getVertex call does a SetPosition, an m_uiColor setter and a push_back (:311-321, NativeObject.js:129-142). Rate: per redraw.

## Why it costs

Every other provider clips to renderPassData.indexRange through getStartAndCount. This one passes startIndex 0 and the full count, so CPU preparation, vertex generation and the GPU draw all grow with the dataset when zoomed in. The log path also builds geometry one vertex at a time through embind. The linear path instead fills the existing temp vectors through typed-array views and makes one DrawLinesVec call.

**Scale where it matters:** n is the full error-bar data size, not the visible part: 100k bars zoomed to 1k visible still processes 100k per frame. On log axes that is roughly 20 embind calls x n per frame.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/DrawingProviders/ErrorSeriesDrawingProvider.js
+++ b/esm/Charting/Visuals/RenderableSeries/DrawingProviders/ErrorSeriesDrawingProvider.js
@@ draw(renderContext, renderPassData) {
-        const dataPointsCount = xDrawValues.size();
+        // visible index range, the same helper the other providers use (FastErrorBars is never resampled)
+        const { startIndex, count: dataPointsCount } = this.getStartAndCount(renderPassData, xDrawValues);
@@
-        this.args.startIndex = 0;
+        this.args.startIndex = startIndex;
         this.args.count = dataPointsCount;
@@ (both directions)
-                const capCount = this.prepareTempCapVectors(0, dataPointsCount, dataPointWidth, xDrawValues, lDrawValues, hDrawValues, true, hasHighCap, hasLowCap);
+                const capCount = this.prepareTempCapVectors(startIndex, dataPointsCount, dataPointWidth, xDrawValues, lDrawValues, hDrawValues, true, hasHighCap, hasLowCap);
@@ (both log loops)
-                for (let i = 0; i < dataPointsCount; ++i) {
+                for (let i = startIndex; i < startIndex + dataPointsCount; ++i) {
@@ prepareTempCapVectors(...)
-                const outI = i * 4;
+                const outI = (i - startIndex) * 4;
@@
-                const outI = i * 2;
+                const outI = (i - startIndex) * 2;
// Log path follow-up: write the clamped segment end points into tempXVec/tempYVec through vectorToArrayViewF64
// (as prepareTempCapVectors does) and draw with one DrawLinesVec, instead of getCoordinate + getVertex + push_back per vertex.
```

**Trade-off:** A horizontal error bar (errorDirection Horizontal) can reach into view from a centre outside the X index range. Pad startIndex/count by one point or skip clipping in that mode. The log-path rewrite must keep the clamp-to-axis-limit rules at :153-160 and :187-194.

## App-side workaround

Keep error-bar series small, or filter them to the visible window in app code. Avoid log axes with large error-bar series.

## Verify

measure.md#fps, `zoom` then `pan` on a FastErrorBarsRenderableSeries with 100k points zoomed to about 1k visible, on linear and on log Y axes, 5 runs per side. Pass: compare-runs reports 'win' on frameP95Ms, and LoAF script time in ErrorSeriesDrawingProvider.draw drops.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/ErrorSeriesDrawingProvider.js:148` — per-point getCoordinate plus embind vertex loop on log axes
- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/ErrorSeriesDrawingProvider.js:312` — addLineVertices reads xAxis.isVerticalChart and calls push_back for every vertex

## Review notes

- Found by reviewer slice `s04-drawing-providers`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

