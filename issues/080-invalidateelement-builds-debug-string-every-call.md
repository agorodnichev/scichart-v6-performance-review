# 080 · invalidateElement builds a Logger.debug template string on every call, even though debug logging is off by default

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/SciChartSurface.js:572` |
| Severity | **low** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (script per data update) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (confirmed) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/5682ffc022303d4517e25834557142f3/): reproduced on WebGL and WebGPU ([source](../demos/080-invalidateelement-debug-string/)) |
| Rule | none (web-performance skill) |
| Effort to fix | small |

## Code

```js
        Logger.debug(`Invalidating ${(_a = this.id) !== null && _a !== void 0 ? _a : (_b = this.domChartRoot) === null || _b === void 0 ? void 0 : _b.id}: force=${options === null || options === void 0 ? void 0 : options.force} isSuspended=${this.isSuspended} isInitialized=${this.isInitialized}. svgOnly: ${options === null || options === void 0 ? void 0 : options.svgOnly} isInvalidated: ${(_c = this.sciChartRenderer) === null || _c === void 0 ? void 0 : _c.isInvalidated}`);
```

## Call path and frequency

DataSeries change -> BaseRenderableSeries.dataSeriesDataChanged (esm/Charting/Visuals/RenderableSeries/BaseRenderableSeries.js:1353-1358) -> invalidateParent (:1373-1376) -> invalidateParentCallback = scs.invalidateElement (:783) -> SciChartSurface.invalidateElement (esm/Charting/Visuals/SciChartSurface.js:570-572); also AxisCore.notifyPropertyChanged (esm/Charting/Visuals/Axis/AxisCore.js:898-899) on each visibleRange step during pan/zoom, and annotation/modifier callbacks (SciChartSurfaceBase.js:793, SciChartSurface.js:1282). Once per data update or property change, often many times per frame, including after the frame is already invalidated (the early return at :597 comes after the string is built).

## Why it costs

The template literal concatenates 6 interpolations into a ~150-character string, and the isSuspended getter chain runs, only for Logger.debug to discard the result because Logger.enableDebug is false. The saving per call is small; it is reported because the call rate follows the data rate.

**Scale where it matters:** Streaming views: 20 series x one appendRange per message x 300 messages/s is 6,000 calls/s. Per-point append loops make it one call per point.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/SciChartSurface.js
+++ b/esm/Charting/Visuals/SciChartSurface.js
@@ invalidateElement(options)
         var _a, _b, _c;
-        Logger.debug(`Invalidating ${(_a = this.id) !== null && _a !== void 0 ? _a : (_b = this.domChartRoot) === null || _b === void 0 ? void 0 : _b.id}: force=${options === null || options === void 0 ? void 0 : options.force} isSuspended=${this.isSuspended} isInitialized=${this.isInitialized}. svgOnly: ${options === null || options === void 0 ? void 0 : options.svgOnly} isInvalidated: ${(_c = this.sciChartRenderer) === null || _c === void 0 ? void 0 : _c.isInvalidated}`);
+        if (Logger.enableDebug) {
+            Logger.debug(`Invalidating ${(_a = this.id) !== null && _a !== void 0 ? _a : (_b = this.domChartRoot) === null || _b === void 0 ? void 0 : _b.id}: force=${options === null || options === void 0 ? void 0 : options.force} isSuspended=${this.isSuspended} isInitialized=${this.isInitialized}. svgOnly: ${options === null || options === void 0 ? void 0 : options.svgOnly} isInvalidated: ${(_c = this.sciChartRenderer) === null || _c === void 0 ? void 0 : _c.isInvalidated}`);
+        }
```

**Trade-off:** None: the output is identical when debug logging is on.

## App-side workaround

Reduce invalidations: one appendRange per series per frame instead of per-point appends, and suspendUpdates around batched changes.

## Verify

measure.md#fps, `stream` scenario at 300 messages/s into 20 series, 5 runs per side. Pass: compare-runs is neutral or 'win' on frameP95Ms, and invalidateElement self time in __wpProbe.loaf.read() topScripts goes down. Expect a small effect; a neutral verdict keeps it only as a hygiene change. Not measured.

## Other locations

- `esm/utils/logger.js:7` — Logger.debug only tests enableDebug after its argument is already built
- `esm/Charting/Visuals/SciChartSurface.js:572` — same root cause, also reported by slice x2-data-and-lifecycle: Every data change builds a debug template string and copies the handler list before invalidateElement's already-invalidated exit
- `esm/Core/EventHandler.js:56` — raiseEvent copies the handler array (slice(0)) and allocates a closure on every dataChanged / rendered / preRender event
- `esm/Charting/Model/BaseDataSeries.js:197` — PerformanceDebugHelper.mark option objects are allocated per data call even when perf debugging is off (also :224-227)

## Review notes

- Found by reviewer slice `s01-surface-render`.
- Adversarial verification (confirmed): Quote matches verbatim at SciChartSurface.js:572. Read Logger (esm/utils/logger.js): debug() checks enableDebug only inside the function, after the argument string is built; enableDebug defaults to false. Confirmed with rg that series invalidateParentCallback is scs.invalidateElement (BaseRenderableSeries.js:783) and dataSeriesDataChanged calls invalidateParent on each data change; annotations (SciChartSurfaceBase.js:793) and modifiers (SciChartSurface.js:1282) also call it directly. The string is built before both the suspended/initialized guard (:574-577) and the isInvalidated early-out (:597), so repeated calls within one frame all pay it. Severity stays low because the per-call cost is a single string build.
- Duplicate merged from slice `x2-data-and-lifecycle`: Every data change builds a debug template string and copies the handler list before invalidateElement's already-invalidated exit
