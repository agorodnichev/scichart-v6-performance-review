# 060 · A selected annotation deletes and re-parses its adorner SVG on every render, even when it has not moved

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Annotations/DomAnnotationBase.js:236` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (also INP while dragging) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (confirmed) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/d0c5a221be903a0e83160dc5b5dee2cb/): reproduced on WebGL and WebGPU ([source](../demos/060-selected-annotation-adorner-reparse/)) |
| Rule | DOM-07 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
    updateAdornerInner() {
        this.deleteAdorner();
        if (this.isSelected) {
            const { x1, x2, y1, y2 } = this.getAnnotationBorders(true);
            const svgString = this.svgStringAdornerTemplate(x1, y1, x2, y2);
            const clippedSvgString = this.applySvgClipping(svgString, this.adornerClipping);
            this.svgAdorner = annotationHelpers.createSvg(clippedSvgString, this.svgAdornerRoot);
        }
    }
```

## Call path and frequency

Render-context annotations: SciChartRenderer.render -> renderPassInfo drawFn (SciChartRenderer.js:429) -> e.g. LineAnnotation.drawWithContext (LineAnnotation.js:246) -> updateAdornerInner (:314 -> :453-460) -> deleteAdorner (AnnotationBase.js:1076-1081) + annotationHelpers.createSvg. DOM annotations: getHTMLAnnotationDrawFunction (SciChartRenderer.js:396) -> TextAnnotation.create (TextAnnotation.js:191-193) / HtmlCustomAnnotation.update (:73) -> DomAnnotationBase.updateAdornerInner (:235-242). Rate: once per render per selected annotation, so every frame while the chart streams or other overlays update.

## Why it costs

Each render removes the adorner node, builds an SVG string, runs the HTML fragment parser, and inserts a new subtree. That adds style, layout and paint work for the grips even when the borders are identical to the previous frame.

**Scale where it matters:** Usually 1 selected annotation, but on every frame the chart renders. While dragging, once per pointer move (rAF-coalesced).

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/Annotations/AnnotationBase.js
+++ b/esm/Charting/Visuals/Annotations/AnnotationBase.js
+    /** Insert the adorner, re-parsing only when its markup changed */
+    setAdornerSvg(clippedSvgString) {
+        if (this.svgAdorner && clippedSvgString === this.lastAdornerSvgString) return;
+        this.deleteAdorner();
+        this.lastAdornerSvgString = clippedSvgString;
+        this.svgAdorner = annotationHelpers.createSvg(clippedSvgString, this.svgAdornerRoot);
+    }
--- a/esm/Charting/Visuals/Annotations/DomAnnotationBase.js   (same edit in LineAnnotation, BoxAnnotation, NativeTextAnnotation, AxisMarkerAnnotation, ArcAnnotationBase)
     updateAdornerInner() {
-        this.deleteAdorner();
-        if (this.isSelected) {
+        if (!this.isSelected) {
+            this.deleteAdorner();
+            return;
+        }
+        {
             const { x1, x2, y1, y2 } = this.getAnnotationBorders(true);
             const svgString = this.svgStringAdornerTemplate(x1, y1, x2, y2);
             const clippedSvgString = this.applySvgClipping(svgString, this.adornerClipping);
-            this.svgAdorner = annotationHelpers.createSvg(clippedSvgString, this.svgAdornerRoot);
+            this.setAdornerSvg(clippedSvgString);
         }
     }
```

**Trade-off:** One template string build and compare per render remains while an annotation is selected. During a drag the markup changes on every move, so it still re-parses. Updating grip attributes in place would remove that, but it is a larger change.

## App-side workaround

Set `annotation.isSelected = false` when editing ends (for example on dragEnded or a click outside), so live charts do not keep a selected annotation.

## Verify

measure.md#fps: select a BoxAnnotation and a TextAnnotation on a chart streaming one appendRange per frame for 10 s. Pass: a MutationObserver on domSvgAdornerLayer records 0 childList mutations per frame while the annotations do not move, LoAF script time in createSvg drops, and frame p95 wins or stays neutral.

## Other locations

- `esm/Charting/Visuals/Annotations/LineAnnotation.js:454` — called from drawWithContext :314 every frame
- `esm/Charting/Visuals/Annotations/BoxAnnotation.js:320` — called from drawWithContext :154
- `esm/Charting/Visuals/Annotations/NativeTextAnnotation.js:566` — called from drawWithContext :416
- `esm/Charting/Visuals/Annotations/AxisMarkerAnnotation.js:328` — called from drawWithContext :266
- `esm/Charting/Visuals/Annotations/ArcAnnotationBase.js:229` — ArcAnnotation.js:75, PolarArcAnnotation.js:90
- `esm/Charting/Visuals/Annotations/HtmlCustomAnnotation.js:73` — unconditional on every update
- `esm/Charting/Visuals/Annotations/SvgLineAnnotation.js:291` — unconditional on every update
- `esm/Charting/Visuals/Annotations/PolarPointerAnnotation.js:323` — re-parses the whole pointer SVG every render while selected

## Review notes

- Found by reviewer slice `s07-annotations-legend`.
- Adversarial verification (confirmed): Re-read DomAnnotationBase.js:235-243 (quote verbatim) and the copies in LineAnnotation.js:453-461, BoxAnnotation.js:319-327, NativeTextAnnotation.js:565-573, AxisMarkerAnnotation.js:327-335, ArcAnnotationBase.js:228-235; deleteAdorner AnnotationBase.js:1076-1081 (early return only when no adorner, so no cost while unselected); annotationHelpers.createSvg :5-13 (createRange().createContextualFragment + appendChild). Call chain re-established: SciChartRenderer.getAnnotationDrawFunctions (Services/SciChartRenderer.js:360-381) runs every render; DOM annotations go straight to annotation.update (:396) -> SvgAnnotationBase.update (SvgAnnotationBase.js:30-34) -> TextAnnotation.create, whose non-dirty path still calls updateAdornerInner whenever isSelected (TextAnnotation.js:189-193); HtmlCustomAnnotation.update :73 and SvgLineAnnotation :291 call it on every update; render-context annotations add drawFn via renderPassInfo.addRenderable (:405-438) -> drawWithContext (:429) -> updateAdornerInner at LineAnnotation.js:314, BoxAnnotation.js:154, NativeTextAnnotation.js:416, AxisMarkerAnnotation.js:266. PolarPointerAnnotation.js:323 rebuilds the whole pointer SVG while selected. Renders are rAF-coalesced invalidations (SciChartSurface.js:570-600), so this is once per rendered frame per selected annotation. No guard found: nothing caches the adorner markup, and nothing else mutates svgAdorner (rg 'svgAdorner\.' finds no writers), so the string-compare fix is semantics-preserving; deleteAdorner callers (AnnotationBase.js:558 on detach, AxisMarkerAnnotation.js:268 off-range) clear svgAdorner, so the guard re-creates correctly. setSvgClipPathDefinitions on the adorner root (SciChartSurfaceBase.js:744) only touches <defs>. Severity medium kept: per-frame path, but only while an annotation is selected (normally one, a small subtree). Evidence S.

