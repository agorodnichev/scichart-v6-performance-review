# 023 · Rollover and Cursor tooltip SVGs (blur filter included) are torn down and re-parsed on every render while the pointer is over the series area, including hidden tooltips and unchanged content

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Annotations/RolloverTooltipSvgAnnotation.js:57` |
| Severity | **high** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (also INP on hover) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | DOM-07, DOM-04, SC-21 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
        if (this.previousMousePosition === currentMousePosition && currentMousePosition !== EMousePosition.SeriesArea) {
            return;
        }
        this.previousMousePosition = this.tooltipProps.rolloverModifier.getMousePosition();
        if (this.svg) {
            this.clear();
        }
```

## Call path and frequency

Same two entry points as the marker: renderDomOnly (SciChartRenderer.js:39 -> :532 -> :550) for svg-only renders on pointer move, and render -> getHTMLAnnotationDrawFunction (SciChartRenderer.js:396) for full renders -> RolloverTooltipSvgAnnotation.update (:50) -> clear (:74-88) -> SvgAnnotationBase.update (:30) -> create (:90-101) -> generateSvgString (:102-109) -> defaultTooltipTemplate (:152-193) -> annotationHelpers.createSvg (annotationHelpers.js:5-13). CursorModifier: same renderer path -> CursorTooltipSvgAnnotation.update (:137-154). Rate: once per included series per render while the pointer is in the series area (per frame when streaming, once per frame while moving). The Rollover legend annotation rebuilds on every render.

## Why it costs

Each rebuild formats the values, builds the template string, removes the old <svg>, runs the HTML fragment parser, inserts the new subtree with a fresh <filter id=...Date.now()>, and then forces style, layout and a re-rasterized feGaussianBlur on the next paint. Nothing checks whether the tooltip is hidden or whether its content changed. Because the id is time-based, even identical content produces different markup.

**Scale where it matters:** N series with RolloverModifier (default showTooltip: true): N full tooltip parses, each with an SVG blur filter, per render. Streaming charts pay this on every frame even with the pointer at rest. Tooltips of series that are not hit are rebuilt and then hidden.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/Annotations/RolloverTooltipSvgAnnotation.js
+++ b/esm/Charting/Visuals/Annotations/RolloverTooltipSvgAnnotation.js
@@ update(xCalc, yCalc, xCoordSvgTrans, yCoordSvgTrans) {
         this.previousMousePosition = this.tooltipProps.rolloverModifier.getMousePosition();
-        if (this.svg) {
-            this.clear();
-        }
         if (this.placementDivId) {
+            if (this.svg) this.clear();
             this.updateExternalLegendTooltip();
         }
         else {
+            if (this.svgLegend) { this.svgLegend.remove(); this.svgLegend = undefined; }
             super.update(xCalc, yCalc, xCoordSvgTrans, yCoordSvgTrans);
@@ create(xCalc, yCalc, xCoordSvgTrans, yCoordSvgTrans) {
-        let svgString;
-        if (!this.seriesInfo) {
-            svgString = "<svg></svg>";
-        }
-        else {
-            svgString = this.generateSvgString();
-        }
+        if (this.svg && this.isHidden) return;                     // hidden: keep the node, skip template + parse
+        const svgString = this.seriesInfo ? this.generateSvgString() : "<svg></svg>";
+        if (this.svg && svgString === this.lastSvgString) return;  // same markup: update() only moves it
+        if (this.svg) this.svgRoot.removeChild(this.svg);
+        this.lastSvgString = svgString;
         const clippedSvgString = this.applyClipping(svgString, this.clipping);
@@ generateSvgString() {
-        const id = `id${Math.floor(this.y1)}_${idTitle}_${Date.now()}`;
+        const id = `id_${this.id}_${idTitle}`;                       // stable per annotation, unique in the document
--- a/esm/Charting/Visuals/Annotations/CursorTooltipSvgAnnotation.js
@@ update(...) {
-        if (this.svg) {
-            this.clear();
-        }
-        this.create(xCalc, yCalc, xCoordSvgTrans, yCoordSvgTrans);
+        const svgString = this.svgString ?? this.tooltipSvgTemplate(this.seriesInfos, this);
+        if (!this.svg || this.placementDivId || svgString !== this.lastSvgString) {
+            if (this.svg) this.clear();
+            this.lastSvgString = svgString;
+            this.create(xCalc, yCalc, xCoordSvgTrans, yCoordSvgTrans);
+        }
--- a/esm/Charting/ChartModifiers/CursorModifier.js
-    const id = `id_${Date.now()}`;
+    const id = `id_${svgAnnotation.id}`;
```

**Trade-off:** Hidden tooltips keep their last DOM (visibility:hidden) and do not refresh updateSize() while hidden. Positioning already used last render's size, so the one-render lag is unchanged. Filter ids become stable per annotation; the old node is removed before the new one is inserted, so ids stay unique. A pointer move that changes the values still re-parses. Updating the <tspan> text in place would remove that too, but it is a larger change.

## App-side workaround

Partial. Set `rs.rolloverModifierProps.showRollover = false` on series that need no tooltip, so they are excluded instead of rebuilt hidden. Supply a light `rolloverModifierProps.tooltipTemplate` without the feGaussianBlur filter. Leave tooltipLegendTemplate unset unless needed.

## Verify

measure.md#fps: 10 series + RolloverModifier, streaming one appendRange per frame. Scenario A: pointer held still in the plot for 5 s. Scenario B: hover sweep. Pass: LoAF script time in createSvg/createContextualFragment drops in A, the Paint count per frame falls, and frame p95 and long frames per 10 s win or stay neutral in both (compare-runs, 5 runs per side).

## Other locations

- `esm/Charting/Visuals/Annotations/RolloverTooltipSvgAnnotation.js:106` — filter id contains Date.now(), so the markup differs every ms: it cannot serve as a cache key, and a new <filter> plus feGaussianBlur is created each time
- `esm/Charting/Visuals/Annotations/RolloverTooltipSvgAnnotation.js:116` — tooltipLegendTemplate SVG is re-parsed on each update too
- `esm/Charting/Visuals/Annotations/RolloverTooltipSvgAnnotation.js:130` — document.querySelector for placementDivId on every update
- `esm/Charting/Visuals/Annotations/CursorTooltipSvgAnnotation.js:143` — same pattern: clear() + create() on every render in SeriesArea, also when showTooltip is false (the default), where it parses and then sets display:none
- `esm/Charting/Visuals/Annotations/CursorTooltipSvgAnnotation.js:212` — legend template re-parsed each render
- `esm/Charting/ChartModifiers/CursorModifier.js:665` — default template id `id_${Date.now()}` defeats the equality guard in CursorTooltipSvgAnnotation.seriesInfos (CursorTooltipSvgAnnotation.js:58), so every move invalidates
- `esm/Charting/Visuals/Annotations/RolloverLegendSvgAnnotation.js:73` — with tooltipLegendTemplate set, deleted and re-parsed on every render, whatever the pointer state
- `esm/Charting/Visuals/Annotations/annotationHelpers.js:6` — each parse also allocates a new live Range (document.createRange). The document keeps updating it on DOM mutations until GC; one cached Range would do

## Review notes

- Found by reviewer slice `s07-annotations-legend`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

