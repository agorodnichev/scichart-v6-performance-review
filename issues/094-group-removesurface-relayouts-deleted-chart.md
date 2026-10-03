# 094 · surface.delete() on a grouped chart runs one or two full layouts (every axis re-measured) on the chart being destroyed, through SciChartVerticalGroup/HorizontalGroup.removeSurface

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/LayoutManager/SciChartVerticalGroup.js:64` |
| Severity | **low** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | INP (processing time of the interaction that unmounts the view) |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | none (web-performance skill) |
| Effort to fix | small |

## Code

```js
        sciChartSurface.layoutManager.layoutChart(sciChartSurface.renderSurface.viewportSize, sciChartSurface.chartTitleRenderer.titleOffset);
```

## Call path and frequency

app unmount -> SciChartSurface.delete (esm/Charting/Visuals/SciChartSurface.js:671; sets isDeletedProperty = true) -> verticalGroup.removeSurface (SciChartSurface.js:695) -> SciChartVerticalGroup.removeSurface -> layoutChart (SciChartVerticalGroup.js:64). If the chart is also in a horizontal group, that layout runs on a horizontal-only SynchronizedLayoutManager, which also hits the double measure in F1. -> horizontalGroup.removeSurface (SciChartSurface.js:698) -> new LayoutManager (SciChartHorizontalGroup.js:49) -> layoutChart again (SciChartHorizontalGroup.js:64) -> every axis AxisBase2D.measure (AxisBase2D.js:578), getTicks(true) at :582. After that, delete() drops the layout manager and deletes the axes. This runs once per grouped chart deletion, synchronously in the teardown task.

## Why it costs

The relayout exists so that a surface that stays alive after leaving a group gets its own sizes again. During delete(), the result is thrown away: the layout manager is set to undefined and the axes are deleted a few lines later. The tick generation, label work and text measurement for every axis are wasted script time inside the task that handles the route-change or close click.

**Scale where it matters:** Grows with grouped charts x axes per chart. Tearing down a dashboard of N charts in both groups runs 2N full layouts in the unmounting task, plus label-cache lookups or texture creation for ticks whose labels are not cached yet.

## Fix (library side)

```diff
--- a/esm/Charting/LayoutManager/SciChartVerticalGroup.js
+++ b/esm/Charting/LayoutManager/SciChartVerticalGroup.js
@@ removeSurface(sciChartSurface) {
-        sciChartSurface.layoutManager.layoutChart(sciChartSurface.renderSurface.viewportSize, sciChartSurface.chartTitleRenderer.titleOffset);
+        if (!sciChartSurface.isDeleted) {
+            sciChartSurface.layoutManager.layoutChart(sciChartSurface.renderSurface.viewportSize, sciChartSurface.chartTitleRenderer.titleOffset);
+        }
--- a/esm/Charting/LayoutManager/SciChartHorizontalGroup.js
+++ b/esm/Charting/LayoutManager/SciChartHorizontalGroup.js
@@ removeSurface(sciChartSurface) {
-        sciChartSurface.layoutManager.layoutChart(sciChartSurface.renderSurface.viewportSize, sciChartSurface.chartTitleRenderer.titleOffset);
+        if (!sciChartSurface.isDeleted) {
+            sciChartSurface.layoutManager.layoutChart(sciChartSurface.renderSurface.viewportSize, sciChartSurface.chartTitleRenderer.titleOffset);
+        }
```

**Trade-off:** None for deleted surfaces. An explicit group.removeSurface() on a live surface still relays it out as before. The group bookkeeping (onXSizeChanged(id, 0), key deletion, synchronizeAxisSizes) still runs, so the remaining charts re-align.

## App-side workaround

None safe. delete() calls removeSurface internally, and clearing verticalGroup or horizontalGroup by hand leaves a dead manager in the group's layoutManagers array, which later per-frame group code dereferences.

## Verify

measure.md#inp: a click that unmounts a view with 12 charts in a SciChartVerticalGroup and a SciChartHorizontalGroup (each surface.delete()), 5 runs per side. Also count AxisBase2D.prototype.measure calls during delete(). Pass: the processingMs subpart wins, the other two subparts are not worse, and measure() calls during delete() drop to 0.

## Other locations

- `esm/Charting/LayoutManager/SciChartHorizontalGroup.js:64` — same relayout; a chart in both groups gets a second full layout here
- `esm/Charting/LayoutManager/SciChartHorizontalGroup.js:49` — allocates a new LayoutManager (8 strategy objects) for the dying surface; SciChartSurface.delete drops it right after (SciChartSurface.js:702)
- `esm/Charting/LayoutManager/SciChartVerticalGroup.js:49` — same allocation in the vertical group
- `esm/Charting/Visuals/SciChartSurface.js:695` — delete() -> verticalGroup.removeSurface(this); horizontalGroup.removeSurface(this) follows at :698

## Review notes

- Found by reviewer slice `s11-layout-core-themes`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

