# 006 · SplineRenderDataTransform writes the source index of every interpolated vertex with one wasm call per vertex, on every data change and every pan/zoom frame

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/RenderDataTransforms/SplineRenderDataTransform.js:59` |
| Severity | **high** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/52e645a15c82478c68424114fdc223b3/): reproduced on WebGL and WebGPU ([source](../demos/006-spline-index-fill-wasm-call-per-vertex/)) |
| Rule | TASK-13, SC-06, SC-12 (web-performance skill) |
| Effort to fix | small |

## Code

```js
    populateSourceIndexes() {
        const size = this.pointSeries.xValues.size();
        const intPoints2 = this.interpolationPoints + 1;
        const indexes = this.pointSeries.indexes;
        indexes.resizeFast(size);
        for (let k = 0; k < size; k++) {
            indexes.set(k, Math.floor(k / intPoints2));
        }
    }
```

## Call path and frequency

SciChartRenderer.js:354 -> BaseRenderableSeries.js:624 renderDataTransform.runTransform -> BaseRenderDataTransform.runTransform (BaseRenderDataTransform.js:31-41) -> SplineRenderDataTransform.runTransformInternal (:14) -> populateSourceIndexes (:42, or :30 for the NaN path) -> indexes.set per vertex (:59). The transform reruns when the data changed, when renderPassData.indexRange differs from the last one (every pan frame), or when the resampling hash changed. Because useForYRange = true (:9), getYRange also reaches it through updateTransformedValues (BaseRenderableSeries.js:694-695 -> :1285). With a Y autorange and a moving X window it can therefore run twice per frame (hypothesis). Rate: per redraw during pan, zoom or streaming, for SplineLine and SplineMountain series (SplineLineRenderableSeries.js:55, SplineMountainRenderableSeries.js:53).

## Why it costs

indexes is an SCRTDoubleVector. Each .set(k, v) goes through the embind method wrapper (argument count, this-pointer validation, wire conversion) and a wasm call, instead of a plain store into linear memory. The rest of the transform is a single bulk wasm call (SCRTSplineHelperCubicSpline), so this loop is the JS-side cost that grows with the output. For unresampled input the spline covers every point regardless of indexRange, so rerunning on each indexRange change recomputes an identical result.

**Scale where it matters:** Output size = transform input points x (interpolationPoints + 1), which is 11x by default. The input is the whole data series when it is not resampled (rs.toPointSeries(), ExtremeResamplerHelper.js:24-29 and :64-69). When it is resampled (spline series keep the default supportsResampling), the input is the resampled set, which scales with the viewport width. 10k input points means about 110k embind calls per run, on every pan or zoom frame that moves the visible index window.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/RenderDataTransforms/SplineRenderDataTransform.js
+++ b/esm/Charting/Visuals/RenderableSeries/RenderDataTransforms/SplineRenderDataTransform.js
+import { vectorToArrayViewF64 } from "../../../../utils/vectorToArray";
@@ populateSourceIndexes() {
         const size = this.pointSeries.xValues.size();
         const intPoints2 = this.interpolationPoints + 1;
         const indexes = this.pointSeries.indexes;
         indexes.resizeFast(size);
+        if (size === 0)
+            return;
+        // take the view after resizeFast (a heap grow detaches older views); nothing below allocates in wasm
+        const indexView = vectorToArrayViewF64(indexes, this.wasmContext);
         for (let k = 0; k < size; k++) {
-            indexes.set(k, Math.floor(k / intPoints2));
+            indexView[k] = Math.floor(k / intPoints2);
         }
     }
// Optional follow-up: override runTransform so that, when the input is not resampled and only indexRange
// changed, it reuses this.pointSeries. It must still rerun when pointSeries.resampled flips.
```

**Trade-off:** Writing through the view needs no trade-off: the values are identical. The optional rerun skip must track the last pointSeries.resampled value so it still reruns when the input switches between resampled and unresampled data.

## App-side workaround

Lower interpolationPoints (SC-12), or use a plain FastLineRenderableSeries for dense data.

## Verify

measure.md#fps, `pan` and `stream` on a SplineLineRenderableSeries with 10k points (interpolationPoints 10), 5 runs per side. Pass: compare-runs reports 'win' on frameP95Ms, and the self time of populateSourceIndexes in the traced window (trace-summary top functions, LoAF script attribution) drops to near zero.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/RenderDataTransforms/BaseRenderDataTransform.js:32` — a single-slot rerun key: any indexRange change reruns the transform
- `esm/Charting/Visuals/RenderableSeries/BaseRenderableSeries.js:1285` — second runTransform call from Y-range calculation (useForYRange)

## Review notes

- Found by reviewer slice `s04-drawing-providers`.
- Adversarial verification (corrected): Re-read SplineRenderDataTransform.js:1-62: code_quote matches lines 53-61 verbatim (primary :59). indexes is the output point series' SCRTDoubleVector (createPointSeries :11-13 -> XyPointSeriesResampled; BasePointSeriesResampled.js:14 `new wasmContext.SCRTDoubleVector()`), and set(_iIndex, _dValue) is an embind method (types/types/TSciChart.d.ts:474). The loop therefore makes one embind call per output vertex. Caller chain: SciChartRenderer.js:354 -> BaseRenderableSeries.draw :593 -> renderDataTransform.runTransform :624 -> BaseRenderDataTransform.runTransform :29-56. The rerun gate is requiresTransform OR indexRange != lastIndexRange OR resamplingHash changed (:31-33). renderPassData.indexRange is rp.indexesRange or getIndicesRange(xAxis.visibleRange) (ExtremeResamplerHelper.js:17-69, SciChartRenderer.js:641), so it changes on pan and zoom frames whenever the visible index window moves. -> runTransformInternal :14 -> populateSourceIndexes :42 (or :30 on the NaN path). The transform is wired in SplineLineRenderableSeries.js:55 and SplineMountainRenderableSeries.js:53. The Y-range path (getYRange BaseRenderableSeries.js:694-695 -> updateTransformedValues -> :1285) also calls runTransform. getResampledPointSeries can replace currentRenderPassData with a new indexRange first (:715-720), so a second run per frame is plausible but not certain; it stays marked as a hypothesis. No cache or early return protects the loop once the transform reruns. SC-06 and TASK-13 both name per-item get/set across the wasm boundary as the thing to avoid, and nothing in their Avoid fields excuses it here. Fix checked: vectorToArrayViewF64 (utils/vectorToArray.js:74-87) builds a Float64Array over HEAPF64 at dataPtr(0) with size(). It is taken after resizeFast, and nothing in the loop allocates, so the view cannot be detached. If resizeFast could not grow (it returns the size reached), out-of-range typed-array writes are no-ops, which is safer than the current set(). The import path ../../../../utils/vectorToArray resolves to esm/utils/vectorToArray, and this.wasmContext is set in the base constructor (:23). Severity high is kept: per pan, zoom or stream frame x per output vertex. Evidence S is kept. CORRECTED scale only. Spline series keep the default supportsResampling (BaseRenderableSeries.js:1167), so the transform input is the whole data series when it is not resampled (rs.toPointSeries()) and the resampled set when it is. The output is that input x (interpolationPoints + 1).

