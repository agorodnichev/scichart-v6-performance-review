# 092 · Every SVG annotation rewrites style and x/y attributes on every render, even when nothing changed

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Annotations/SvgAnnotationBase.js:59` |
| Severity | **low** |
| Pipeline stage | Style (`style`) |
| Metric | frame time |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | DOM-04 (web-performance skill) |
| Effort to fix | small |

## Code

```js
        this.svg.style.visibility = this.isHidden ? "hidden" : "visible";
        this.svg.style.opacity = this.opacity.toString();
        const { x, y } = this.convertPolarToCartesian(this.getX1Coordinate(xCalc, yCalc), this.getY1Coordinate(xCalc, yCalc), true);
        const x1Coord = shiftX + x + xCoordSvgTrans;
        const y1Coord = shiftY + y + yCoordSvgTrans;
        if (isNaN(x1Coord) || isNaN(y1Coord) || !isFinite(x1Coord) || !isFinite(y1Coord)) {
            this.svg.style.display = "none";
        }
        else {
            this.setSvgAttribute("x", x1Coord);
            this.setSvgAttribute("y", y1Coord);
        }
```

## Call path and frequency

SciChartRenderer.render -> getAnnotationDrawFunctions (SciChartRenderer.js:201) -> getHTMLAnnotationDrawFunction (:396), and renderDomOnly -> drawSvgAnnotations (:532 -> :550) -> SvgAnnotationBase.update (SvgAnnotationBase.js:30-61) -> setSvgAttribute (:121-124). Rate: once per SVG annotation per render.

## Why it costs

Hypothesis: Chromium appears to skip inline-style writes whose value is unchanged, but setAttribute on SVG geometry attributes runs attribute-changed handling and re-invalidates that SVG's style and layout even when the value is identical. Static annotations then add style and layout work proportional to annotation count on every frame, plus per-frame toString allocations.

**Scale where it matters:** H: matters with hundreds of static TextAnnotation or CustomAnnotation markers on a chart that redraws every frame (streaming).

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/Annotations/SvgAnnotationBase.js
+++ b/esm/Charting/Visuals/Annotations/SvgAnnotationBase.js
@@ -50,2 +50,4 @@
-        this.svg.style.visibility = this.isHidden ? "hidden" : "visible";
-        this.svg.style.opacity = this.opacity.toString();
+        const s = this.svg.style, vis = this.isHidden ? "hidden" : "visible", op = this.opacity.toString();
+        if (s.visibility !== vis) s.visibility = vis;   // inline-style read: no layout
+        if (s.opacity !== op) s.opacity = op;
@@ setSvgAttribute(attributeName, value) {
         const strValue = value.toString(10);
-        this.svg.firstElementChild.setAttribute(attributeName, strValue);
+        const el = this.svg.firstElementChild;
+        if (el.getAttribute(attributeName) !== strValue) el.setAttribute(attributeName, strValue);   // attribute read, no layout
```

**Trade-off:** One getAttribute or inline-style read per write. Neither forces layout.

## App-side workaround

For many static labels use render-context annotations (NativeTextAnnotation, BoxAnnotation, etc.) per SC-21.

## Verify

measure.md#fps: 200 static TextAnnotations on a chart streaming one appendRange per frame for 10 s. Pass: trace-summary 'Style' elements per frame and Layout dirtyObjects drop against baseline, and frame p95 wins or stays neutral. If they do not drop, Chromium already skips same-value writes; drop this finding.

## Other locations

- `esm/Charting/Visuals/Annotations/SvgLineAnnotation.js:284` — x1/y1/x2/y2 + visibility/opacity on every update
- `esm/Charting/Visuals/Annotations/OverviewCustomResizableAnnotation.js:226` — x/y/width/height on every update

## Review notes

- Found by reviewer slice `s07-annotations-legend`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

