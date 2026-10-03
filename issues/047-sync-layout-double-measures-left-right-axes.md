# 047 · SynchronizedLayoutManager measures left and right outer axes twice per frame when the chart has no vertical group, which is the case for every chart in a SciChartHorizontalGroup that is not also in a SciChartVerticalGroup

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/LayoutManager/SynchronizedLayoutManager.js:64` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (script per frame) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Rule | V8-01 (web-performance skill) |
| Effort to fix | small |

## Code

```js
    measureLeftOuterAxes() {
        super.measureLeftOuterAxes();
        if (!this.verticalGroup) {
            super.measureLeftOuterAxes();
            return;
        }
```

## Call path and frequency

SciChartSurface.doDrawingLoop (esm/Charting/Visuals/SciChartSurface.js:605) -> SciChartRenderer.render (esm/Charting/Services/SciChartRenderer.js:88) -> layoutManager.layoutChart (SciChartRenderer.js:153) -> SynchronizedLayoutManager.layoutChart (SynchronizedLayoutManager.js:20, horizontalGroup branch at :40) -> LayoutManager.layoutChart (LayoutManager.js:149) -> this.measureLeftOuterAxes() / this.measureRightOuterAxes() (LayoutManager.js:163-164) -> SynchronizedLayoutManager.measureLeftOuterAxes (:61) -> LayoutManager.measureLeftOuterAxes (LayoutManager.js:221) x2 -> LeftAlignedOuterAxisLayoutStrategy.measureAxes -> axis.measure() (LeftAlignedOuterAxisLayoutStrategy.js:20) -> AxisBase2D.measure (AxisBase2D.js:578) -> getTicks(true) (:582) + axisRenderer.measure (:587). Runs once per rendered frame for each chart in a SciChartHorizontalGroup. A mock-based call count (agent-scratch/s11-count-measure.cjs, cjs build, no timing) gave Left:2, Right:2 measure() calls per layoutChart, against 1 each with the default LayoutManager. Top and bottom axes are not affected: measureTopOuterAxes and measureBottomOuterAxes return early without the second call.

## Why it costs

For each left and right outer axis, every rendered frame regenerates the tick and label arrays twice and computes the label size twice. In the normal case (non-negative top and bottom area sizes) the second pass produces the same values as the first: updateTopAndBottomChartLayoutState takes Math.max and updateAreaSize assigns the same requiredSize. The script time and short-lived allocations of one full axis measure are added to every frame for each Y axis of each such grouped chart.

**Scale where it matters:** Matters for dashboards of side-by-side charts that use SciChartHorizontalGroup without SciChartVerticalGroup, with 1-2 Y axes per chart, at the render rate (up to the display refresh rate while streaming, zooming or panning). The duplicated work for each Y axis is: delta calculation, tick provider arrays, two filter passes, getLabels for about 10-20 labels (the second pass mostly hits the label cache the first pass filled), and the label-size step (on the vertical-axis fast path a scan of the cached labelInfos widths). It is a bounded constant per axis per frame, not a cost that grows with the data.

## Fix (library side)

```diff
--- a/esm/Charting/LayoutManager/SynchronizedLayoutManager.js
+++ b/esm/Charting/LayoutManager/SynchronizedLayoutManager.js
@@ -61,7 +61,6 @@
     measureLeftOuterAxes() {
         super.measureLeftOuterAxes();
         if (!this.verticalGroup) {
-            super.measureLeftOuterAxes();
             return;
         }
         this.verticalGroup.onLeftSizeChanged(this.id, this.chartLayoutState.leftOuterAreaSize);
@@ -80,7 +79,6 @@
     measureRightOuterAxes() {
         super.measureRightOuterAxes();
         if (!this.verticalGroup) {
-            super.measureRightOuterAxes();
             return;
         }
         this.verticalGroup.onRightSizeChanged(this.id, this.chartLayoutState.rightOuterAreaSize);
```

**Trade-off:** In the normal case none: the removed call recomputes identical state from identical inputs, and the result matches the existing top and bottom overrides, which already return after a single super call. One corner case changes layout: when the surface has a negative top or bottom padding (so topOuterAreaSize or bottomOuterAreaSize is negative) and a left or right axis has a borderTop or borderBottom, updateTopAndBottomChartLayoutState adds the border instead of taking the max, so today the border is added twice. After the fix it is added once, the same as with the default LayoutManager; the series area of such a chart moves by that border width.

## App-side workaround

Use the default LayoutManager instead of SciChartHorizontalGroup, and align the charts by setting the same axisThickness on their top and bottom X axes. axisThickness is a minimum, so labels taller than it break the alignment. Otherwise, adding the charts to a SciChartVerticalGroup as well removes the duplicate path, but that also aligns the left and right axis widths.

## Verify

measure.md#fps: 4 surfaces in one SciChartHorizontalGroup, each with a left Y axis, one appendRange per series per frame for 10 s, 5 runs per side. Also wrap AxisBase2D.prototype.measure in a counter. Pass: the Y-axis measure() calls per frame per axis drop from 2 to 1, the PerformanceDebugHelper LayoutStart->LayoutEnd span gets shorter, and compare-runs gives win or neutral on frameP95Ms with no regression on the other four metrics.

## Other locations

- `esm/Charting/LayoutManager/SynchronizedLayoutManager.js:83` — same duplicate for right outer axes (super.measureRightOuterAxes() on lines 81 and 83)
- `esm/Charting/LayoutManager/SciChartHorizontalGroup.js:16` — new SynchronizedLayoutManager(undefined, this): every chart added to a horizontal group gets a manager with no verticalGroup, so the duplicate path runs unless the chart is also added to a vertical group
- `esm/Charting/LayoutManager/SciChartVerticalGroup.js:62` — removing a chart from the vertical group while it stays in the horizontal group sets verticalGroup = undefined, which also enables the duplicate path
- `esm/Charting/Visuals/Axis/AxisBase2D.js:582` — the work that is duplicated: measure() calls getTicks(true), which bypasses tickCache and regenerates ticks and labels, and then axisRenderer.measure computes the label size
- `esm/Charting/LayoutManager/AxisLayoutHelpers.js:66` — updateTopAndBottomChartLayoutState: Math.max (idempotent) for non-negative top/bottom sizes, but additive when the size is negative, so the duplicate call adds a Y axis borderTop/borderBottom twice in that case

## Review notes

- Found by reviewer slice `s11-layout-core-themes`.
- Adversarial verification (corrected): Re-read SynchronizedLayoutManager.js:61-66 and :80-85 (code_quote matches :61-66 verbatim; the second super call is at :64 and :83, top/bottom overrides at :100-104 and :118-122 return after one super call). Caller chain re-established: SciChartSurface.doDrawingLoop (SciChartSurface.js:605) -> sciChartRenderer.render (SciChartRenderer.js:88, guards are only isDeleted/hasInvalidState) -> layoutManager.layoutChart (SciChartRenderer.js:153, no layout-dirty guard, so every rendered frame) -> SynchronizedLayoutManager.layoutChart horizontalGroup branch (:38-43) -> LayoutManager.layoutChart (LayoutManager.js:149) -> this.measureLeftOuterAxes()/measureRightOuterAxes() (:163-164) -> LayoutManager.measureLeftOuterAxes (:221) twice -> LeftAlignedOuterAxisLayoutStrategy.measureAxes -> axis.measure() (:20) -> AxisBase2D.measure (:578) -> getTicks(true) (:582; regenerate=true bypasses tickCache at :1345, so delta, tick arrays, two filters and getLabels run again) + axisRenderer.measure (AxisRenderer.js:69; vertical fast path scans labelInfos textureWidth, LabelProviderBase2D.js:338-346). SciChartHorizontalGroup.addSurfaceToGroup (:16) constructs the manager with verticalGroup undefined; SciChartVerticalGroup.js:62 clears it on removal. Re-ran agent-scratch/s11-count-measure.cjs (cjs build, mocks): default LayoutManager {Bottom:1, Left:1, Right:1}, horizontal-group manager {Bottom:1, Left:2, Right:2} measure() calls per layoutChart. Rule V8-01 'merge repeated passes over the same data' applies; its Avoid field does not excuse this case. Severity medium kept: it is per frame, but the duplicate is a bounded constant (one extra axis measure per Y axis, ~10-20 labels, second getLabels pass hits the label cache) and only for charts in a horizontal group without a vertical group. Evidence S kept (mechanism certain, call count confirmed). Corrections: (1) title overstated scope: a chart in both a horizontal and a vertical group has verticalGroup set and is not affected; (2) why_it_costs and trade_off claimed the second pass is fully idempotent, but AxisLayoutHelpers.updateTopAndBottomChartLayoutState (:66-75) ADDS additionalTopSize/additionalBottomSize (the Y axis borderTop/borderBottom, AxisLayoutHelpers.js:10-11) when topOuterAreaSize/bottomOuterAreaSize is negative (possible with a negative surface padding.top/bottom, LeftAlignedOuterAxisLayoutStrategy.js:17 / TopAlignedOuterAxisLayoutStrategy.js:17). agent-scratch/v047-negpad.cjs with padding.top=-10 and a left axis borderTop=5 shows topOuterAreaSize -5 under the default LayoutManager but 0 under the horizontal-group manager, so the fix changes layout in that corner case (to match the default LayoutManager); (3) fix_diff rewritten as a unified diff with real hunk ranges and 3 lines of context, checked with patch --dry-run against an LF-normalized copy (the shipped file uses CRLF); (4) removed the two other_locations entries that duplicated the primary line 64 and the line 83 entry; (5) scale refined to describe the label-size step accurately.
- Duplicate merged from slice `x1-frame-path`: SynchronizedLayoutManager measures left and right outer axes twice per frame when a surface is in a horizontal group without a vertical group
