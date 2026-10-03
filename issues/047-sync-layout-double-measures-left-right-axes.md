# 047 · SynchronizedLayoutManager measures left and right outer axes twice per frame when the chart has no vertical group, which is the case for every SciChartHorizontalGroup chart

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/LayoutManager/SynchronizedLayoutManager.js:64` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (script per frame) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
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

For each left and right outer axis, every rendered frame regenerates the tick and label arrays twice and measures label sizes twice. The second pass produces the same values as the first. updateTopAndBottomChartLayoutState is idempotent (Math.max) and updateAreaSize assigns the same requiredSize. The script time and short-lived allocations of one full axis measure are added to every frame for each Y axis of each grouped chart.

**Scale where it matters:** Matters for dashboards of side-by-side charts that use SciChartHorizontalGroup, with 1-2 Y axes per chart, at the render rate (up to the display refresh rate while streaming, zooming or panning). The duplicated work for each Y axis is: delta calculation, tick provider arrays, two filter passes, label-cache lookups or formatting for about 10-20 labels, and the label-size measurement loop.

## Fix (library side)

```diff
--- a/esm/Charting/LayoutManager/SynchronizedLayoutManager.js
+++ b/esm/Charting/LayoutManager/SynchronizedLayoutManager.js
@@ measureLeftOuterAxes() {
         super.measureLeftOuterAxes();
         if (!this.verticalGroup) {
-            super.measureLeftOuterAxes();
             return;
         }
@@ measureRightOuterAxes() {
         super.measureRightOuterAxes();
         if (!this.verticalGroup) {
-            super.measureRightOuterAxes();
             return;
         }
```

**Trade-off:** None expected. The removed call recomputes identical state from identical inputs. This matches the existing top and bottom overrides, which already return after a single super call.

## App-side workaround

Use the default LayoutManager instead of SciChartHorizontalGroup, and align the charts by setting the same axisThickness on their top and bottom X axes. axisThickness is a minimum, so labels taller than it break the alignment. Otherwise, adding the charts to a SciChartVerticalGroup as well removes the duplicate path, but that also aligns the left and right axis widths.

## Verify

measure.md#fps: 4 surfaces in one SciChartHorizontalGroup, each with a left Y axis, one appendRange per series per frame for 10 s, 5 runs per side. Also wrap AxisBase2D.prototype.measure in a counter. Pass: the Y-axis measure() calls per frame per axis drop from 2 to 1, the PerformanceDebugHelper LayoutStart->LayoutEnd span gets shorter, and compare-runs gives win or neutral on frameP95Ms with no regression on the other four metrics.

## Other locations

- `esm/Charting/LayoutManager/SynchronizedLayoutManager.js:83` — same duplicate for right outer axes (super.measureRightOuterAxes() on lines 81 and 83)
- `esm/Charting/LayoutManager/SciChartHorizontalGroup.js:16` — new SynchronizedLayoutManager(undefined, this): every chart added to a horizontal group gets a manager with no verticalGroup, so the duplicate path runs
- `esm/Charting/LayoutManager/SciChartVerticalGroup.js:62` — removing a chart from the vertical group while it stays in the horizontal group sets verticalGroup = undefined, which also enables the duplicate path
- `esm/Charting/Visuals/Axis/AxisBase2D.js:582` — the work that is duplicated: measure() calls getTicks(true), which regenerates ticks and labels, and then axisRenderer.measure measures label sizes
- `esm/Charting/LayoutManager/SynchronizedLayoutManager.js:64` — same root cause, also reported by slice x1-frame-path: SynchronizedLayoutManager measures left and right outer axes twice per frame when a surface is in a horizontal group without a vertical group
- `esm/Charting/LayoutManager/SynchronizedLayoutManager.js:83` — same duplicate for right outer axes

## Review notes

- Found by reviewer slice `s11-layout-core-themes`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.
- Duplicate merged from slice `x1-frame-path`: SynchronizedLayoutManager measures left and right outer axes twice per frame when a surface is in a horizontal group without a vertical group
