# 072 · TextAnnotation rebuilds its whole SVG through the HTML parser and calls getBBox one to two times on every text change

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Annotations/TextAnnotation.js:198` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | DOM-07, EVT-07, SC-21 (web-performance skill) |
| Effort to fix | small |

## Code

```js
        if (this.svg) {
            this.clear();
        }
        this.setSvg(this.createSvg());
        this.calcAndSetAnnotationBorders(xCalc, yCalc);
        this.updateAdornerInner();
```

## Call path and frequency

App sets textAnnotation.text (TextAnnotation.js:51-55) -> notifyPropertyChanged (:169-183, isDirty = true, svg-only invalidate) -> next render -> getHTMLAnnotationDrawFunction (SciChartRenderer.js:396) -> SvgAnnotationBase.update (:30) -> TextAnnotation.create (:188) -> clear (:198) -> createSvg (:205-219, parse + optional getBBox :231) -> calcAndSetAnnotationBorders (DomAnnotationBase.js:256-257) -> getSvgDomRect getBBox (SvgAnnotationBase.js:77). Rate: once per text change per annotation. Apps that show a live value set it every tick.

## Why it costs

A text-only change replaces the node with a freshly parsed subtree and then measures it synchronously after the insert. With a background, it measures twice, with a rect insert in between. Each measurement after the DOM write is a forced style and layout. Whether this dominates the frame depends on the label count and the update rate.

**Scale where it matters:** H: depends on how many TextAnnotations have text driven by live data. For example, 20 'last value' labels updated each frame give 20 parses and 20-40 forced layouts per frame.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/Annotations/TextAnnotation.js
+++ b/esm/Charting/Visuals/Annotations/TextAnnotation.js
     set text(text) {
         if (this.textProperty !== text) {
             this.textProperty = text;
-            this.notifyPropertyChanged(PROPERTY.TEXT);
+            const textEl = this.svg && !this.isDirty && !this.background && !/[<&]/.test(text) && this.svg.querySelector("text");
+            if (textEl) {
+                textEl.textContent = text;       // in place: no parse, no node swap
+                this.svgDOMRect = undefined;     // one lazy re-measure in the next update
+                if (this.invalidateParentCallback) this.invalidateParentCallback({ svgOnly: !this.reDrawChartOnChange });
+            } else {
+                this.notifyPropertyChanged(PROPERTY.TEXT);
+            }
         }
     }
```

**Trade-off:** The in-place path covers only plain text without a background. Markup in text (parsed today because the template interpolates it unescaped) and backgrounds keep the old rebuild. One getBBox per change remains.

## App-side workaround

Use NativeTextAnnotation for labels whose text changes often (SC-21), or update only when the formatted string actually changes.

## Verify

measure.md#fps: 20 TextAnnotations whose text is set every frame on a streaming chart for 10 s. Pass: 'Forced by script' layouts from SvgAnnotationBase.getSvgDomRect and attachSvgBackgroundRect drop to at most 1 per annotation per change, LoAF script time in createSvg drops, and frame p95 wins or stays neutral.

## Other locations

- `esm/Charting/Visuals/Annotations/TextAnnotation.js:231` — attachSvgBackgroundRect: getBBox right after insert (background set)
- `esm/Charting/Visuals/Annotations/SvgAnnotationBase.js:77` — second getBBox via calcAndSetAnnotationBorders -> getSize -> getSvgDomRect, because clear() reset svgDOMRect (:86)
- `esm/Charting/Visuals/Annotations/TextAnnotation.js:179` — any non-position property (including hover and selection state) sets isDirty and triggers the same rebuild

## Review notes

- Found by reviewer slice `s07-annotations-legend`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

