# 049 · Pie label placement reads offsetWidth/offsetHeight right after writing each label's styles and innerHTML, forcing one layout per segment per draw

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/SciChartPieSurface/SciChartPieSurface.js:727` |
| Severity | **medium** |
| Pipeline stage | Layout (`layout`) |
| Metric | INP (also frame time during pie animations) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | EVT-07 (web-performance skill) |
| Effort to fix | small |

## Code

```js
        div.style.color = el.labelStyle.color;
        div.style.fontWeight = el.labelStyle.fontWeight;
        div.style.fontFamily = getFontFamily(el.labelStyle.fontFamily, false);
        div.style.fontSize = el.labelStyle.fontSize.toString() + "px";
        div.innerHTML = el.getLabelText(totalValue);
        const divWidth = div.offsetWidth;
        const divHeight = div.offsetHeight;
```

## Call path and frequency

SciChartPieSurface.draw (SciChartPieSurface.js:551) -> drawChart (:599) -> segments.forEach (:623) -> drawSegmentLabel per labeled segment (:657-659 -> :704) -> style + innerHTML writes (:722-726), offsetWidth/offsetHeight read (:727-728), left/top writes (:750-751), then the next segment's writes and read. Draw rate: every property set (invalidateElement :208-214), every resize (changeViewportSize :260-265), 10 draws per segment click (helpers/addEventListenerToPieSegment.js:18-27), and up to 31 draws per value change with animate on (sweep steps :568-581 draw labels when el.oldValue is set, :657).

## Why it costs

Each label write (innerHTML, font styles, and on non-animated draws a freshly created and appended div) invalidates style and layout. The offsetWidth read that follows forces Blink to run style and layout synchronously inside script. Writing left/top then invalidates layout again, so the next segment's read forces another full layout. The result is layout thrashing: one forced layout per segment per draw, repeated 10 to 30 times per interaction because of the timer-driven animations.

**Scale where it matters:** 5 to 30 labeled segments per pie. 10 to 31 draws per click or value change, plus one per property set. Each draw costs N forced style+layout passes instead of one, over the whole chart root subtree (SVG, legend, label divs).

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/SciChartPieSurface/SciChartPieSurface.js
+++ b/esm/Charting/Visuals/SciChartPieSurface/SciChartPieSurface.js
@@ drawChart(animationProgress = 1) {
+        const labelJobs = [];
         segments.forEach((el, index) => {
@@
             if (animationProgress === 1 || el.oldValue) {
-                this.drawSegmentLabel(el, index, totalValue, angleFrom, angleTo, xCoord, yCoord, outerRadius * el.radiusAdjustment, innerRadius);
+                labelJobs.push([el, index, angleFrom, angleTo, outerRadius * el.radiusAdjustment]);
             }
         });
+        // all writes, then one read pass (one layout), then the position writes
+        const divs = labelJobs.map(([el, index]) => this.writeSegmentLabel(el, index, totalValue)); // lines 706-726, returns undefined when showLabel === false
+        const sizes = divs.map(div => div && [div.offsetWidth, div.offsetHeight]);
+        labelJobs.forEach(([el, , a1, a2, r], i) => divs[i] &&
+            this.placeSegmentLabel(divs[i], sizes[i][0], sizes[i][1], el, a1, a2, xCoord, yCoord, r, innerRadius)); // lines 729-751
@@ drawSegmentLabel -> split into writeSegmentLabel / placeSegmentLabel (both private)
-        div.style.color = el.labelStyle.color;  ... (4 getter calls, each spreads a new object)
+        const style = el.labelStyle;            // one spread per label
+        div.style.color = style.color; ...
```

**Trade-off:** None in behavior. drawChart and drawSegmentLabel are private in the typings, and calcTitlePosition (the public override point) keeps its signature and is still called once per label with the measured size. The label divs now exist in the DOM a moment longer before they are positioned, but no frame is rendered in between, because everything runs in the same task.

## App-side workaround

Set showLabel:false on the segments and render the labels yourself (read all sizes first, then write positions), or label fewer segments.

## Verify

measure.md#inp, clicking a segment of a 12-segment pie with animate:false (one draw), and measure.md#fps during the 600 ms value-change animation, 5 runs per side. Pass: the ForcedReflow insight is gone or drops to one per draw, 'Forced by script' in trace-summary drops for drawSegmentLabel, and forcedLayoutMs in __wpProbe.loaf.read() goes down.

## Other locations

- `esm/Charting/Visuals/SciChartPieSurface/SciChartPieSurface.js:750` — left/top writes invalidate layout before the next segment's read
- `esm/Charting/Visuals/SciChartPieSurface/SciChartPieSurface.js:711` — on non-animated draws every label div is created and appended again (deleteInternals() removed them at :247-250)
- `esm/Charting/Visuals/SciChartPieSurface/PieSegment/PieSegment.js:193` — the labelStyle getter spreads a new object and is read 4 times per label per draw

## Review notes

- Found by reviewer slice `s12-pie-3d-surface`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

