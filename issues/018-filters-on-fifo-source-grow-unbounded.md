# 018 · Filters over a FIFO source append on every source append but default to a non-FIFO output, so they grow without bound

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Model/Filters/XyFilterBase.js:32` |
| Severity | **high** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory (wasm heap), later frame time |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | SC-02, SC-33 (web-performance skill) |
| Effort to fix | small |

## Code

```js
    constructor(originalSeries, options) {
        var _a, _b;
        super(originalSeries.webAssemblyContext, options);
```

## Call path and frequency

App appendRange on a FIFO source -> BaseDataSeries.appendRangeN notifyDataChanged(Append, count) (esm/Charting/Model/BaseDataSeries.js:223) -> EventHandler.raiseEvent (esm/Core/EventHandler.js:56) -> XyFilterBase.onBaseDataChanged (XyFilterBase.js:151-152) -> XyCustomFilter.filterOnAppend (XyCustomFilter.js:36-43) or XyMovingAverageFilter.appendLatestMA (XyMovingAverageFilter.js:57, :133) -> this.appendRange on the filter, which grows its vectors. Runs per source data update; FIFO sources never raise Remove (insert/remove throw on FIFO), so nothing ever shrinks the filter.

## Why it costs

A FIFO source overwrites its oldest points, but each filterOnAppend appends the same count to the filter. With the default options (no fifoCapacity) the filter is a growable XyDataSeries, so its X/Y vectors grow for the life of the stream. The wasm heap only grows and has a hard ceiling (SC-33), and an auto-ranged X axis widens to the filter's whole history. The FIFO-aware code (comments at XyMovingAverageFilter.js:55-56, XyCustomFilter.js:37-38) assumes the app set fifoCapacity on the filter too, but neither the typings nor the constructor make that the default.

**Scale where it matters:** Streaming FIFO source, e.g. fifoCapacity 100k at 1k points/s: a filter created without fifoCapacity gains 3.6M points per hour (about 58 MB of X+Y doubles per hour at 16 bytes per point; more for Xyy/Ohlc filters), while the source stays at 100k.

## Fix (library side)

```diff
--- a/esm/Charting/Model/Filters/XyFilterBase.js
+++ b/esm/Charting/Model/Filters/XyFilterBase.js
@@ -30,3 +30,7 @@
     constructor(originalSeries, options) {
         var _a, _b;
-        super(originalSeries.webAssemblyContext, options);
+        // Every source append is appended here too: default to the source's ring size so a filter of a FIFO source stays bounded
+        super(originalSeries.webAssemblyContext, originalSeries.fifoCapacity && !(options === null || options === void 0 ? void 0 : options.fifoCapacity)
+            ? Object.assign({}, options, { fifoCapacity: originalSeries.fifoCapacity })
+            : options);
 (same change in XyyFilterBase.js:8, XyzFilterBase.js:8, OhlcFilterBase.js:6, HlcFilterBase.js:8)
```

**Trade-off:** Behavior change: a filter on a FIFO source no longer keeps more history than its source unless the app passes a larger fifoCapacity explicitly (an explicit value still wins). Filter indices then match the source's logical indices, which filterOnUpdate(index) already assumes. XyMovingAverageFilter's non-last-point update path (calculate(index) -> removeRange) throws on a FIFO filter and needs an update()-based path for that case.

## App-side workaround

Pass fifoCapacity: source.fifoCapacity in every filter's options when the source is FIFO.

## Verify

measure.md#mem: stream 1k points/s into a fifoCapacity 100k XyDataSeries with an XyMovingAverageFilter created without fifoCapacity; sample counters every 10 s for 60 s after the FIFO fills. Pass: filter.count() stays at or below the source's fifoCapacity and the wasm heap counter stays flat (slope within noise).

## Other locations

- `esm/Charting/Model/Filters/XyCustomFilter.js:43` — filterOnAppend appendRange (also XyScaleOffsetFilter)
- `esm/Charting/Model/Filters/XyMovingAverageFilter.js:57` — FIFO source path appendLatestMA appends to a possibly non-FIFO filter
- `esm/Charting/Model/Filters/XyRatioFilter.js:59`
- `esm/Charting/Model/Filters/XyyCustomFilter.js:40`
- `esm/Charting/Model/Filters/XyzCustomFilter.js:40`
- `esm/Charting/Model/Filters/OhlcCustomFilter.js:70`
- `esm/Charting/Model/Filters/HlcCustomFilter.js:56`
- `esm/Charting/Model/Filters/XyyFilterBase.js:8`
- `esm/Charting/Model/Filters/XyzFilterBase.js:8`
- `esm/Charting/Model/Filters/OhlcFilterBase.js:6`
- `esm/Charting/Model/Filters/HlcFilterBase.js:8`

## Review notes

- Found by reviewer slice `s09-filters-numerics-utils`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

