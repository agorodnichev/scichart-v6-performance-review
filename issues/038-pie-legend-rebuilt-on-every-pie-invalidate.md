# 038 · SciChartPieLegend.update has no dirty check, so the whole legend DOM is rebuilt on every pie invalidate: 11 times per segment or checkbox click with animation on, and once per segment property set when animate is false

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Legend/SciChartPieLegend.js:58` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | INP (also frame time on data updates) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Rule | DOM-07, DOM-04 (web-performance skill) |
| Effort to fix | small |

## Code

```js
    update() {
        this.clear();
        if (this.showLegend) {
            this.create();
        }
    }
```

## Call path and frequency

PieSegment setter (PieSegment.js:98-102 / :146-150 / :182-187) -> notifyPropertyChanged (:256-263) -> SciChartPieSurface.invalidateElement (SciChartPieSurface.js:208-216) -> update (:220-225, skipped only while suspendUpdate is set during a sweep animation) -> draw() + SciChartPieLegend.update (SciChartPieLegend.js:58-63) -> clear (SciChartLegendBase.js:241-249: removeEventListeners + removeChild) -> create (:300-311: getInnerHTML, htmlToElement parse, appendChild, one #id querySelector + addEventListener per segment at SciChartPieLegend.js:67-82). Rate: about 11 rebuilds per segment or legend-checkbox click with animate on (1 for isSelected, 10 for the 20 ms shift steps). For data updates: with surface animate: false, once per segment property set, so K rebuilds when K segment values are set in one task; with the default animate: true, a value set starts a 30 x 20 ms sweep that drops further updates, so 2 rebuilds per sweep.

## Why it costs

Each call removes the legend <div> and its listeners, builds the full HTML string, parses it (htmlToElement), inserts it, runs one ID querySelector per segment, and attaches new listeners. Every rebuild restyles and lays out the legend. The checkbox the user just clicked is replaced inside its own click handler. During the select animation the 10 shift-driven rebuilds each run in their own 20 ms timer task and produce the same markup. With animate: false, all but the last of K rebuilds in one task are never painted.

**Scale where it matters:** Pie or donut with a legend: about 11 full legend rebuilds per click (10 of them with unchanged markup). With animate: false, K segments updated per data tick give K full legend rebuilds per tick.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/Legend/SciChartPieLegend.js
+++ b/esm/Charting/Visuals/Legend/SciChartPieLegend.js
@@ -58,6 +58,18 @@
     update() {
+        const html = this.showLegend ? this.getInnerHTML() : "";
+        if (this.div && html === this.lastHtml) {
+            // same items, colors, checked state and placement: keep DOM and listeners,
+            // but re-sync checkboxes a blocked click may have toggled (old rebuild reset them)
+            if (this.showCheckboxes) {
+                this.pieSegmentArray.forEach(ps => {
+                    const el = this.div.querySelector(`#${getCheckboxId(ps.id)}`);
+                    if (el && el.checked !== ps.isSelected) el.checked = ps.isSelected;
+                });
+            }
+            return;
+        }
+        this.lastHtml = html;
         this.clear();
         if (this.showLegend) {
             this.create();
         }
     }
```

**Trade-off:** One HTML string build per invalidate remains (two on a real change, because create() builds it again), which is cheap next to parse plus listeners. With checkboxes shown, the unchanged path still runs one ID querySelector per segment but no DOM writes unless a checkbox is out of sync. Legend listeners stay attached across unchanged updates. Pie draw() itself still re-renders synchronously per setter; that belongs to the pie-surface slice.

## App-side workaround

`showLegend: false` with an app-rendered legend that updates only on change. No API batches segment updates on the pie surface (suspendUpdates does not gate SciChartPieSurface.invalidateElement).

## Verify

measure.md#inp: click a pie segment (animate: true) and a legend checkbox, 5 runs each. Pass: the processing subpart wins or stays neutral, and a MutationObserver on the legend root records at most 1 legend replacement per click instead of 11. Then measure.md#fps on a pie with animate: false and a scenario that sets 10 segment values per tick at 10 ticks/s. Pass: LoAF script time in SciChartPieLegend.update drops.

## Other locations

- `esm/Charting/Visuals/SciChartPieSurface/SciChartPieSurface.js:224` — update() calls legend.update() on every invalidateElement (:208-216), which runs synchronously with no rAF coalescing; only the sweep-animation suspendUpdate flag (:222, :562) gates it
- `esm/Charting/Visuals/SciChartPieSurface/PieSegment/PieSegment.js:260` — every segment setter (value, isSelected, shift, color, text, ...) invalidates synchronously
- `esm/Charting/Visuals/SciChartPieSurface/helpers/addEventListenerToPieSegment.js:20` — select animation toggles isSelected (:17), then sets ps.shift 10 times at 20 ms intervals, so 10 more legend rebuilds per click with identical legend markup

## Review notes

- Found by reviewer slice `s07-annotations-legend`.
- Adversarial verification (corrected): Re-read SciChartPieLegend.js:58-63 (quote verbatim; override drops the isDirty guard of SciChartLegendBase.update :124-136), SciChartLegendBase clear :241-249 and create :300-311, SciChartPieSurface invalidateElement :208-216 / update :220-225 / draw :551-594, PieSegment setters and notifyPropertyChanged :256-263 (invalidateParentCallback = scps.invalidateElement at :44), and addEventListenerToPieSegment.js. Pie legend is never attachTo'd (no rendered subscription); its only caller is SciChartPieSurface.update :224. Confirmed: click path with animate on = isSelected set (:17) + 10 ps.shift sets in 20 ms timers (:18-27) = 11 synchronous update() calls, each draw() + full legend rebuild; shift is not part of the legend markup, so 10 of the 11 rebuilds produce identical HTML. Corrected: (1) the per-data-tick claim only holds with surface animate: false. With the default animate: true (constructor :76) a value set passes PROPERTY_SEGMENT.VALUE -> sweepAnimationDone = false -> draw() takes the sweep branch and sets suspendUpdate = true (:562) for animationFrames (30) x 20 ms, so the other K-1 value sets in that task are dropped by the guard at :222, and one more rebuild follows at the end of the sweep (:576). (2) the per-segment querySelector is an ID selector (#check<id>, SciChartPieLegend.js:69), not an attribute selector. (3) the 11 click rebuilds run in separate 20 ms timer tasks, so they are painted, not discarded. (4) addEventListenerToPieSegment line moved to :20 (the shift write). (5) fix now re-syncs checkbox checked state on the unchanged path: today a checkbox click ignored while isListenerBlocked (:11) leaves the DOM checkbox toggled and the next rebuild resets it to ps.isSelected; a pure HTML compare would keep the stale visual state. Severity stays medium (per discrete interaction; the per-tick case needs animate: false). Evidence S for the click path.

