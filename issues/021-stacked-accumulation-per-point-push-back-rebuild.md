# 021 · Stacked collections rebuild every accumulated vector with per-point embind push_back calls on every data change

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/StackedXyCollection.js:79` |
| Severity | **high** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (stream; also INP when data changes come from input) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | SC-01, SC-06, V8-01 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
                visibleSeries.forEach((rs, index) => {
                    let currentY = yValueArrayViews[index][rawIndexers[index](i)];
                    if (this.isOneHundredPercent) {
                        currentY = currentY >= 0
                            ? (positiveTotal !== 0 ? (currentY / positiveTotal) * 100 : 0)
                            : (negativeTotal !== 0 ? (currentY / Math.abs(negativeTotal)) * 100 : 0);
                    }
                    if (currentY >= 0) {
                        rs.bottomAccumulatedValues.push_back(positiveAccum);
                        const top = positiveAccum + currentY;
                        rs.accumulatedValues.push_back(top);
                        positiveAccum = top;
```

## Call path and frequency

App appendRange/update on any child data series -> dataChanged -> BaseStackedRenderableSeries.dataSeriesDataChanged (esm/Charting/Visuals/RenderableSeries/BaseStackedRenderableSeries.js:49-51) -> notifyPropertyChanged(DATA_SERIES) (:97-101) -> StackedXyCollection.notifyPropertyChanged sets isAccumulatedVectorDirty (StackedXyCollection.js:254-261) -> next frame SciChartRenderer.render (esm/Charting/Services/SciChartRenderer.js:127) -> SciChartSurface.updateStackedCollectionAccumulatedVectors (esm/Charting/Visuals/SciChartSurface.js:760-762) -> StackedXyCollection.updateAccumulatedVectors (StackedXyCollection.js:33-115): for each of N points, accumulatedValues0.push_back (:54) and per visible series 2 push_back (:79/:81 or :86/:87) plus rawIndexers[index](i) (:72); a FIFO source adds N more push_back in buildUnwoundXValues (:141-143). StackedColumnCollection.updateAccumulatedVectors (StackedColumnCollection.js:104-186) is the same, plus Object.keys(seriesGroups) and forEach closures per point (:128). Rate: once per frame in which any child changed, so every frame while streaming. Work: O(N x S) JS iterations and N x (2S+1) JS->wasm calls, where N is the full series length (stacked series are never resampled: BaseRenderableSeries.supportsResampling requires !isStacked).

## Why it costs

Each push_back is an embind method call. The generated invoker (_glue-pretty/scichart.js:4648, craftInvokerFunction -> invokerFn) allocates a rest-args array and an onDone closure, converts and validates `this`, then crosses into wasm, for every single value. The loop also recomputes every stacked sum from scratch, but stacking at index i reads only index i, so an append changes only the new indices: the cost follows the history length, not the new data. The library already has the bulk pattern (resizeFast + HEAPF64 writes in utils/ccall/appendDoubleVectorFromJsArray.js:25-47).

**Scale where it matters:** A streaming stacked mountain or column chart: S = 5 layers x N = 100k points (fifoCapacity) gives about 1.1M embind push_back calls and 500k closure calls per data change, i.e. per frame while data streams. It starts to matter from about N x S >= 10^5 at one update per frame.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/StackedXyCollection.js
+++ b/esm/Charting/Visuals/RenderableSeries/StackedXyCollection.js
@@ updateAccumulatedVectors() {
         this.checkXValuesCorrect();
         this.isAccumulatedVectorDirty = false;
-        this.clearAccumulatedVectors(dataValuesCount);
-        const visibleSeries = this.getVisibleSeries();
-        const yValueArrayViews = visibleSeries.map(cur => vectorToArrayViewF64(cur.dataSeries.getNativeYValues(), this.webAssemblyContext));
-        const rawIndexers = visibleSeries.map(cur => { /* closure per series */ });
-        this.buildUnwoundXValues(dataValuesCount);
+        const wasm = this.webAssemblyContext;
+        const separate = this.separatePositiveNegativeStacksProperty;
+        const visibleSeries = this.getVisibleSeries();
+        // 1) every allocation first: a wasm heap growth detaches views taken earlier
+        this.clearAccumulatedVectors(dataValuesCount);          // clear() + reserve(), unchanged
+        this.accumulatedValues0.resizeFast(dataValuesCount);     // check returned size as assertVectorResized does
+        for (const rs of visibleSeries) {
+            rs.accumulatedValues.resizeFast(dataValuesCount);
+            if (separate) rs.bottomAccumulatedValues.resizeFast(dataValuesCount);
+        }
+        this.buildUnwoundXValues(dataValuesCount);               // same change inside: resizeFast(n) + HEAPF64.set of the two wrapped halves
+        // 2) then the views, and plain indexed writes (no wasm call per value)
+        const yViews = visibleSeries.map(rs => vectorToArrayViewF64(rs.dataSeries.getNativeYValues(), wasm));
+        const tops = visibleSeries.map(rs => vectorToArrayViewF64(rs.accumulatedValues, wasm));
+        const bottoms = separate ? visibleSeries.map(rs => vectorToArrayViewF64(rs.bottomAccumulatedValues, wasm)) : undefined;
+        const starts = visibleSeries.map(rs => rs.dataSeries.fifoCapacity > 0 && !rs.dataSeries.fifoSweeping ? rs.dataSeries.fifoStartIndex : 0);
+        vectorToArrayViewF64(this.accumulatedValues0, wasm).fill(0);
+        const S = visibleSeries.length;
         for (let i = 0; i < dataValuesCount; i++) {
-            this.accumulatedValues0.push_back(0);
-            if (this.separatePositiveNegativeStacksProperty) {
+            if (separate) {
                 /* 100% totals: same math, reading yViews[s][(i + starts[s]) % dataValuesCount] in a for loop */
                 let positiveAccum = 0;
                 let negativeAccum = 0;
-                visibleSeries.forEach((rs, index) => {
-                    let currentY = yValueArrayViews[index][rawIndexers[index](i)];
+                for (let s = 0; s < S; s++) {
+                    let currentY = yViews[s][(i + starts[s]) % dataValuesCount];
                     /* 100% normalisation unchanged */
                     if (currentY >= 0) {
-                        rs.bottomAccumulatedValues.push_back(positiveAccum);
+                        bottoms[s][i] = positiveAccum;
                         const top = positiveAccum + currentY;
-                        rs.accumulatedValues.push_back(top);
+                        tops[s][i] = top;
                         positiveAccum = top;
                     } else {
                         const bottom = negativeAccum + currentY;
-                        rs.bottomAccumulatedValues.push_back(bottom);
-                        rs.accumulatedValues.push_back(negativeAccum);
+                        bottoms[s][i] = bottom;
+                        tops[s][i] = negativeAccum;
                         negativeAccum = bottom;
                     }
-                    if (rs.renderDataTransform) { rs.renderDataTransform.requiresTransform = true; }
-                });
+                }
             } else {
-                /* ... */ rs.accumulatedValues.push_back(current);
+                /* same running sum in a for loop */ tops[s][i] = current;
             }
         }
+        for (const rs of visibleSeries) { if (rs.renderDataTransform) rs.renderDataTransform.requiresTransform = true; }

--- a/esm/Charting/Visuals/RenderableSeries/StackedColumnCollection.js (updateAccumulatedVectors :104-186)
 same change; also hoist `const keys = Object.keys(seriesGroups)` and the per-group series/view arrays out of the i-loop and replace the forEach closures with for loops.

Next step (optional): for append-only changes on non-FIFO sources, recompute only [oldCount, newCount), because stacking at index i reads only index i.
```

**Trade-off:** Writes go directly into wasm memory through Float64Array views, so every allocation (resizeFast, the FIFO X unwind) must happen before any view is taken; the current code takes the source views before buildUnwoundXValues reserves, so the fix also removes a latent detached-view hazard. resizeFast can return a short size on out-of-memory and must be checked. The non-separate mode must leave bottomAccumulatedValues empty, as today (computeYRange checks its size). The incremental-append step adds index-range bookkeeping and does not apply to FIFO wrap.

## App-side workaround

Keep N small (fifoCapacity sized to the visible window) and give each child at most one appendRange per frame (SC-02) so the rebuild runs once per frame. For long live stacks, compute the running sums in the app into Float64Arrays and draw each layer as a FastBandRenderableSeries (y = top, y1 = bottom) fed with appendRange; band series are resampled and only the new points cross into wasm.

## Verify

measure.md#fps, `stream` scenario: a StackedMountainCollection with 5 series, fifoCapacity 100k, one appendRange per series per frame for 10 s, 5 runs per side. Pass: compare-runs verdict 'win' on frameP95Ms and longFramesPer10s; LoAF topScripts time attributed to updateAccumulatedVectors goes down; a screenshot of the stack matches the baseline. Not measured.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/StackedXyCollection.js:54` — accumulatedValues0.push_back(0) once per point
- `esm/Charting/Visuals/RenderableSeries/StackedXyCollection.js:107` — non-separate branch: push_back per point per series
- `esm/Charting/Visuals/RenderableSeries/StackedXyCollection.js:142` — buildUnwoundXValues: push_back per point for FIFO sources
- `esm/Charting/Visuals/RenderableSeries/StackedXyCollection.js:91` — renderDataTransform.requiresTransform assigned N x S times inside the loop
- `esm/Charting/Visuals/RenderableSeries/StackedColumnCollection.js:128` — Object.keys(seriesGroups).forEach(...) allocated per point
- `esm/Charting/Visuals/RenderableSeries/StackedColumnCollection.js:155` — push_back per point per series (also :127, :157, :162, :163, :180)
- `esm/Charting/Visuals/RenderableSeries/StackedXyCollection.js:79` — same root cause, also reported by slice x2-data-and-lifecycle: Stacked collections rebuild every accumulated vector with one embind push_back per point per series on each data change
- `esm/Charting/Visuals/RenderableSeries/StackedXyCollection.js:142` — buildUnwoundXValues: one push_back per point to unwind FIFO X. Its reserve() also runs after the y views at :42 were created, so a heap growth can detach them (latent correctness hazard)
- `esm/Charting/Visuals/RenderableSeries/StackedColumnCollection.js:127` — same loop shape; also Object.keys(seriesGroups) and a forEach closure per point (:128), push_back at :155-163 and :180
- `esm/Charting/Visuals/SciChartSurface.js:760` — updateStackedCollectionAccumulatedVectors, called at the start of every render (SciChartRenderer.js:127)
- `esm/Charting/Visuals/RenderableSeries/BaseStackedRenderableSeries.js:49` — every child dataChanged -> notifyPropertyChanged(DATA_SERIES) -> collection marks itself dirty (StackedXyCollection.js:254-261)
- `_glue-pretty/scichart.js:4648` — craftInvokerFunction invokerFn: the generic embind invoker allocates a rest-args array and an onDone closure, and spreads the arguments, on every call

## Review notes

- Found by reviewer slice `s03-renderable-series`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.
- Duplicate merged from slice `x2-data-and-lifecycle`: Stacked collections rebuild every accumulated vector with one embind push_back per point per series on each data change
