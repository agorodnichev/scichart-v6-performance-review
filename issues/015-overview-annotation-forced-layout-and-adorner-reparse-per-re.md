# 015 · SciChartOverview's range-selection annotations force a layout (getBoundingClientRect, result unused) and re-parse the grip adorner on every overview render

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Annotations/OverviewCustomResizableAnnotation.js:230` |
| Severity | **high** |
| Pipeline stage | Layout (`layout`) |
| Metric | frame time |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/10d3fa1deed16487db613392cdd65235/): reproduced on WebGL and WebGPU ([source](../demos/015-overview-annotation-forced-layout/)) |
| Rule | EVT-07, DOM-07 (web-performance skill) |
| Effort to fix | small |

## Code

```js
            this.setSvgAttribute("x", svgXCoord);
            this.setSvgAttribute("y", svgYCoord);
            this.setSvgAttribute("width", width);
            this.setSvgAttribute("height", height);
            this.svgDOMRect = this.svg.getBoundingClientRect();
        }
        this.updateAdornerInner();
```

## Call path and frequency

Main chart appendRange or visible-range change -> overview surface render (shared dataSeries, SciChartOverview.js:194/:202; selectedArea sync :236-241) -> SciChartRenderer.render -> getAnnotationDrawFunctions (SciChartRenderer.js:201 -> :360, modifier loop :375) -> getHTMLAnnotationDrawFunction (:382, update at :396) -> OverviewCustomResizableAnnotation.update (OverviewCustomResizableAnnotation.js:200) -> create (:202 -> CustomAnnotation.js:89-90 -> DomAnnotationBase.calcAndSetAnnotationBorders :256 -> SvgAnnotationBase.getSize :139 -> getSvgDomRect, served from the rect cached last render) -> style writes (:203-204) -> setAnnotationBorders (:209, overwrites the create() borders) -> setSvgAttribute x4 (:226-229) -> getBoundingClientRect (:230) -> updateAdornerInner (:232 -> :431-438 -> annotationHelpers.createSvg). Rate: 3 annotations per overview render, which is per frame while the main chart streams or is panned or zoomed.

## Why it costs

Each instance writes styles and attributes, then calls getBoundingClientRect, which runs style and layout synchronously. The next instance writes again and reads again, so there are three forced layouts per render; the drag box's adorner re-insert also dirties layout before the next instance's read. The stored rect has no effect. Its only reader is the next render's create() -> calcAndSetAnnotationBorders -> getSize, and update() overwrites those borders at :209 with coordinates computed from the axes. The drag box's adorner SVG is also removed and re-parsed on every render, even when its markup is unchanged. On frames where the overview X range grows (the overview axes use EAutoRange.Always), the box moves in pixels and that rebuild is needed.

**Scale where it matters:** Every SciChartOverview: 3 interleaved forced layouts plus 1 adorner parse per overview render, and the overview renders on every data update of the shared series.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/Annotations/OverviewCustomResizableAnnotation.js
+++ b/esm/Charting/Visuals/Annotations/OverviewCustomResizableAnnotation.js
@@ update(xCalc, yCalc, xCoordSvgTrans, yCoordSvgTrans) {
             this.setSvgAttribute("height", height);
-            this.svgDOMRect = this.svg.getBoundingClientRect();
+            // size was just written; keeps getSize() (read by next render's create()) current without a layout read.
+            // Setting it to undefined instead would make create() call getBBox and keep the forced layout.
+            this.svgDOMRect = new DOMRect(svgXCoord, svgYCoord, width, height);
         }
         this.updateAdornerInner();
@@ updateAdornerInner() {
-        this.deleteAdorner();
-        if (this.adornerSvgStringTemplate) {
-            const { x1, x2, y1, y2 } = this.getAdornerAnnotationBorders(true);
-            const svgString = this.adornerSvgStringTemplate(x1, y1, x2, y2);
-            const clippedSvgString = this.applySvgClipping(svgString, this.adornerClipping);
-            this.svgAdorner = annotationHelpers.createSvg(clippedSvgString, this.svgAdornerRoot);
-        }
+        if (!this.adornerSvgStringTemplate) {
+            this.deleteAdorner();
+            return;
+        }
+        const { x1, x2, y1, y2 } = this.getAdornerAnnotationBorders(true);
+        const svgString = this.adornerSvgStringTemplate(x1, y1, x2, y2);
+        const clippedSvgString = this.applySvgClipping(svgString, this.adornerClipping);
+        // same markup as the adorner already in the DOM: keep it instead of removing and re-parsing it
+        if (this.svgAdorner && clippedSvgString === this.lastAdornerSvgString) {
+            return;
+        }
+        this.deleteAdorner();
+        this.lastAdornerSvgString = clippedSvgString;
+        this.svgAdorner = annotationHelpers.createSvg(clippedSvgString, this.svgAdornerRoot);
     }
```

**Trade-off:** svgDOMRect now holds the geometry just written (SVG user units, x/y in SVG-root coordinates) instead of a getBoundingClientRect result (CSS px, viewport x/y). getSize() returns the same width and height unless the SVG root is CSS-scaled, and no library code reads x/y; the in-library reader's result is overwritten at :209 anyway. deleteAdorner() still clears svgAdorner, so any other removal forces a rebuild on the next update. The adorner is still re-parsed whenever its markup changes, which includes every frame where the overview X range grows, and each pan or zoom step of the main chart.

## App-side workaround

Partial. Pass `customRangeSelectionModifier` with createAnnotation overridden to return a subclass whose updateAdornerInner skips when the borders are unchanged. The forced layout needs the library fix or an overridden update().

## Verify

measure.md#fps: main chart plus SciChartOverview. Scenario A: one appendRange per frame for 10 s. Scenario B: Y-only updates in place (dataSeries.updateRange) for 10 s, so the overview X range and the box stay fixed in pixels. Scenario C: a pan scenario on the main chart. Pass: 'Forced by script' in trace-summary shows no layout from OverviewCustomResizableAnnotation.update or from getSvgDomRect in A, B and C; a MutationObserver on the adorner layer counts 0 childList changes per frame in B; frame p95 wins or stays neutral in all three (compare-runs, 5 runs per side).

## Other locations

- `esm/Charting/Visuals/Annotations/OverviewCustomResizableAnnotation.js:232` — updateAdornerInner on every render; :431-438 deletes and re-parses the adorner whenever adornerSvgStringTemplate is set, without checking selection or movement
- `esm/Charting/ChartModifiers/OverviewRangeSelectionModifier.js:243` — three instances per overview (drag box + before/after shading); the drag box gets an adornerSvgStringTemplate at :258/:264

## Review notes

- Found by reviewer slice `s07-annotations-legend`.
- Adversarial verification (corrected): Re-read OverviewCustomResizableAnnotation.js:1-240 and :428-439, CustomAnnotation.js:36-121, DomAnnotationBase.js:172-180 and :252-285, SvgAnnotationBase.js:71-80 and :139-144, AnnotationBase.js:1076-1081, OverviewRangeSelectionModifier.js:216-282, SciChartOverview.js:150-245 and SciChartRenderer.js:360-396. The code_quote matches :226-232 verbatim. Every update() writes style.display/opacity (:203-204) and four attributes (:226-229), then calls getBoundingClientRect (:230), then updateAdornerInner (:232). The override at :431-438 deletes and re-parses the adorner whenever adornerSvgStringTemplate is set, with no isSelected or change check. createAnnotation (:216-217) creates three OverviewCustomResizableAnnotation instances (:243-256), and only the drag box gets a template (:258/:264). Per-render chain confirmed: render -> getAnnotationDrawFunctions (:201 -> :360, modifier loop :375) -> getHTMLAnnotationDrawFunction (:382, update at :396), with no visibility guard. The overview series share the main chart's dataSeries (SciChartOverview.js:194/:202), so every data update re-renders the overview. Main-axis pan or zoom moves the box (SciChartOverview.js:236-241 -> selectedArea -> x1/x2 -> invalidate). Severity high and evidence S hold. Corrections: (1) The claim 'svgDOMRect is not read anywhere / getSize and getSvgDomRect are never called on this update path' is wrong. update() first calls create() (:202). In steady state (svg exists, isDirty false, isPositionDependent false) CustomAnnotation.create (:89-90) runs calcAndSetAnnotationBorders (DomAnnotationBase.js:256-257) -> getSize (SvgAnnotationBase.js:139-143) -> getSvgDomRect, which returns the rect stored by the previous render. Those borders are then overwritten by setAnnotationBorders at :209, so the value never matters, but the reader exists. (2) That reader breaks the proposed fix. With `this.svgDOMRect = undefined`, the next render's create() would reach getSvgDomRect with no cached rect and call getBBox (SvgAnnotationBase.js:77), so the forced layout moves into create() instead of going away. Corrected fix: store a DOMRect built from the values just written, so no layout read happens anywhere. (3) The adorner fix now keys on the final clipped markup inside updateAdornerInner itself. CustomAnnotation.create (:91-93) also calls updateAdornerInner while the box is selected, and a key checked only in update() could leave that create-time adorner in place. (4) The overview axes use EAutoRange.Always (SciChartOverview.js:152/:159), so with appendRange streaming the box moves in pixels on most frames and the adorner is legitimately rebuilt. The adorner saving applies only to renders where the box's pixel geometry is unchanged (Y-only updates, svg-only re-renders). why_it_costs, trade_off and verify are corrected to match, and verify now uses Y-only updates for the adorner check.

