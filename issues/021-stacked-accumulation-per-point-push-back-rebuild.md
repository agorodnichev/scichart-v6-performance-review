# 021 · Stacked collections rebuild every accumulated vector with per-point embind push_back calls on every data change

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/StackedXyCollection.js:71` |
| Severity | **high** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (stream; also INP when data changes come from input) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/eb260d17a53d0c6e3dfeedaf5ce73d65/): reproduced on WebGL and WebGPU ([source](../demos/021-stacked-accumulation-push-back-rebuild/)) |
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

**Scale where it matters:** A streaming stacked mountain or column chart: S = 5 layers x N = 100k points (fifoCapacity) gives about 1.2M embind push_back calls per data change (N x (2S+1) = 1.1M for the stacks, plus N = 100k to unwind the FIFO X values) and about 1M JS closure calls (one forEach callback and one rawIndexers closure per point per series), i.e. per frame while data streams. It starts to matter from about N x S >= 10^5 at one update per frame.

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
+        this.buildUnwoundXValues(dataValuesCount);               // same change inside: resizeFast(n) first, then copy the two wrapped halves of the raw X ring
+        // with SCRTMemCopy from xFifo.dataPtrZero() (as copyDoubleVector does), so no view is held across new SCRTDoubleVector()/reserve()
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
- Adversarial verification (corrected): Re-read StackedXyCollection.js:33-115 (quote at :71-82 matches verbatim apart from CRLF line endings; primary moved from :79 to :71 where the quote starts), :129-144 buildUnwoundXValues, :254-261, :308-317, and StackedColumnCollection.js:104-186. Caller chain re-established: XyDataSeries appendRange raises dataChanged -> BaseRenderableSeries.js:436 subscribes dataSeriesDataChanged -> BaseStackedRenderableSeries.js:49-51 overrides it with notifyPropertyChanged(DATA_SERIES) -> :97-101 notifyParentPropertyChangedFn (bound at BaseStackedCollection.js:60, passed in StackedXyCollection.js:290) -> StackedXyCollection.notifyPropertyChanged sets isAccumulatedVectorDirty (:260) and BaseStackedCollection.js:455-456 invalidateParent -> next render SciChartRenderer.js:127 -> SciChartSurface.js:760-762 -> updateAccumulatedVectors. Only guard is the dirty flag plus !dataValuesCount (:35); it coalesces several appends into one rebuild per frame but does not narrow the work: clearAccumulatedVectors (:308-317) clears every vector and the loop rebuilds all N indices with N x (2S+1) push_back (:54, :79/:81 or :86/:87, :107) plus N more in buildUnwoundXValues (:142) for FIFO sources. Later calls (draw :167, BaseStackedCollection.js:518 computeYRange, :779) are no-ops once the flag is cleared. push_back goes through the generic embind invoker (_glue-pretty/scichart.js:4648 invokerFn, used for class methods at :4876): rest args, toWireType(this), spread call, nested onDone closure, per value. Stacked series are not resampled (BaseRenderableSeries.js:1181 !this.isStacked). SC-01/V8-01 Avoid fields do not exempt this (not a rare single-point call; data size grows). Severity high kept: per frame while any child streams, cost proportional to history length. Evidence S kept: the full rebuild with per-point wasm calls on every data-changed frame is certain from the code. Fix checked: resizeFast exists on SCRTDoubleVector (types/types/TSciChart.d.ts:468, returns achieved size), allocations-before-views ordering is right, starts[] reproduces rawIndexers exactly (modulo is identity when start is 0), non-separate mode leaves bottomAccumulatedValues at size 0 as today, hidden series still cleared by clearAccumulatedVectors, requiresTransform is a plain field (BaseRenderDataTransform.js:19) so hoisting it is equivalent. Corrected: primary line; scale counts (the 5 x 100k FIFO example is 1.2M push_back with the X unwind, and about 1M closure calls since each point/series runs a forEach callback and a rawIndexers closure); fix_diff comment for buildUnwoundXValues, whose current code takes xView (:134) before new SCRTDoubleVector/reserve (:137-140), so the fixed version must copy after resizeFast (SCRTMemCopy from SCRTFifoVector.dataPtrZero) rather than reuse an earlier view.
- Duplicate merged from slice `x2-data-and-lifecycle`: Stacked collections rebuild every accumulated vector with one embind push_back per point per series on each data change
