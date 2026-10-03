# 014 · Every legend rebuild leaks one rs.isVisibleChanged subscription per series, and with it the old detached legend DOM; detach never releases them

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Legend/SciChartLegendBase.js:54` |
| Severity | **high** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (confirmed) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/670ef1748afaa161e1111424a94cb389/): reproduced on WebGL and WebGPU ([source](../demos/014-legend-rebuild-leaks-handlers/)) |
| Rule | LIFE-01, LIFE-05 (web-performance skill) |
| Effort to fix | small |

## Code

```js
        this.removeEventListenerFromSeries = (renderableSeriesId) => {
            var _a;
            (_a = this.eventListenersCollection.get(renderableSeriesId)) === null || _a === void 0 ? void 0 : _a.forEach(({ element, eventListener, eventType }) => {
                element.removeEventListener(eventType, eventListener);
            });
            this.eventListenersCollection.delete(renderableSeriesId);
```

## Call path and frequency

Checkbox change -> onChangeEventListener (SciChartLegend.js:66-71) -> rs.isVisible setter raises isVisibleChanged (RenderableSeries/BaseRenderableSeries.js:328) -> visibilityChangeEventHandler -> invalidateLegend (SciChartLegendBase.js:140) -> next render -> surface.rendered (subscribed at SciChartLegendBase.js:98) -> update (:124) -> clear (:241) -> removeEventListeners (SciChartLegend.js:57) -> removeEventListenerFromSeries (SciChartLegendBase.js:52-58, no unsubscribe) -> create (:300) -> addEventListeners -> addEventListenerToSeries (SciChartLegend.js:63) -> rs.isVisibleChanged.subscribe (:76). Rate: once per series per legend rebuild. Rebuilds happen on every checkbox toggle, series add/remove (LegendModifier.js:65-73) and legend property change.

## Why it costs

The visibilityChangeEventHandler closure shares its V8 context with `el`, which the `delete` closure captures. Each leaked handler therefore keeps the old checkbox element alive, and through its parent chain the whole detached legend <div>. Memory grows with each repeated action, and every isVisibleChanged raise also runs a growing handler list (EventHandler.raiseEvent copies and iterates it).

**Scale where it matters:** LegendModifier({ showCheckboxes: true }) with N series: after T rebuilds, each series holds T+1 handlers, and T old legend subtrees stay retained. The growth lasts as long as the series live, including after the modifier is removed.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/Legend/SciChartLegendBase.js
+++ b/esm/Charting/Visuals/Legend/SciChartLegendBase.js
@@ -54,4 +54,6 @@
-            (_a = this.eventListenersCollection.get(renderableSeriesId)) === null || _a === void 0 ? void 0 : _a.forEach(({ element, eventListener, eventType }) => {
-                element.removeEventListener(eventType, eventListener);
-            });
+            (_a = this.eventListenersCollection.get(renderableSeriesId)) === null || _a === void 0 ? void 0 : _a.forEach(item => {
+                if (item.delete) item.delete();   // DOM listener + rs.isVisibleChanged handler
+                else item.element.removeEventListener(item.eventType, item.eventListener);
+            });
             this.eventListenersCollection.delete(renderableSeriesId);
--- a/esm/Charting/Visuals/Legend/SciChartLegend.js   (same in SciChart3DLegend.js)
     removeEventListeners() {
-        this.renderableSeriesArray.forEach(rs => this.removeEventListenerFromSeries(rs.id));
+        // release what was registered, not what the (possibly replaced or emptied) array holds now
+        Array.from(this.eventListenersCollection.keys()).forEach(id => this.removeEventListenerFromSeries(id));
     }
```

**Trade-off:** None. The pie and manual legend items already carry a delete() that only removes their DOM listener, so their behavior does not change.

## App-side workaround

Pass a subclass through `new LegendModifier({ legend })` that overrides removeEventListeners to call `item.delete()` for every entry of `this.eventListenersCollection` and then clears the map. Or keep showCheckboxes false.

## Verify

measure.md#mem: LegendModifier({ showCheckboxes: true }) with 10 series. Toggle one checkbox 10 times (warm-up 2), with an app counter of `rs.isVisibleChanged.handlers.length` summed over series in memory.sample(). Pass: the counter stays at its baseline, S1->S2 heap growth per action is within noise, and compare_heapsnapshots shows no growing detached HTMLInputElement or div.scichart__legend.

## Other locations

- `esm/Charting/Visuals/Legend/SciChartLegend.js:76` — subscribes a new closure on every rebuild; EventHandler.subscribe (Core/EventHandler.js:32-36) dedupes by identity only
- `esm/Charting/Visuals/Legend/SciChartLegend.js:58` — removeEventListeners iterates the current renderableSeriesArray, not the Map; entries of removed series are never deleted
- `esm/Charting/ChartModifiers/LegendModifier.js:102` — onDetach sets the array to [] right before detach() -> clear() -> removeEventListeners, so nothing is released on detach
- `esm/Charting/Visuals/Legend/SciChart3DLegend.js:70` — same leak for 3D legends (removeEventListeners at :52)

## Review notes

- Found by reviewer slice `s07-annotations-legend`.
- Adversarial verification (confirmed): Re-read SciChartLegendBase.js:39-320, SciChartLegend.js:1-116, SciChart3DLegend.js:48-88, LegendModifier.js:40-140, Core/EventHandler.js and BaseRenderableSeries.js:318-330. The code_quote matches SciChartLegendBase.js:52-57 verbatim. removeEventListenerFromSeries destructures only {element, eventListener, eventType} and never calls item.delete(), which is the only place rs.isVisibleChanged.unsubscribe(visibilityChangeEventHandler) runs (SciChartLegend.js:81-84, SciChart3DLegend.js:75-78). Each create() -> addEventListeners -> addEventListenerToSeries subscribes a new closure (SciChartLegend.js:76). EventHandler.subscribe (:33-37) dedupes by identity only, so handlers accumulate. The subscription exists only with showCheckboxes, because only the checkbox input carries id=rs.id (getLegendItemHtml, SciChartLegendBase.js:324-326); the issue scopes it that way. Rebuild chain confirmed: checkbox change -> SciChartLegend.js:66-71 -> isVisible setter raises isVisibleChanged (BaseRenderableSeries.js:328) -> invalidateLegend (SciChartLegendBase.js:140) -> surface.rendered (subscribed :98) -> update (:124, isDirty guard passes) -> clear (:241-248) -> removeEventListeners (SciChartLegend.js:57-58, current array only) -> create (:300-311) -> new subscription. Series add/remove (LegendModifier.js:65-73), legend property setters (notifyPropertyChanged :291-296) and subsurface resize (:114-120) also rebuild. Detach releases nothing. LegendModifier.onDetach sets the array to [] (:102) before detach() (:103) -> delete -> clear, so removeEventListeners iterates an empty array. rg finds no other unsubscribe or unsubscribeAll for isVisibleChanged in esm/. The retention mechanism holds: visibilityChangeEventHandler shares its function context with the delete arrow that captures el, so every leaked handler pins its old checkbox and, through parentNode, the detached legend div. Severity high (a leak that grows with each repeated action) and evidence S hold. LIFE-01's Avoid field does not excuse it. The fix diff is correct and minimal. It releases through item.delete() and iterates the Map keys, so entries of series that were removed or emptied before clear() are released too. The trade_off claim checks out: ManualLegend.js:93-98 and addEventListenerToPieSegment.js items have delete() that only removes the DOM listener. The app workaround is valid: SciChartLegend is exported (esm/index.js:472), LegendModifier accepts options.legend (:42), and eventListenersCollection is protected in the typings (SciChartLegendBase.d.ts:97), so a subclass can reach it.

