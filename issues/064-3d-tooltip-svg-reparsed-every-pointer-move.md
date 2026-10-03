# 064 · TooltipSvgAnnotation3D tears down and re-parses the tooltip SVG (and legend SVG) on every pointer move, even when only x1/y1 changed

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting3D/Visuals/Annotations/TooltipSvgAnnotation3D.js:144` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (also INP) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | DOM-07, EVT-03 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
    update(xCalc, yCalc, xCoordSvgTrans, yCoordSvgTrans) {
        if (!this.isDirty)
            return;
        this.isDirty = false;
        if (this.svg) {
            this.clear();
        }
        this.create(xCalc, yCalc, xCoordSvgTrans, yCoordSvgTrans);
```

## Call path and frequency

pointermove over the 3D chart -> TooltipModifier3D.modifierMouseMove (esm/Charting3D/ChartModifiers/TooltipModifier3D.js:242-247) -> update() (:252) -> tooltipAnnotation.x1/y1 = pointer (:288-289) -> AnnotationBase x1 setter (esm/Charting/Visuals/Annotations/AnnotationBase.js:144-147) -> TooltipSvgAnnotation3D.notifyPropertyChanged (TooltipSvgAnnotation3D.js:171-174: isDirty = true, invalidate) -> next frame SciChart3DRenderer.render (SciChart3DRenderer.js:125-133) -> TooltipSvgAnnotation3D.update (:139-153) -> clear() (:155-170, removeChild) -> create() (:178-190: tooltipSvgTemplate + createContextualFragment + insert) -> updateLegendTooltip (:209-220: second template + parse + insert). Frequency: one rebuild per frame while the pointer moves over a hit point.

## Why it costs

Moving the tooltip needs only the x/y attribute writes in updateTooltip(). Instead, each move runs the HTML/SVG parser on the template string, removes the old subtree, inserts a new one with a new <filter> element, and forces style recalculation, layout and filter setup for the new nodes. The default template makes every markup string unique (filter id `id_${Date.now()}` at TooltipModifier3D.js:328), so nothing can be reused even when the hovered point and its values are unchanged.

**Scale where it matters:** One tooltip of about 10 SVG nodes, including a feGaussianBlur filter, plus an optional legend SVG. Rebuilt at the pointer-move frame rate (60 to 120 Hz) while hovering data, in the same frames that also re-render the whole 3D scene.

## Fix (library side)

```diff
--- a/esm/Charting3D/Visuals/Annotations/TooltipSvgAnnotation3D.js
+++ b/esm/Charting3D/Visuals/Annotations/TooltipSvgAnnotation3D.js
@@ update(xCalc, yCalc, xCoordSvgTrans, yCoordSvgTrans) {
         if (!this.isDirty)
             return;
         this.isDirty = false;
-        if (this.svg) {
-            this.clear();
-        }
-        this.create(xCalc, yCalc, xCoordSvgTrans, yCoordSvgTrans);
+        if (!this.tooltipSvgTemplate)
+            throw Error("Please provide a tooltipSvgTemplate for CursorTooltipSvgAnnotation");
+        // the template still runs (it sets xCoordShift/yCoordShift); the DOM is rebuilt only when the markup changed
+        const svgString = this.applySvgClipping(this.tooltipSvgTemplate(this.seriesInfo, this), this.clipping);
+        if (!this.svg || svgString !== this.lastSvgString) {
+            if (this.svg) this.clear();
+            this.lastSvgString = svgString;
+            this.setSvg(annotationHelpers.createSvg(svgString, this.placementDivId ? this.svgDivRoot : this.svgRoot, this.nextSibling));
+        }
         if (this.placementDivId) {
@@ clear() {
+        this.lastSvgString = undefined;
@@ updateLegendTooltip()  (same: keep lastLegendString and skip removeChild/createSvg when unchanged)
--- a/esm/Charting3D/ChartModifiers/TooltipModifier3D.js
+++ b/esm/Charting3D/ChartModifiers/TooltipModifier3D.js
@@ -328 +328 @@
-    const id = `id_${Date.now()}`;
+    const id = `id_${svgAnnotation.id}`; // stable per annotation: same content gives the same markup
```

**Trade-off:** Custom templates that embed x1/y1 in the markup still rebuild on each move, the same as today. Templates with time-varying output (Date.now) keep rebuilding until they make their output stable. The stable filter id also removes a latent duplicate-id case when two rebuilds happen in the same millisecond. The cost is one string comparison per update.

## App-side workaround

Set showTooltip:false and draw your own tooltip from rs.hitTest() results in one persistent element moved with a transform. A custom tooltipSvgTemplate alone does not help, because it is still re-parsed on every move.

## Verify

measure.md#fps, a hover scenario that moves the pointer across the points of a 3D scatter with TooltipModifier3D for 5 s, 5 runs per side. Pass: the 'Parse HTML' count in the trace-summary window drops to about the number of distinct hovered points, the Layout count drops, and compare-runs is 'win' or 'neutral' on frameP95Ms with no regression.

## Other locations

- `esm/Charting3D/Visuals/Annotations/TooltipSvgAnnotation3D.js:173` — isDirty is set for every property, including X1/Y1
- `esm/Charting3D/Visuals/Annotations/TooltipSvgAnnotation3D.js:216` — the legend SVG is also re-parsed on every update
- `esm/Charting3D/ChartModifiers/TooltipModifier3D.js:328` — the Date.now() filter id makes every template output unique
- `esm/Charting3D/ChartModifiers/TooltipModifier3D.js:288` — x1/y1 are written on every pointer move

## Review notes

- Found by reviewer slice `s12-pie-3d-surface`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

