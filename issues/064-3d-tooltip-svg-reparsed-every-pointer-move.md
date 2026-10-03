# 064 · TooltipSvgAnnotation3D tears down and re-parses the tooltip SVG (and legend SVG) on every pointer move, even when only x1/y1 changed

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting3D/Visuals/Annotations/TooltipSvgAnnotation3D.js:144` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (also INP) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Rule | DOM-07 (web-performance skill) |
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
+        // Run the template on every update: the default one also sets xCoordShift/yCoordShift from x1/y1.
+        // Rebuild the DOM only when the markup changed; a pure move is handled by updateTooltip() below.
+        const svgString = this.applySvgClipping(this.tooltipSvgTemplate(this.seriesInfo, this), this.clipping);
+        if (!this.svg || svgString !== this.lastSvgString) {
+            if (this.svg) {
+                this.clear();
+            }
+            this.lastSvgString = svgString;
+            this.create(xCalc, yCalc, xCoordSvgTrans, yCoordSvgTrans); // protected override point kept
+        }
         if (this.placementDivId) {
@@ clear() {
         if (!this.parentSurface || this.parentSurface.isDeleted || !this.svg)
             return;
+        this.lastSvgString = undefined;
         if (this.placementDivId) {
@@ updateLegendTooltip() {
         if (this.tooltipLegendTemplate) {
             const svgString = this.seriesInfo ? this.tooltipLegendTemplate(this.seriesInfo, this) : "<svg></svg>";
-            if (this.svgLegend) {
-                this.svgRoot.removeChild(this.svgLegend);
-            }
             const clippedSvgString = this.applySvgClipping(svgString, this.clipping);
-            const svgNode = annotationHelpers.createSvg(clippedSvgString, this.svgRoot, this.nextSibling);
-            this.svgLegend = svgNode;
+            // clear() drops svgLegend whenever the tooltip is rebuilt, so the legend is re-created then too
+            if (!this.svgLegend || clippedSvgString !== this.lastLegendString) {
+                if (this.svgLegend) {
+                    this.svgRoot.removeChild(this.svgLegend);
+                }
+                this.lastLegendString = clippedSvgString;
+                this.svgLegend = annotationHelpers.createSvg(clippedSvgString, this.svgRoot, this.nextSibling);
+            }
             this.svgLegend.setAttribute("x", this.tooltipLegendOffsetX.toString());
             this.svgLegend.setAttribute("y", this.tooltipLegendOffsetY.toString());
--- a/esm/Charting3D/ChartModifiers/TooltipModifier3D.js
+++ b/esm/Charting3D/ChartModifiers/TooltipModifier3D.js
@@ -328 +328 @@ const defaultTooltipTemplate3D = (seriesInfos, svgAnnotation) => {
-    const id = `id_${Date.now()}`;
+    const id = `id_${svgAnnotation.id}`; // stable per annotation (a guid by default, AnnotationBase.js:444): same content gives the same markup
```

**Trade-off:** Custom templates that embed x1/y1 or a timestamp in the markup still rebuild on each move, the same as today. On a rebuild the template runs twice (once for the comparison, once inside create()), which keeps create() as a working override point for subclasses. The stable filter id also removes a latent duplicate-id case when two rebuilds happen in the same millisecond; an app-supplied annotation id must be a valid XML id for url(#...) to resolve. The cost is one string comparison per update.

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
- Adversarial verification (corrected): Re-read TooltipSvgAnnotation3D.js:139-235: quote matches :139-146 (primary :144 is clear()). Chain confirmed: TooltipModifier3D.modifierMouseMove :242-247 -> update :252-300 -> on a hit, x1/y1 = pointer (:288-289) -> AnnotationBase x1 setter :143-148 (equality-guarded, so only real moves) -> TooltipSvgAnnotation3D.notifyPropertyChanged :171-174 (isDirty = true for every property) -> AnnotationBase.notifyPropertyChanged :957-961 invalidates the 3D surface -> next frame SciChart3DRenderer.render :122-140 calls update() on every DOM annotation -> clear() :155-170 (removeChild of tooltip and legend) -> create() :178-191 (template + createContextualFragment via annotationHelpers.createSvg :5-13) -> updateTooltip :192-208 -> updateLegendTooltip :209-221 (second parse). Off a hit, seriesInfo (isEqual-guarded :49-54) and isHidden (guarded, AnnotationBase.js:105-107) do not dirty it again, so the rebuild runs once per rendered frame while the pointer moves over a hit point. The default template's filter id is `id_${Date.now()}` (TooltipModifier3D.js:328), and x1/y1 do not appear in the markup (they only feed adjustTooltipPosition3D :359-367, which sets xCoordShift/yCoordShift), so a stable id makes pure moves produce identical markup. Severity medium kept (per hover frame, but a ~13-node fragment beside a full 3D re-render) and evidence S kept. Corrections: rule 'DOM-07, EVT-03' -> 'DOM-07': the pointer handler only sets x1/y1 and the rebuild already runs once per frame in render(), so EVT-03 coalescing is already in place; the cost is parsing markup per update. Fix rewritten: it keeps calling the protected create() (types .d.ts:87) instead of inlining it, so subclasses that override create() still work (the template then runs twice only on a rebuild); clear() resets lastSvgString; the legend skip is spelled out and keyed on !this.svgLegend as well, because clear() removes the legend whenever the tooltip is rebuilt, and a cached legend string alone would leave the legend missing after such a rebuild.

