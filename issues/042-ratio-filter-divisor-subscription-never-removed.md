# 042 · XyRatioFilter never unsubscribes from divisorSeries.dataChanged; a deleted filter keeps running (and throwing) on every divisor update

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Model/Filters/XyRatioFilter.js:21` |
| Severity | **medium** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory (retained filters per add/remove cycle); per-update work and errors in the data path |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/36c6a8b081598a822b4bc55fdb59085d/): reproduced on WebGL and WebGPU ([source](../demos/042-ratio-filter-divisor-subscription-never-removed/)) |
| Rule | LIFE-01, SC-29 (web-performance skill) |
| Effort to fix | small |

## Code

```js
        this.divisorSeries = options.divisorSeries;
        this.divisorField = (_a = options.divisorField) !== null && _a !== void 0 ? _a : this.divisorField;
        this.onDivisorDataChanged = this.onDivisorDataChanged.bind(this);
        this.divisorSeries.dataChanged.subscribe(this.onDivisorDataChanged);
```

## Call path and frequency

Create: XyRatioFilter constructor (:20-21) subscribes. Teardown: surface.renderableSeries.remove(ratioSeries) deletes the series and its data series (BaseRenderableSeries.js:674) -> XyFilterBase.delete (XyFilterBase.js:82-85) deletes the original series and the filter, never touching the divisor. Afterwards, each divisor data call -> BaseDataSeries.notifyDataChanged (esm/Charting/Model/BaseDataSeries.js:645, raiseEvent at :647) -> EventHandler.raiseEvent (esm/Core/EventHandler.js:56) -> XyRatioFilter.onDivisorDataChanged (:140) -> filterOnAppend (:49) / filterOnInsert / filterOnRemove -> areSourcesInSync (:90) -> getOriginalCount() on originalSeries, which delete() set to undefined -> TypeError out of the divisor's appendRange (update: filterOnUpdate :62 -> getOriginalYValues, same TypeError). Per add/remove cycle (retention) and per divisor data update (dead handler runs).

## Why it costs

The divisor usually outlives the ratio series, so its handler list holds the bound function and, through it, the deleted filter object for the rest of the session, and runs it on every divisor data change. XyFilterBase only unsubscribes from the original series and XyRatioFilter overrides neither delete() nor detachFromOriginalSeries(). The first dead handler throws inside raiseEvent's forEach, so handlers registered after it (for example a later surface invalidation) are skipped and the app's appendRange call fails.

**Scale where it matters:** A long-lived divisor series (often also plotted) with a ratio series toggled N times: N dead handlers on the divisor; every divisor append after the first removal throws.

## Fix (library side)

```diff
--- a/esm/Charting/Model/Filters/XyRatioFilter.js
+++ b/esm/Charting/Model/Filters/XyRatioFilter.js
@@ class XyRatioFilter
+    detachFromOriginalSeries() {
+        this.divisorSeries.dataChanged.unsubscribe(this.onDivisorDataChanged);
+        super.detachFromOriginalSeries();
+    }
+    delete() {
+        // the divisor usually outlives the ratio (it is often plotted too): stop it calling a deleted filter
+        this.divisorSeries.dataChanged.unsubscribe(this.onDivisorDataChanged);
+        super.delete();
+    }
```

**Trade-off:** None; the divisor is still not deleted by the filter, because it is usually shared.

## App-side workaround

Before removing the ratio series, unsubscribe the filter from the divisor you passed in: divisorSeries.dataChanged.unsubscribe((ratioFilter as any).onDivisorDataChanged). The bound handler is an own property of the instance, but it is private in the typings (types/Charting/Model/Filters/XyRatioFilter.d.ts:39), hence the cast.

## Verify

measure.md#mem: 10 cycles of (add a ratio series over a shared divisor -> remove it with the default delete -> divisor.appendRange). Pass: divisor.dataChanged.handlers.length returns to its baseline after each cycle, list_console_messages shows no TypeError, and heapPerActionMb is within noise.

## Other locations

- `esm/Charting/Model/Filters/XyFilterBase.js:78` — detachFromOriginalSeries unsubscribes only the original series
- `esm/Charting/Model/Filters/XyFilterBase.js:82` — delete() does not know about the divisor
- `esm/Charting/Model/Filters/XyRatioFilter.js:90` — areSourcesInSync dereferences originalSeries after delete

## Review notes

- Found by reviewer slice `s09-filters-numerics-utils`.
- Adversarial verification (corrected): Re-read esm/Charting/Model/Filters/XyRatioFilter.js: the quote matches :18-21 verbatim; the class overrides neither delete() nor detachFromOriginalSeries(), and rg finds no other reference to divisorSeries in esm/ outside this file. XyFilterBase.detachFromOriginalSeries (esm/Charting/Model/Filters/XyFilterBase.js:78-81) unsubscribes only the original series; XyFilterBase.delete (:82-85) sets originalSeriesProperty = deleteSafe(...) = undefined (esm/Core/Deleter.js:5-8) then BaseDataSeries.delete, which touches no other series. Teardown chain: BaseRenderableSeries.delete (esm/Charting/Visuals/RenderableSeries/BaseRenderableSeries.js:671-674) -> deleteSafe(dataSeries) -> filter.delete(); the dataSeries setter (:434) then unsubscribes the renderable series from the filter, so the dead filter does not retain the renderable series, but the divisor still holds onDivisorDataChanged. Afterwards: divisor appendRange/insertRange/removeRange/update -> notifyDataChanged (esm/Charting/Model/BaseDataSeries.js:645-647) -> EventHandler.raiseEvent (esm/Core/EventHandler.js:55-57, handlers.slice(0).forEach with no try/catch) -> onDivisorDataChanged (:140) -> filterOnAppend (:49) -> areSourcesInSync (:90) -> getOriginalCount (XyFilterBase.js:101-103) -> undefined.count() -> TypeError; update goes through filterOnUpdate (:62) -> getOriginalYValues -> same TypeError. Clear and Property events do not throw (onClear -> clear() returns on a deleted series). Mechanism certain (S). Severity kept medium: the retained object per cycle is a small JS shell (wasm buffers already freed), and the visible effect is the throw out of the app's divisor update. Fix diff checked: delete() is reached through the renderable-series teardown and is safe to call twice; removed the 'this.divisorSeries = undefined' line because divisorSeries is 'private readonly' in types/Charting/Model/Filters/XyRatioFilter.d.ts:17, and it is not needed once the subscription is gone. Corrected app_workaround: onDivisorDataChanged is private in the typings (:39), so TS code needs a cast. Fixed the notifyDataChanged line (645, raise at 647).

