# 045 · RolloverModifier.update() hit-tests every series a second time to fill the legend, and runs on every pointer event and every full render

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/ChartModifiers/RolloverModifier.js:464` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time during hover (also per-frame cost on live charts) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/869326ed5573792c1689cceaf8ad313c/): reproduced on WebGL and WebGPU ([source](../demos/045-rollover-double-hit-test/)) |
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
- `esm/Charting/ChartModifiers/VerticalSliceModifier.js:184` — update() repeats the same updateSeriesAnnotations + getSeriesInfos pair on every render

## Review notes

- Found by reviewer slice `s10-modifiers-input`.
- Adversarial verification (corrected): Re-read RolloverModifier.js:252-296 (modifierMouseMove -> update at :273; onParentSurfaceLayoutComplete -> update at :294-295), :321-336 (getIncludedRenderableSeries), :342-352 (hitTestRenderableSeries), :464-470 (update), :471-485 (updateLine snapToDataPoint hit test at :483), :537-630 (updateSeriesAnnotations; hit test per series at :579 after the out-of-series-area early return), :631-641 (getSeriesInfos: hit test at :634 and getSeriesInfo at :638 again for every included series), VerticalSliceModifier.js:184-197 (same updateSeriesAnnotations + getSeriesInfos pair), SciChartRenderer.js:169-182 (onParentSurfaceLayoutComplete for every modifier on every full render), MouseManager.js:322 (per-pointermove dispatch), BaseHitTestProvider.js:66-110 (hitTestXSlice: wasm nearest-point search plus a fresh HitTestInfo and a valueNames reduce per call). No cache or dirty flag between the two passes: same mousePoint, same series list, and nothing in calcTooltipProps/updateRolloverModifierProps writes to the HitTestInfo, so reusing the first pass is output-identical. The other getSeriesInfos callers (RolloverModifier.js:239, :309) run outside update(), so clearing the cache at the end of update() keeps them on the uncached path. Corrections: primary line 468 -> 464 (where the quoted update() starts); VerticalSliceModifier location line 1 -> 184. Severity kept medium: it runs per pointermove and per full render, but only when the opt-in tooltipLegendTemplate is set, and it doubles an existing per-series cost rather than adding a new scaling term. Evidence S: the duplicate pass is unconditional on that path.

