# 038 · SciChartPieLegend.update has no dirty check, so the whole legend DOM is rebuilt on every synchronous pie invalidate: each segment property set, and about 11 times per click

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Legend/SciChartPieLegend.js:58` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | INP (also frame time on data updates) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
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

PieSegment setter (PieSegment.js:98-102 / :146-150 / :182-187) -> notifyPropertyChanged (:256-262) -> SciChartPieSurface.invalidateElement (SciChartPieSurface.js:208-216) -> update (:220-225) -> draw() + SciChartPieLegend.update (SciChartPieLegend.js:58-63) -> clear (SciChartLegendBase.js:241-249) -> create (:300-311: getInnerHTML, htmlToElement parse, appendChild, querySelector + addEventListener per segment). Rate: once per segment property change, so K rebuilds when K segment values are updated in one task, and about 11 per segment or checkbox click with animate on.

## Why it costs

Each call removes the legend <div>, builds the full HTML string, parses it (htmlToElement), inserts it, runs one attribute-selector querySelector per segment, and attaches new listeners. Every rebuild restyles and lays out the legend. The checkbox the user just clicked is replaced mid-interaction, and all but the last rebuild in a task are never painted.

**Scale where it matters:** Pie or donut with a legend: K segments updated per data tick gives K full legend rebuilds per tick; a click gives about 11.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/Legend/SciChartPieLegend.js
+++ b/esm/Charting/Visuals/Legend/SciChartPieLegend.js
@@ -58,6 +58,11 @@
     update() {
+        const html = this.showLegend ? this.getInnerHTML() : "";
+        if (this.div && html === this.lastHtml) {
+            return;   // same items, colors, checked state and placement: keep DOM and listeners
+        }
+        this.lastHtml = html;
         this.clear();
         if (this.showLegend) {
             this.create();
         }
     }
```

**Trade-off:** One HTML string build per invalidate remains, which is cheap next to parse plus listeners. Legend listeners stay attached across unchanged updates. Pie draw() itself still runs synchronously per setter; that belongs to the pie-surface slice.

## App-side workaround

`showLegend: false` with an app-rendered legend that updates only on change. No API batches segment updates on the pie surface (suspendUpdates does not gate SciChartPieSurface.invalidateElement).

## Verify

measure.md#inp: click a pie segment (animate: true) and a legend checkbox, 5 runs each. Pass: the processing subpart wins, and a MutationObserver on the legend root records at most 1 legend replacement per click. Then measure.md#fps with a scenario that sets 10 segment values per tick at 10 ticks/s. Pass: LoAF script time in SciChartPieLegend.update drops.

## Other locations

- `esm/Charting/Visuals/SciChartPieSurface/SciChartPieSurface.js:224` — update() calls legend.update() on every invalidateElement (:208-216), which runs synchronously with no rAF coalescing
- `esm/Charting/Visuals/SciChartPieSurface/PieSegment/PieSegment.js:260` — every segment setter (value, isSelected, shift, color, ...) invalidates synchronously
- `esm/Charting/Visuals/SciChartPieSurface/helpers/addEventListenerToPieSegment.js:17` — select animation sets ps.shift 10 times at 20 ms intervals, so 10 more legend rebuilds per click

## Review notes

- Found by reviewer slice `s07-annotations-legend`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

