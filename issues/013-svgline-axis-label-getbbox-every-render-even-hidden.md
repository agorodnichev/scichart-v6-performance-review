# 013 · CursorModifier's default SVG crosshair (SvgLineAnnotation) rewrites its axis labels and calls getBBox on every render, also while the crosshair is hidden

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Annotations/SvgLineAnnotation.js:331` |
| Severity | **high** |
| Pipeline stage | Layout (`layout`) |
| Metric | frame time (also INP on hover) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/16e017182cb3af8bcfc5bad7dffc93fb/): reproduced on WebGL and WebGPU ([source](../demos/013-svgline-axis-label-getbbox/)) |
| Rule | EVT-07 (web-performance skill) |
| Effort to fix | small |

## Code

```js
        cached.text.textContent = labelText;
        cached.rect.setAttribute("fill", fill);
        // cached.rect.setAttribute("opacity", "0.4"); // for testing only
        cached.rect.setAttribute("stroke", "none");
        cached.rect.setAttribute("rx", this.labelCornerRadiusProperty.toString());
        const bbox = cached.text.getBBox();
```

## Call path and frequency

Full render: SciChartRenderer.render -> getAnnotationDrawFunctions (SciChartRenderer.js:201 -> :360, modifier loop :375) -> getHTMLAnnotationDrawFunction (:382, update at :396) -> SvgLineAnnotation.update (SvgLineAnnotation.js:194) -> label branch (:218) -> drawSvgAxisLabel (:235 -> :296) -> getBBox (:331). Pointer: CursorModifier.modifierMouseMove (CursorModifier.js:256) -> update (:540) sets x1/x2/y1/y2 -> svg-only invalidate (SciChartSurface.js:581-589) -> renderDomOnly -> drawSvgAnnotations (SciChartRenderer.js:74 -> :532 -> :550) -> same path. Neither renderer path checks isHidden. Before the first hover the lines have no coordinates; AnnotationBase.getResolvedCoordinate (:1008-1009) maps undefined to 0, so both lines take the vertical-line branch (:222) and label the X axes at coord 0. After the pointer leaves, CursorModifier.update (:541-552) only sets isHidden and keeps the last coordinates. Rate: 2 lines x labelled axes per render, from the first render on, whether or not the crosshair is visible.

## Why it costs

drawSvgAxisLabel writes textContent and 7 attributes, reads getBBox(), then writes rect and text positions. The read follows a write in the same task, so Chromium runs style and layout synchronously inside script. The second line repeats the write-then-read pattern, which forces another layout. The work runs even when the label text and font are unchanged and when the crosshair is hidden.

**Scale where it matters:** Any chart with a default CursorModifier: at least 2 forced style+layout passes per render (one per X and one per Y axis label), on every frame of a streaming chart even when the pointer is elsewhere.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/Annotations/SvgLineAnnotation.js
+++ b/esm/Charting/Visuals/Annotations/SvgLineAnnotation.js
@@ update(xCalc, yCalc, xCoordSvgTrans, yCoordSvgTrans) {
-        if (this.showLabel && this.labelsContainer && !this.parentSurface.isPolar) {
+        if (this.showLabel && this.labelsContainer && !this.parentSurface.isPolar && !this.isHidden) {
+            // show the container before measuring: text under display:none has no layout box and getBBox is empty
+            this.labelsContainer.style.display = "block";
             this.labelCache.forEach(l => (l.inUse = false));
@@
             // Delete unused labels
             this.labelCache.forEach(l => {
                 if (!l.inUse) {
                     l.group.remove();
                     this.labelCache.delete(l.axisId);
                 }
             });
-            this.labelsContainer.style.display = "block";
         }
@@ drawSvgAxisLabel(axis, coord) {
-        cached.text.textContent = labelText;
+        const fontKey = `${fontFamily}|${fontSize}`;
+        const textChanged = cached.lastText !== labelText || cached.lastFont !== fontKey;
+        if (textChanged) cached.text.textContent = labelText;
@@
-        const bbox = cached.text.getBBox();
+        if (textChanged || !cached.bbox) {
+            cached.bbox = cached.text.getBBox();   // layout read only when text or font changed
+            // never keep an empty measurement (text not laid out yet); measure again next render
+            cached.lastText = cached.bbox.width > 0 ? labelText : undefined;
+            cached.lastFont = fontKey;
+        }
+        const bbox = cached.bbox;
```

**Trade-off:** A hidden crosshair no longer refreshes its invisible labels; the container gets display:none through the existing else branch and is switched back to display:block before the first measurement when the crosshair shows again, so getBBox never runs on an undisplayed label. A cached bbox can go stale if a web font loads after the first measurement, so clear labelCache on document.fonts 'loadingdone'. When the label text changes on every pointer move, one getBBox per line per frame remains. Measuring with a cached canvas measureText would remove it, at the cost of possible sub-pixel mismatch with SVG text.

## App-side workaround

`new CursorModifier({ showAxisLabels: false })`, or add the modifier only while the user hovers. `isSvgOnly: false` moves the labels to WebGL, but every pointer move then triggers a full chart redraw.

## Verify

measure.md#fps: chart with default CursorModifier streaming one appendRange per frame. 5 s with the pointer outside, then a 5 s hover sweep. Pass: 'Forced by script' in trace-summary shows no layout from drawSvgAxisLabel (SvgLineAnnotation.js:331) in the pointer-outside window and at most one per line per frame while sweeping; frame p95 wins or stays neutral.

## Other locations

- `esm/Charting/Visuals/Annotations/SvgLineAnnotation.js:218` — label branch has no isHidden check, so it runs for a hidden crosshair on every render
- `esm/Charting/Visuals/Annotations/SvgLineAnnotation.js:393` — rect/text position writes after the read; the second crosshair line then writes and reads again
- `esm/Charting/ChartModifiers/CursorModifier.js:129` — defaults showAxisLabels = true and isSvgOnly = true (:130), so newLineAnnotation (:636-637) creates SvgLineAnnotation with labels
- `esm/Charting/Visuals/Annotations/SvgLineAnnotation.js:207` — per-render filter/spread arrays over axes; minor next to the layout read

## Review notes

- Found by reviewer slice `s07-annotations-legend`.
- Adversarial verification (corrected): Re-read SvgLineAnnotation.js:174-401. The code_quote matches :326-331 verbatim, with getBBox at :331. drawSvgAxisLabel writes 5 text attributes plus textContent (:321-326) and 3 rect attributes (:327-330), reads getBBox (:331), then writes rect x/y/width/height and text x/y (:393-400). Caller chain confirmed. Full render: SciChartRenderer.render -> getAnnotationDrawFunctions (:201 -> :360, modifier loop :375) -> getHTMLAnnotationDrawFunction (:382) -> annotation.update (:396). Pointer: CursorModifier.modifierMouseMove (:256) -> update (:540) sets x1/x2/y1/y2 (:566-608) -> SciChartSurface.invalidateElement svgOnly (:581-589, rAF) -> renderDomOnly (SciChartRenderer.js:39) -> drawSvgAnnotations (:74 -> :532) -> a.update (:550). Neither path checks isHidden. SvgLineAnnotation.update (:194) -> label branch (:218, no isHidden check) -> drawSvgAxisLabel (:235 -> :296). The hidden-from-first-render claim holds. CursorModifier.newLineAnnotation (:620-641) creates the lines with isHidden true and no coordinates, and showLabel defaults to true (:129) with isSvgOnly true (:130, SvgLineAnnotation at :636-637). AnnotationBase.getResolvedCoordinate (:1005-1009) maps undefined to 0, so before any hover both lines resolve to (0,0,0,0) and take the vertical-line branch (:222), labelling every visible X axis at coord 0. getLabelValue (drawLabel.js:353-364) returns a formatted label, so it is non-empty. After the pointer leaves, CursorModifier.update (:541-552) sets only isHidden and keeps the coordinates, so the labels keep being measured. Rule EVT-07 applies, and its Avoid field does not excuse it. Severity high and evidence S hold. Fix diff bug found and corrected. With the new !this.isHidden guard, a hidden line takes the else branch (:247-248) and sets labelsContainer display:none. On the first render after the crosshair is shown, drawSvgAxisLabel would call getBBox while the container is still display:none, because the original sets display:block only after the loop at :245. The text then has no layout box and measures empty, and the proposed cache would keep that empty box for as long as the label text stays the same. Corrected diff: set display:block before the loop, and do not remember an empty measurement. trade_off updated to match. call_path now explains why the hidden crosshair labels from the first render.

