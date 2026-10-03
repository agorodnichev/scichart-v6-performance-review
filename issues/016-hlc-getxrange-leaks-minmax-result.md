# 016 · HlcDataSeries.getXRange (horizontal error bars) leaks one wasm SCRTDoubleRange per call and rescans the full data each time

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Model/HlcDataSeries.js:186` |
| Severity | **high** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory (wasm heap growth); also frame time |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/cdedcd3e2e690bcd3d7af4d34c4d5394/): reproduced on WebGL and WebGPU ([source](../demos/016-hlc-getxrange-minmax-leak/)) |
| Rule | TASK-13 (web-performance skill) |
| Effort to fix | small |

## Code

```js
                let minMax;
                try {
                    // TODO probably can be optimized, make sure there are no memory leaks here
                    minMax = this.webAssemblyContext.NumberUtil.MinMax(hasLowCap ? this.getNativeLowValues() : this.getNativeXValues(), this.dataDistributionCalculator.containsNaN);
                    min = minMax.minD;
                    minMax = this.webAssemblyContext.NumberUtil.MinMax(hasHighCap ? this.getNativeHighValues() : this.getNativeXValues(), this.dataDistributionCalculator.containsNaN);
                    max = minMax.maxD;
                    if (!isRealNumber(min) || !isRealNumber(max)) {
                        return new NumberRange(0, 0);
                    }
                }
                finally {
                    deleteSafe(minMax);
                }
```

## Call path and frequency

SciChartSurface render (esm/Charting/Visuals/SciChartSurface.js:640, once per redraw; redraws are invalidation-driven: data updates, zoom/pan steps, range animations) -> SciChartRenderer.render X autorange step (esm/Charting/Services/SciChartRenderer.js:132) -> tryPerformAutoRangeOn (:724-729; every redraw when xAxis.autoRange === Always) -> AxisBase2D.getMaximumRange (esm/Charting/Visuals/Axis/AxisBase2D.js:817/823) -> getMaxXRange (:1281) -> getXDataRange (:1255-1259, visible series only) -> FastErrorBarsRenderableSeries.getXRange (esm/Charting/Visuals/RenderableSeries/FastErrorBarsRenderableSeries.js:244) -> HlcDataSeries.getXRange (:167, horizontal count > 1 branch :180-205, try/finally :183-196). The same chain runs once per zoom-to-fit action: ZoomExtentsModifier.js:119 (double-click) and SciChartSurface.js:1323 (zoomExtentsX). Rate: once per redraw per visible horizontal error-bar series under X autoRange Always, plus once per zoom-to-fit.

## Why it costs

NumberUtil.MinMax returns a new embind-owned SCRTDoubleRange that needs delete() (types/types/TSciChart.d.ts:247, :1410-1414). Every other call site deletes its result in finally (BaseDataSeries.js:684, XyxyDataSeries.js:194-195, HlcDataSeries.js:229). Here the second assignment (:188) overwrites the handle of the first result (:186), so only the second is deleted (:195). The JS wrapper of the first is then collected without freeing the native object: the glue registers a FinalizationRegistry cleanup only for smart-pointer handles (_glue-pretty/scichart.js:3747-3753), and a class returned by value is a raw-pointer handle. The method also bypasses the changeCount memo that BaseDataSeries.getXRange uses, so both full scans repeat on every redraw.

**Scale where it matters:** Narrow configuration: FastErrorBarsRenderableSeries with errorDirection Horizontal (not the default), more than 1 point, and X autoRange Always (not the default), or repeated zoom-to-fit with any autoRange mode. Within it, the leak is unbounded: one small native SCRTDoubleRange (two doubles plus allocator overhead) per redraw, about 3,600 per minute while the chart redraws at 60 Hz (streaming), kept until the wasm context is disposed, and wasm memory never shrinks. Each call also runs two O(n) native scans over the whole low/high (or X) vectors, even when the data did not change.

## Fix (library side)

```diff
--- a/esm/Charting/Model/HlcDataSeries.js
+++ b/esm/Charting/Model/HlcDataSeries.js
@@ -183,14 +183,16 @@ export class HlcDataSeries extends BaseDataSeries {
                 let minMax;
+                let minMaxLow;
                 try {
                     // TODO probably can be optimized, make sure there are no memory leaks here
-                    minMax = this.webAssemblyContext.NumberUtil.MinMax(hasLowCap ? this.getNativeLowValues() : this.getNativeXValues(), this.dataDistributionCalculator.containsNaN);
-                    min = minMax.minD;
+                    minMaxLow = this.webAssemblyContext.NumberUtil.MinMax(hasLowCap ? this.getNativeLowValues() : this.getNativeXValues(), this.dataDistributionCalculator.containsNaN);
+                    min = minMaxLow.minD;
                     minMax = this.webAssemblyContext.NumberUtil.MinMax(hasHighCap ? this.getNativeHighValues() : this.getNativeXValues(), this.dataDistributionCalculator.containsNaN);
                     max = minMax.maxD;
                     if (!isRealNumber(min) || !isRealNumber(max)) {
                         return new NumberRange(0, 0);
                     }
                 }
                 finally {
+                    deleteSafe(minMaxLow);
                     deleteSafe(minMax);
                 }
```

**Trade-off:** None for the leak fix: one extra local and one extra deleteSafe. Optional follow-up for the rescans: wrap the horizontal branch in memoize(...) keyed on (this.changeCount, dataSeriesValueType, isHorizontalDirection, hasHighCap, hasLowCap), as BaseDataSeries.getXRangeByName does. It keeps one cached NumberRange per series; the key must include the direction and cap flags, and it has the same staleness behaviour during data animations as the base-class memo.

## App-side workaround

Avoid X autoRange Always on charts with horizontal error bars: use autoRange Once or Never and set xAxis.visibleRange from your own data. Or use vertical error bars.

## Verify

measure.md#mem: horizontal error bars, 10k points, xAxis.autoRange Always. Warm up, then run a 60 s render or "stream" scenario 10 times, sampling an app counter for wasm heap in use after each (measure.md#mem: read wasm size from an app counter). Pass: growth per repetition is within noise after the fix. Before the fix, growth is linear in the number of frames rendered.

## Other locations

- `esm/Charting/Model/HlcDataSeries.js:167` — getXRange overrides the changeCount-memoized BaseDataSeries.getXRange (BaseDataSeries.js:654-700), so both full-array MinMax scans rerun on every call
- `esm/Charting/Visuals/RenderableSeries/FastErrorBarsRenderableSeries.js:244` — Only caller that passes isHorizontalDirection = true (errorDirection Horizontal; the default is Vertical, :58)
- `esm/Charting/ChartModifiers/ZoomExtentsModifier.js:119` — Zoom-to-fit on double-click calls xAxis.getMaximumRange, so one more leaked range per action even with autoRange Once or Never (also SciChartSurface.js:1323 zoomExtentsX)
- `_glue-pretty/scichart.js:3749` — embind attaches a FinalizationRegistry cleanup only when hasSmartPtr; SCRTDoubleRange returned by value is a raw-pointer handle, so GC never frees it
- `esm/Charting/Model/XyxyDataSeries.js:186` — Same unmemoized pattern (two full MinMax scans per call, ignoring the sorted flag), but both results are deleted, so no leak

## Review notes

- Found by reviewer slice `s08-data-series`.
- Adversarial verification (corrected): Re-read esm/Charting/Model/HlcDataSeries.js:167-206 (file is CRLF; code_quote matches lines 183-196 verbatim once line endings are normalised). Line 186 assigns the first NumberUtil.MinMax result to minMax, line 188 overwrites it, and finally (:194-195) deletes only the second. So the first SCRTDoubleRange is never deleted, also on the NaN early return (:190-191) and if the second call throws. NumberUtil.MinMax returns an embind class (types/types/TSciChart.d.ts:247 and :1410-1414, a class with delete()). The wasm has no shared_ptr type info for SCRTDoubleRange, and the glue attaches a FinalizationRegistry cleanup only to smart-pointer handles (_glue-pretty/scichart.js:3739-3756, `if (hasSmartPtr)`), so GC never frees the leaked handle. Caller chain re-established: SciChartSurface.js:640 renderer.render -> SciChartRenderer.js:132 xAxes.forEach(tryPerformAutoRangeOn) -> :724-729 (EAutoRange.Always, or Once only on the first range) -> AxisBase2D.js:817/823 getMaximumRange -> :1281-1282 getMaxXRange -> :1255-1259 getXDataRange (visible series only) -> FastErrorBarsRenderableSeries.js:239-244 (the only caller that passes isHorizontalDirection=true; hit-test callers hitTestHelpers.js:65 and ScatterSeriesHitTestProvider.js:76 pass no args, so they take the vertical branch, which deletes its result). Zoom-to-fit paths also reach getMaximumRange once per action: ZoomExtentsModifier.js:119 (double-click) and SciChartSurface.js:1323 (zoomExtentsX). Defaults are errorDirection Vertical (FastErrorBarsRenderableSeries.js:58) and autoRange Once (AxisCore.js:92), so the configuration is opt-in, but the leak is unbounded per redraw, or per zoom-to-fit action. BaseDataSeries.getXRangeByName (:657-700) memoizes on changeCount; the Hlc override has no memo, so both O(n) scans rerun on every call. XyxyDataSeries.js:186-196 does the same two scans but deletes both results. Corrections: (1) the fix_diff was not a valid unified diff: it left out the TODO context line at :185 and ended in an unprefixed comment line. It is rewritten with a real hunk header, and the optional memo is moved to trade_off. (2) Rule: dropped SC-29, which is about app code deleting swapped or removed data series; TASK-13 ("call delete() on every JS wrapper of a Wasm object") covers this mechanism. (3) scale and call_path now say that redraws are invalidation-driven, not every vsync, and add the zoom-to-fit paths. (4) why_it_costs now cites the glue finalizer guard; other_locations adds the glue and ZoomExtentsModifier locations. Severity stays high (leak per redraw and per repeated action, review.md §B), evidence S.

