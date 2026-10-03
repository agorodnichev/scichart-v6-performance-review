# 045 · RolloverModifier.update() hit-tests every series a second time to fill the legend, and runs on every pointer event and every full render

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/ChartModifiers/RolloverModifier.js:468` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time during hover (also per-frame cost on live charts) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | SC-27, V8-01 (web-performance skill) |
| Effort to fix | small |

## Code

```js
    update() {
        this.updateLine();
        this.updateSeriesAnnotations();
        if (this.tooltipLegendTemplate) {
            this.legendAnnotation.seriesInfos = this.getSeriesInfos();
        }
    }
```

## Call path and frequency

Per pointer event: MouseManager.onPointerMove (MouseManager.js:107) -> modifierMouseMove loop (:319-322) -> RolloverModifier.modifierMouseMove (RolloverModifier.js:252) -> update() (:273). Per full render: SciChartRenderer.render -> cm.onParentSurfaceLayoutComplete() (SciChartRenderer.js:170-182) -> RolloverModifier.onParentSurfaceLayoutComplete (:294-295) -> update(). Inside update: updateSeriesAnnotations hit-tests each series (:579) and builds a SeriesInfo per hit (calcTooltipProps :682). getSeriesInfos (:631-641) then calls hitTestRenderableSeries and rs.getSeriesInfo again for every series (:634, :638). With snapToDataPoint, updateLine hit-tests the first series a third time (:480-483). Each call also rebuilds the series list with two filters (getIncludedRenderableSeries :321-335).

## Why it costs

For the same mousePoint and the same series list within one update, the per-series hit test and SeriesInfo construction run twice, and the first series three times with snapToDataPoint. The duplicate pass runs on the input path and in every render, so the script time per frame for hover doubles with the series count.

**Scale where it matters:** 10-100 series with a tooltipLegendTemplate (the rollover legend pattern), hovering, or a live chart that renders every frame. Each hit test is a wasm GetNearestXyPoint call plus HitTestInfo/SeriesInfo allocation. For unsorted series the wasm search is O(points) per series (hitTestHelpers.js:86-96).

## Fix (library side)

```diff
--- esm/Charting/ChartModifiers/RolloverModifier.js
@@ updateSeriesAnnotations()
         const tooltipArray = [];
+        const hitTestInfos = rsList.map(rs => this.hitTestRenderableSeries(rs, this.mousePoint));
+        this.lastHitTests = { rsList, hitTestInfos }; // reused by getSeriesInfos() in the same update()
         ...
         rsList.forEach((rs, index) => {
-            const hitTestInfo = this.hitTestRenderableSeries(rs, this.mousePoint);
+            const hitTestInfo = hitTestInfos[index];
@@ getSeriesInfos()
-        return this.getIncludedRenderableSeries()
-            .map(rs => {
-            const hitTestInfo = this.hitTestRenderableSeries(rs, this.mousePoint);
+        const cached = this.lastHitTests;
+        return (cached ? cached.rsList : this.getIncludedRenderableSeries())
+            .map((rs, i) => {
+            const hitTestInfo = cached ? cached.hitTestInfos[i] : this.hitTestRenderableSeries(rs, this.mousePoint);
@@ update()  (and VerticalSliceModifier.update)
         if (this.tooltipLegendTemplate) {
             this.legendAnnotation.seriesInfos = this.getSeriesInfos();
         }
+        this.lastHitTests = undefined; // valid only within one update
     }
```

**Trade-off:** None in output: same series list, same mousePoint, same hit-test results. The cache holds the hit-test infos of the last update only until the end of update(). Outside the series area, updateSeriesAnnotations returns before hit-testing, so the legend keeps its current fallback path.

## App-side workaround

Leave tooltipLegendTemplate unset. Or subclass RolloverModifier and override getSeriesInfos() to return each included series' rolloverModifierProps.tooltip.seriesInfo, which updateSeriesAnnotations already set (it covers only visible tooltips).

## Verify

measure.md#fps hover scenario: 50 line series, RolloverModifier with tooltipLegendTemplate, pointer sweeping across the chart for 5 s, 5 runs per side, with a dev counter of hitTestXSlice calls per update(). Pass: the counter equals the series count (twice the series count before), LoAF script time for the pointermove frame goes down, and frameP95Ms wins or is neutral.

## Other locations

- `esm/Charting/ChartModifiers/RolloverModifier.js:579` — first hit-test pass
- `esm/Charting/ChartModifiers/RolloverModifier.js:634` — second hit-test pass in getSeriesInfos
- `esm/Charting/ChartModifiers/RolloverModifier.js:483` — third hit test of the first series when snapToDataPoint
- `esm/Charting/ChartModifiers/RolloverModifier.js:295` — update() also runs in every full render
- `esm/Charting/ChartModifiers/VerticalSliceModifier.js:1` — update() repeats the same updateSeriesAnnotations + getSeriesInfos pair on every render

## Review notes

- Found by reviewer slice `s10-modifiers-input`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

