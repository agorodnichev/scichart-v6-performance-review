# 015 · SciChartOverview's range-selection annotations force a layout (getBoundingClientRect, result unused) and re-parse the grip adorner on every overview render

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Annotations/OverviewCustomResizableAnnotation.js:230` |
| Severity | **high** |
| Pipeline stage | Layout (`layout`) |
| Metric | frame time |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
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

Main chart appendRange or visible-range change -> overview surface render -> SciChartRenderer.render -> getAnnotationDrawFunctions (SciChartRenderer.js:201) -> getHTMLAnnotationDrawFunction (:396) -> OverviewCustomResizableAnnotation.update (OverviewCustomResizableAnnotation.js:200) -> setSvgAttribute x4 (:226-229) -> getBoundingClientRect (:230) -> updateAdornerInner (:232 -> :431-438 -> annotationHelpers.createSvg). Rate: 3 annotations per overview render, which is per frame while the main chart streams or is panned or zoomed.

## Why it costs

Each instance writes styles and attributes, then calls getBoundingClientRect, which runs style and layout synchronously. The next instance writes again and reads again, so three forced layouts per render. The stored rect is dead: getSize and getSvgDomRect are never called on this update path. The drag box's adorner SVG is also removed and re-parsed each render even when the box has not moved.

**Scale where it matters:** Every SciChartOverview: 3 interleaved forced layouts plus 1 adorner parse per overview render, and the overview renders on every data update of the shared series.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/Annotations/OverviewCustomResizableAnnotation.js
+++ b/esm/Charting/Visuals/Annotations/OverviewCustomResizableAnnotation.js
@@ -229,4 +229,9 @@
             this.setSvgAttribute("height", height);
-            this.svgDOMRect = this.svg.getBoundingClientRect();
+            this.svgDOMRect = undefined;   // not read here; getSvgDomRect() measures lazily if ever asked
         }
-        this.updateAdornerInner();
+        const b = this.getAdornerAnnotationBorders(true);
+        const adornerKey = `${b.x1},${b.x2},${b.y1},${b.y2}`;
+        if (!this.svgAdorner || adornerKey !== this.lastAdornerKey) {   // re-parse only when the box moved
+            this.lastAdornerKey = adornerKey;
+            this.updateAdornerInner();
+        }
@@ set adornerSvgStringTemplate(value) {
         this.adornerSvgStringTemplateProperty = value;
+        this.lastAdornerKey = undefined;
```

**Trade-off:** A subclass that reads svgDOMRect directly gets a lazily measured getBBox size (user units) instead of a per-render getBoundingClientRect size (CSS px). The two are equal unless the SVG is CSS-scaled.

## App-side workaround

Partial. Pass `customRangeSelectionModifier` with createAnnotation overridden to return a subclass whose updateAdornerInner skips when the borders are unchanged. The forced layout needs the library fix or an overridden update().

## Verify

measure.md#fps: main chart plus SciChartOverview, streaming one appendRange per frame for 10 s with the selection box still, then a pan scenario. Pass: 'Forced by script' shows no layout from OverviewCustomResizableAnnotation.update, a MutationObserver on domSvgAdornerLayer counts 0 childList changes per frame while the box is still, and frame p95 wins or stays neutral.

## Other locations

- `esm/Charting/Visuals/Annotations/OverviewCustomResizableAnnotation.js:232` — updateAdornerInner on every render; :431-438 deletes and re-parses the adorner whenever adornerSvgStringTemplate is set, without checking selection or movement
- `esm/Charting/ChartModifiers/OverviewRangeSelectionModifier.js:243` — three instances per overview (drag box + before/after shading); the drag box gets an adornerSvgStringTemplate at :258/:264

## Review notes

- Found by reviewer slice `s07-annotations-legend`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

