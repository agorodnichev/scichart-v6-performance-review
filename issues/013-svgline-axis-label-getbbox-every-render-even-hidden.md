# 013 · CursorModifier's default SVG crosshair (SvgLineAnnotation) rewrites its axis labels and calls getBBox on every render, also while the crosshair is hidden

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Annotations/SvgLineAnnotation.js:331` |
| Severity | **high** |
| Pipeline stage | Layout (`layout`) |
| Metric | frame time (also INP on hover) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
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

Full render: SciChartRenderer.render -> getAnnotationDrawFunctions (SciChartRenderer.js:201 -> :375) -> getHTMLAnnotationDrawFunction (:396) -> SvgLineAnnotation.update (SvgLineAnnotation.js:194) -> drawSvgAxisLabel (:235 -> :296) -> getBBox (:331). Pointer: CursorModifier.modifierMouseMove (CursorModifier.js:256) -> update (:540) sets x1/x2/y1/y2 -> svg-only invalidate (SciChartSurface.js:581-589) -> renderDomOnly -> drawSvgAnnotations (SciChartRenderer.js:532 -> :550) -> same path. Rate: 2 lines x labelled axes per render, from the first render on, whether or not the crosshair is visible.

## Why it costs

drawSvgAxisLabel writes textContent and 7 attributes, reads getBBox(), then writes rect and text positions. The read follows a write in the same task, so Chromium runs style and layout synchronously inside script. The second line repeats the write-then-read pattern, which forces another layout. The work runs even when the label text and font are unchanged and when the crosshair is hidden.

**Scale where it matters:** Any chart with a default CursorModifier: at least 2 forced style+layout passes per render (one per X and one per Y axis label), on every frame of a streaming chart even when the pointer is elsewhere.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/Annotations/SvgLineAnnotation.js
+++ b/esm/Charting/Visuals/Annotations/SvgLineAnnotation.js
@@ -218 +218 @@
-        if (this.showLabel && this.labelsContainer && !this.parentSurface.isPolar) {
+        if (this.showLabel && this.labelsContainer && !this.parentSurface.isPolar && !this.isHidden) {
@@ drawSvgAxisLabel(axis, coord) {
-        cached.text.textContent = labelText;
+        const fontKey = `${fontFamily}|${fontSize}`;
+        const textChanged = cached.lastText !== labelText || cached.lastFont !== fontKey;
+        if (textChanged) cached.text.textContent = labelText;
@@
-        const bbox = cached.text.getBBox();
+        if (textChanged || !cached.bbox) {
+            cached.bbox = cached.text.getBBox();   // layout read only when text or font changed
+            cached.lastText = labelText;
+            cached.lastFont = fontKey;
+        }
+        const bbox = cached.bbox;
```

**Trade-off:** A hidden crosshair no longer refreshes its invisible labels; the container gets display:none through the existing else branch. A cached bbox can go stale if a web font loads after the first measurement, so clear labelCache on document.fonts 'loadingdone'. When the label text changes on every pointer move, one getBBox per line per frame remains. Measuring with a cached canvas measureText would remove it, at the cost of possible sub-pixel mismatch with SVG text.

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
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

