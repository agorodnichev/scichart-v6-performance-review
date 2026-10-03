# 094 · surface.delete() on a grouped chart runs one or two full layouts (every axis re-measured) on the chart being destroyed, through SciChartVerticalGroup/HorizontalGroup.removeSurface

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/LayoutManager/SciChartVerticalGroup.js:64` |
| Severity | **low** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | INP (processing time of the interaction that unmounts the view) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Rule | none (web-performance skill) |
| Effort to fix | small |

## Code

```js
        sciChartSurface.layoutManager.layoutChart(sciChartSurface.renderSurface.viewportSize, sciChartSurface.chartTitleRenderer.titleOffset);
```

## Call path and frequency

app unmount -> SciChartSurface.delete (esm/Charting/Visuals/SciChartSurface.js:671; isDeletedProperty = true at :684) -> verticalGroup.removeSurface (SciChartSurface.js:695) -> SciChartVerticalGroup.removeSurface: new LayoutManager (SciChartVerticalGroup.js:49) when not in a horizontal group, else keep the sync manager with verticalGroup = undefined (:62) -> layoutChart (SciChartVerticalGroup.js:64). If the chart is also in a horizontal group, that layout runs on the horizontal-only path of SynchronizedLayoutManager.layoutChart (SynchronizedLayoutManager.js:37-42), where measureLeftOuterAxes and measureRightOuterAxes call super twice (:61-65, :80-84; finding 047). -> horizontalGroup.removeSurface (SciChartSurface.js:698) -> new LayoutManager (SciChartHorizontalGroup.js:49) -> layoutChart again (SciChartHorizontalGroup.js:64). Each layout calls AxisBase2D.measure on every axis (AxisBase2D.js:578), which runs getTicks(true) at :582 (ticks and labels regenerated) and the label size measurement in axisRenderer.measure. Then delete() drops the layout manager (SciChartSurface.js:701-702) and deletes the axes (:705-706). This runs once per grouped chart deletion, synchronously in the teardown task.

## Why it costs

The relayout exists so that a surface that stays alive after leaving a group gets its own sizes again. During delete(), the result is thrown away: the layout manager is set to undefined and the axes are deleted a few lines later. The tick generation, label work and text measurement for every axis are wasted script time inside the task that handles the route-change or close click.

**Scale where it matters:** Grows with grouped charts x axes per chart. Tearing down a dashboard of N charts in both groups runs 2N full layouts in the unmounting task, plus label-cache lookups or texture creation for ticks whose labels are not cached yet.

## Fix (library side)

```diff
--- a/esm/Charting/LayoutManager/SciChartVerticalGroup.js
+++ b/esm/Charting/LayoutManager/SciChartVerticalGroup.js
@@ -61,7 +61,9 @@ export class SciChartVerticalGroup {
             // Remove only the horizontal part of the layout manager
             syncLayoutManager.verticalGroup = undefined;
         }
-        sciChartSurface.layoutManager.layoutChart(sciChartSurface.renderSurface.viewportSize, sciChartSurface.chartTitleRenderer.titleOffset);
+        if (!sciChartSurface.isDeleted) {
+            sciChartSurface.layoutManager.layoutChart(sciChartSurface.renderSurface.viewportSize, sciChartSurface.chartTitleRenderer.titleOffset);
+        }
         this.onLeftSizeChanged(syncLayoutManager.id, 0);
         this.onRightSizeChanged(syncLayoutManager.id, 0);
         delete this.leftOuterLayoutSizes[syncLayoutManager.id];
--- a/esm/Charting/LayoutManager/SciChartHorizontalGroup.js
+++ b/esm/Charting/LayoutManager/SciChartHorizontalGroup.js
@@ -61,7 +61,9 @@ export class SciChartHorizontalGroup {
             // Remove only the horizontal part of the layout manager
             syncLayoutManager.horizontalGroup = undefined;
         }
-        sciChartSurface.layoutManager.layoutChart(sciChartSurface.renderSurface.viewportSize, sciChartSurface.chartTitleRenderer.titleOffset);
+        if (!sciChartSurface.isDeleted) {
+            sciChartSurface.layoutManager.layoutChart(sciChartSurface.renderSurface.viewportSize, sciChartSurface.chartTitleRenderer.titleOffset);
+        }
         this.onTopSizeChanged(syncLayoutManager.id, 0);
         this.onBottomSizeChanged(syncLayoutManager.id, 0);
         delete this.topOuterLayoutSizes[syncLayoutManager.id];
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
- Adversarial verification (corrected): Re-read esm/Charting/LayoutManager/SciChartVerticalGroup.js:41-70 and SciChartHorizontalGroup.js:41-71: line 64 in both files matches the code_quote verbatim and runs unconditionally (no isDeleted or other guard). Caller chain: SciChartSurface.delete (SciChartSurface.js:671) returns early only if already deleted (:672), sets isDeletedProperty = true (:684), then, for a Synchronised layout manager, calls verticalGroup.removeSurface(this) (:695) and horizontalGroup.removeSurface(this) (:698). These are the only callers of removeSurface in esm/ besides an explicit app call. In both group classes, removeSurface either sets layoutManager to a fresh LayoutManager (:49-58; the constructor at LayoutManager.js:29-58 allocates 8 strategy objects plus ChartLayoutState and LayoutStrategyAxes; the setter at SciChartSurface.js:404-410 calls invalidateElement, which bails at :575 on isDeleted) or keeps the sync manager with only the other group. It then calls layoutChart (:64). LayoutManager.layoutChart (LayoutManager.js:149) has no early-out: groupAxesByLayoutStrategy over xAxes and yAxes, all 8 measure*Axes, then AxisBase2D.measure (AxisBase2D.js:578), which calls getTicks(true) (:582; regenerate=true, so tick generation and getLabels run again at :1343-1370) and axisRenderer.measure, which calls labelProvider.getMaxLabel*. For a chart in both groups, the vertical removeSurface clears verticalGroup and runs SynchronizedLayoutManager.layoutChart on the horizontal-only path (SynchronizedLayoutManager.js:37-42). There, measureLeftOuterAxes and measureRightOuterAxes call super twice (:61-65, :80-84; finding 047). horizontalGroup.removeSurface then allocates a LayoutManager and lays the chart out again, so it gets 2 layouts. At that point renderSurface, chartTitleRenderer and the axes are all still alive (they are torn down at SciChartSurface.js:701-712), so the layouts really run and are thrown away at :701-706. The mechanism is certain on this path, so I raised evidence to S. Severity stays low: it is a one-time teardown cost per grouped chart, not per frame or per input. Corrections: evidence H->S; call_path now names :684 as the isDeleted set point and replaces the dangling 'F1' with finding 047 and its lines; fix_diff gets real hunk line numbers (the guard logic is unchanged and correct: sciChartSurface.isDeleted exists at SciChartSurfaceCore.js:54; group bookkeeping and synchronizeAxisSizes still run, so the surviving charts re-align as before).

