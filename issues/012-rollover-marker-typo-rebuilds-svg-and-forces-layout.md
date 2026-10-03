# 012 · RolloverMarkerSvgAnnotation never caches its color (=== typo), so every render re-parses each marker SVG and forces a layout through getBBox

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Annotations/RolloverMarkerSvgAnnotation.js:34` |
| Severity | **high** |
| Pipeline stage | Layout (`layout`) |
| Metric | frame time (also INP on hover) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Rule | EVT-07, SC-21 (web-performance skill) |
| Effort to fix | small |

## Code

```js
        if (this.svg && this.currentColor !== color) {
            this.clear();
        }
        if (!this.svg) {
            this.currentColor === color;
```

## Call path and frequency

Pointer: RolloverModifier.modifierMouseMove (esm/Charting/ChartModifiers/RolloverModifier.js:252) -> update (:464) -> updateSeriesAnnotations (:466, def :537) -> marker.resumeInvalidate (:623 -> DomAnnotationBase.js:107-123) -> invalidateParentCallback({svgOnly}) -> SciChartSurface.invalidateElement (esm/Charting/Visuals/SciChartSurface.js:581-589, one rAF) -> SciChartRenderer.renderDomOnly (esm/Charting/Services/SciChartRenderer.js:39) -> drawSvgAnnotations (:74 -> :532) -> a.update (:550). Full render (streaming): SciChartRenderer.render -> getAnnotationDrawFunctions (:201 -> :360, modifier loop :375) -> getHTMLAnnotationDrawFunction (:382, update at :396) -> RolloverMarkerSvgAnnotation.update (:18) -> SvgAnnotationBase.update (SvgAnnotationBase.js:30) -> create (RolloverMarkerSvgAnnotation.js:27) -> clear (SvgAnnotationBase.js:81-88, resets svgDOMRect) + annotationHelpers.createSvg (annotationHelpers.js:5) -> getSvgDomRect (SvgAnnotationBase.js:37 -> :77 getBBox). Rate: once per included series (twice for band series) per render while the pointer is in the series area, hidden markers included (neither renderer path checks isHidden). That is every frame on a streaming chart, and once per frame during pointer moves.

## Why it costs

Because currentColor is never assigned, each update() removes the 8x8 marker <svg>, builds a string and parses it through Range.createContextualFragment, then inserts it. clear() also resets svgDOMRect, so SvgAnnotationBase.update immediately calls getBBox() on the node it just inserted. The previous series' tooltip insert already dirtied style and layout, so this forces a synchronous style+layout. Across N series the render alternates write, read, write: N forced layouts per frame for a fixed-size circle whose size never changes.

**Scale where it matters:** Any RolloverModifier (default isSvgOnly) with N series: N marker re-parses and N forced style+layout passes per render. This matters from a few series up, and on every frame of a streaming chart while the user hovers.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/Annotations/RolloverMarkerSvgAnnotation.js
+++ b/esm/Charting/Visuals/Annotations/RolloverMarkerSvgAnnotation.js
@@ -33,3 +33,3 @@
         if (!this.svg) {
-            this.currentColor === color;
+            this.currentColor = color;
             const svgString = tooltipSvgTemplate(color);
```

**Trade-off:** None. The marker is still rebuilt when its color changes, as the guard intended. svgDOMRect stays cached, so getBBox runs once per marker instead of once per render.

## App-side workaround

Patch the exported class once at startup: `const c = RolloverMarkerSvgAnnotation.prototype.create; RolloverMarkerSvgAnnotation.prototype.create = function (...a) { c.apply(this, a); const p = this.tooltipProps; this.currentColor = p.markerColor ?? p.tooltipColor; };`

## Verify

measure.md#fps: 10 line series with RolloverModifier, run_scenario hover sweep for 5 s, then repeat while streaming one appendRange per frame. Pass: `trace-summary.mjs --between wp:start wp:end` 'Forced by script' lists no layout from getSvgDomRect (SvgAnnotationBase.js:77), and frame-interval p95 and long frames per 10 s win or stay neutral (compare-runs, 5 runs per side).

## Review notes

- Found by reviewer slice `s07-annotations-legend`.
- Adversarial verification (corrected): Re-read RolloverMarkerSvgAnnotation.js:1-45. The code_quote matches :30-34 verbatim. `this.currentColor === color;` at :34 is a comparison, and rg finds no other assignment of currentColor anywhere in esm/ (only :30 and :34), so the :30 guard is always true once this.svg exists and every create() calls clear() (SvgAnnotationBase.js:81-88, which resets svgDOMRect at :86) and re-parses through annotationHelpers.createSvg (annotationHelpers.js:5-13, document.createRange().createContextualFragment). SvgAnnotationBase.update (:30) calls create (:34), then getSvgDomRect (:37), which runs getBBox (:77) on the node just inserted, then writes style.visibility/opacity (:50-51) and x/y attributes (:59-60). The only guard, RolloverMarkerSvgAnnotation.update :20, returns early only when the mouse position is unchanged AND not SeriesArea, so in the series area every update rebuilds. Caller chain confirmed: RolloverModifier.modifierMouseMove (:252) -> update (:464) -> updateSeriesAnnotations (:466, def :537) -> marker.resumeInvalidate (:623) -> DomAnnotationBase.resumeInvalidate (:107-123) -> invalidateParentCallback({svgOnly}) -> SciChartSurface.invalidateElement (:581-589, rAF coalesced) -> SciChartRenderer.renderDomOnly (:39) -> drawSvgAnnotations (:74 -> :532) -> a.update (:550) for every isDomAnnotation, with no isHidden check. Full render: SciChartRenderer.render -> getAnnotationDrawFunctions (:201 -> :360, modifier loop :375) -> getHTMLAnnotationDrawFunction (:382) -> annotation.update (:396), again with no visibility check. Markers are created per included series (RolloverModifier.js:809-812, plus :827-830 for band Y1) and added to modifierAnnotations (:447-454). isSvgOnly defaults to true (RolloverModifier.js:77). Rules EVT-07 (node insert then read in a loop) and SC-21 apply, and neither Avoid field excuses this. Severity high and evidence S hold: per pointer frame and per frame while streaming with the pointer in the plot. The fix diff is correct and minimal. markerColor can change through AUTO_COLOR (RolloverModifier.js:853-854), and the restored guard still rebuilds then. The app workaround is valid, because RolloverMarkerSvgAnnotation is exported (esm/index.js:360). Corrected: call_path line numbers (update :464, updateSeriesAnnotations :466/:537, resumeInvalidate call :623, getHTMLAnnotationDrawFunction def :382 with update at :396).

