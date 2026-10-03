# 092 · Every SVG annotation rewrites its x/y (line: x1/y1/x2/y2) attributes on every render, even when the values are unchanged

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Annotations/SvgAnnotationBase.js:59` |
| Severity | **low** |
| Pipeline stage | Style (`style`) |
| Metric | frame time |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/69122af960cdcf3822f58d79f10b433f/): reproduced on WebGL and WebGPU ([source](../demos/092-svg-annotations-rewrite-unchanged-attributes/)) |
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

Full render: esm/Charting/Services/SciChartRenderer.js:201 getAnnotationDrawFunctions -> :365-367 (DOM annotations, no isVisible guard) -> getHTMLAnnotationDrawFunction :396 -> annotation.update. DOM-only render: SciChartSurface.invalidateElement({svgOnly}) :581-588 (rAF) -> SciChartRenderer.renderDomOnly :39-74 -> drawSvgAnnotations :532 -> :550 -> SvgAnnotationBase.update (SvgAnnotationBase.js:30-61) -> setSvgAttribute (:121-124); SvgLineAnnotation.update :284-287 writes lineEl directly. TextAnnotation.create :189 / CustomAnnotation.create :89 keep the cached SVG when !isDirty, so the same element is rewritten. Rate: once per SVG annotation per render; renders run per streamed frame and per pointer move with Rollover/Cursor modifiers (RolloverModifier.js:252 -> :273 -> :487 -> AnnotationBase.js:957-959).

## Why it costs

Hypothesis, not measured: inline-style writes with an unchanged value are already skipped by Blink and Gecko, and Gecko also skips a same-value setAttribute. In Chromium, setAttribute on an SVG geometry attribute (x/y on the nested <svg>, x1..y2 on <line>) appears to run the attribute-changed steps even for an identical value, which can mark that element for style recalc and SVG layout. Static annotations would then add style and layout work proportional to annotation count on every render.

**Scale where it matters:** H: matters with hundreds of static TextAnnotation, CustomAnnotation or SvgLineAnnotation markers on a chart that redraws every frame while axis ranges stay fixed (pointer-driven rollover/cursor renders, streaming into a fixed visible range). When the axis scrolls every frame the coordinates change anyway and the guard saves nothing.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/Annotations/SvgAnnotationBase.js
+++ b/esm/Charting/Visuals/Annotations/SvgAnnotationBase.js
@@ -121,4 +121,5 @@
     setSvgAttribute(attributeName, value) {
         const strValue = value.toString(10);
-        this.svg.firstElementChild.setAttribute(attributeName, strValue);
+        const el = this.svg.firstElementChild;
+        if (el.getAttribute(attributeName) !== strValue) el.setAttribute(attributeName, strValue);   // attribute read: no layout
     }
--- a/esm/Charting/Visuals/Annotations/SvgLineAnnotation.js
+++ b/esm/Charting/Visuals/Annotations/SvgLineAnnotation.js
@@ -12,0 +13,1 @@
+const setAttrIfChanged = (el, name, value) => { const s = value.toString(); if (el.getAttribute(name) !== s) el.setAttribute(name, s); };
@@ -284,4 +285,4 @@
-        this.lineEl.setAttribute("x1", x1.toString());
-        this.lineEl.setAttribute("y1", y1.toString());
-        this.lineEl.setAttribute("x2", x2.toString());
-        this.lineEl.setAttribute("y2", y2.toString());
+        setAttrIfChanged(this.lineEl, "x1", x1);
+        setAttrIfChanged(this.lineEl, "y1", y1);
+        setAttrIfChanged(this.lineEl, "x2", x2);
+        setAttrIfChanged(this.lineEl, "y2", y2);
```

**Trade-off:** One getAttribute and one string compare per write. Neither forces layout. No effect in engines that already skip same-value sets.

## App-side workaround

For many static labels use render-context annotations (NativeTextAnnotation, BoxAnnotation, etc.) per SC-21.

## Verify

measure.md#fps in Chromium: 200 static TextAnnotations plus 50 SvgLineAnnotations (HorizontalLineAnnotation/VerticalLineAnnotation SVG) on a chart with a fixed visible range, driven by RolloverModifier pointer moves (or one appendRange per frame into the fixed range) for 10 s. Pass: per-frame 'Style' element count and Layout dirty objects drop against baseline, and frame p95 wins or stays neutral. If they do not drop, Chromium already skips same-value writes; drop this finding.

## Other locations

- `esm/Charting/Visuals/Annotations/SvgLineAnnotation.js:284` — x1/y1/x2/y2 + visibility/opacity on every update
- `esm/Charting/Visuals/Annotations/OverviewCustomResizableAnnotation.js:226` — x/y/width/height on every update

## Review notes

- Found by reviewer slice `s07-annotations-legend`.
- Adversarial verification (corrected): Re-read SvgAnnotationBase.js:30-61 and :121-124: code_quote matches :50-61 verbatim (primary :59 is setSvgAttribute("x")). Caller chain confirmed: full render SciChartRenderer (esm/Charting/Services/SciChartRenderer.js, not Visuals/) :201 getAnnotationDrawFunctions -> :365-367/:373-375 (no isVisible guard for DOM annotations) -> getHTMLAnnotationDrawFunction :396 annotation.update; DOM-only render SciChartSurface.js:581-588 (rAF-coalesced) -> renderDomOnly :39-74 -> drawSvgAnnotations :532 -> :550 a.update. TextAnnotation.create :189 and CustomAnnotation.create :89 return early with the cached SVG when !isDirty, so update rewrites x/y on the same element each render with identical values whenever axis ranges did not change. SvgLineAnnotation.update :194-287 floors coordinates (:203-206) and rewrites x1/y1/x2/y2 via lineEl.setAttribute directly (not setSvgAttribute), so the original fix missed it; OverviewCustomResizableAnnotation :226-229 goes through setSvgAttribute and is covered (its getBoundingClientRect at :230 is finding 015). Unchanged-range renders are common: RolloverModifier.modifierMouseMove :252 -> update :273 -> annotation x1 setters :487 -> AnnotationBase.notifyPropertyChanged :957-959 -> invalidate, so every pointer-driven render re-runs update on all static SVG annotations. Corrections: dropped the inline-style guard from the fix and title (Blink and Gecko already skip same-value inline-style sets, as the original why_it_costs itself said); added the SvgLineAnnotation guard; fixed the renderer path in call_path; why_it_costs notes Gecko skips same-value setAttribute, so the possible saving is Chromium-specific. Mechanism inside the engine is not provable from library code, so evidence stays H; severity stays low (cost per annotation is small and unproven; benefit only on renders where ranges are unchanged).

