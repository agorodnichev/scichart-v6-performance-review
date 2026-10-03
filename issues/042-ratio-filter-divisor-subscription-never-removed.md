# 042 · XyRatioFilter never unsubscribes from divisorSeries.dataChanged; a deleted filter keeps running (and throwing) on every divisor update

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Model/Filters/XyRatioFilter.js:21` |
| Severity | **medium** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory (retained filters per add/remove cycle); per-update work and errors in the data path |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
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

Create: XyRatioFilter constructor (:20-21) subscribes. Teardown: surface.renderableSeries.remove(ratioSeries) deletes the series and its data series -> XyFilterBase.delete (XyFilterBase.js:82-85) deletes the original series and the filter, never touching the divisor. Afterwards, each divisor data call -> BaseDataSeries.notifyDataChanged (esm/Charting/Model/BaseDataSeries.js:647) -> EventHandler.raiseEvent (esm/Core/EventHandler.js:56) -> XyRatioFilter.onDivisorDataChanged (:140) -> filterOnAppend (:49) -> areSourcesInSync (:90) -> getOriginalCount() on originalSeries, which delete() set to undefined -> TypeError out of the divisor's appendRange. Per add/remove cycle (retention) and per divisor data update (dead handler runs).

## Why it costs

The divisor usually outlives the ratio series, so its handler list holds the bound function and, through it, the deleted filter object for the rest of the session, and runs it on every divisor data change. XyFilterBase only unsubscribes from the original series and XyRatioFilter overrides neither delete() nor detachFromOriginalSeries(). The first dead handler throws inside raiseEvent's forEach, so handlers registered after it (for example a later surface invalidation) are skipped and the app's appendRange call fails.

**Scale where it matters:** A long-lived divisor series (often also plotted) with a ratio series toggled N times: N dead handlers on the divisor; every divisor append after the first removal throws.

## Fix (library side)

```diff
--- a/esm/Charting/Model/Filters/XyRatioFilter.js
+++ b/esm/Charting/Model/Filters/XyRatioFilter.js
@@ class XyRatioFilter
+    detachFromOriginalSeries() {
+        if (this.divisorSeries) this.divisorSeries.dataChanged.unsubscribe(this.onDivisorDataChanged);
+        super.detachFromOriginalSeries();
+    }
+    delete() {
+        // the divisor usually outlives the ratio (it is often plotted too): stop it calling a deleted filter
+        if (this.divisorSeries) this.divisorSeries.dataChanged.unsubscribe(this.onDivisorDataChanged);
+        this.divisorSeries = undefined;
+        super.delete();
+    }
```

**Trade-off:** None; the divisor is still not deleted by the filter, because it is usually shared.

## App-side workaround

Before removing the ratio series, call divisorSeries.dataChanged.unsubscribe(ratioFilter.onDivisorDataChanged) (the bound handler is stored on the instance).

## Verify

measure.md#mem: 10 cycles of (add a ratio series over a shared divisor -> remove it with the default delete -> divisor.appendRange). Pass: divisor.dataChanged.handlers.length returns to its baseline after each cycle, list_console_messages shows no TypeError, and heapPerActionMb is within noise.

## Other locations

- `esm/Charting/Model/Filters/XyFilterBase.js:78` — detachFromOriginalSeries unsubscribes only the original series
- `esm/Charting/Model/Filters/XyFilterBase.js:82` — delete() does not know about the divisor
- `esm/Charting/Model/Filters/XyRatioFilter.js:90` — areSourcesInSync dereferences originalSeries after delete

## Review notes

- Found by reviewer slice `s09-filters-numerics-utils`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

