# 023 · Rollover and Cursor tooltip SVGs (blur filter included) are torn down and re-parsed on every render while the pointer is over the series area, including hidden tooltips and unchanged content

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Annotations/RolloverTooltipSvgAnnotation.js:57` |
| Severity | **high** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (also INP on hover) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/2527ec4678f5faddde04ba00da42e16a/): reproduced on WebGL and WebGPU ([source](../demos/023-rollover-cursor-tooltip-svg-reparse/)) |
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
-        const clippedSvgString = this.applyClipping(svgString, this.clipping);
+        // this class's clear() removes the node but keeps this.svg set, so check the node is still in place
+        const attached = !!this.svg && this.svg.parentNode === this.svgRoot;
+        if (attached && this.isHidden) return;                             // hidden: keep the node, skip template + parse
+        const svgString = this.seriesInfo ? this.generateSvgString() : "<svg></svg>";
+        const clippedSvgString = this.applyClipping(svgString, this.clipping);
+        if (attached && clippedSvgString === this.lastSvgString) return;   // same markup: update() only moves it
+        if (attached) this.svgRoot.removeChild(this.svg);
+        this.lastSvgString = clippedSvgString;
         const svgNode = annotationHelpers.createSvg(clippedSvgString, this.svgRoot, this.nextSibling);
         this.setSvg(svgNode);
@@ generateSvgString() {
-        const id = `id${Math.floor(this.y1)}_${idTitle}_${Date.now()}`;
+        const id = `id_${this.id}_${idTitle}`;                       // stable per annotation, unique in the document
--- a/esm/Charting/Visuals/Annotations/CursorTooltipSvgAnnotation.js
+++ b/esm/Charting/Visuals/Annotations/CursorTooltipSvgAnnotation.js
@@ update(xCalc, yCalc, xCoordSvgTrans, yCoordSvgTrans) {
         this.previousMousePosition = this.cursorModifier.getMousePosition();
-        if (this.svg) {
-            this.clear();
-        }
-        this.create(xCalc, yCalc, xCoordSvgTrans, yCoordSvgTrans);
+        const svgString = this.svgString ?? this.tooltipSvgTemplate(this.seriesInfos, this);
+        const key = this.applyClipping(svgString, this.clipping);
+        // this class's clear() sets svg to undefined, so !this.svg also covers delete() and layer changes
+        if (!this.svg || this.placementDivId || key !== this.lastSvgKey) {
+            if (this.svg) this.clear();
+            this.lastSvgKey = key;
+            this.create(xCalc, yCalc, xCoordSvgTrans, yCoordSvgTrans);
+        }
         if (this.placementDivId) {
--- a/esm/Charting/ChartModifiers/CursorModifier.js
+++ b/esm/Charting/ChartModifiers/CursorModifier.js
@@ export const defaultCursorTooltipSvgTemplate = (seriesInfos, svgAnnotation) => {
-    const id = `id_${Date.now()}`;
+    const id = `id_${svgAnnotation.id}`;
```

**Trade-off:** Hidden tooltips keep their last DOM (visibility:hidden) and do not refresh updateSize() while hidden. Positioning already used last render's size, so the one-render lag is unchanged. Filter ids become stable per annotation; the old node is removed before the new one is inserted, so ids stay unique. A rebuilt tooltip is appended after unchanged ones, so the stacking order among overlapping tooltips can differ from today's. Any change in values re-parses, whether from a pointer move or from new data under a still pointer. On a chart whose X axis scrolls with the stream, the values under a still pointer change every frame, so the saving there comes mainly from hidden tooltips. Updating the <tspan> text in place would remove the rest, but it is a larger change. The legend-template paths (RolloverLegendSvgAnnotation.js:73, RolloverTooltipSvgAnnotation.js:116, CursorTooltipSvgAnnotation.js:212) are not covered by this diff and still re-parse every render when a tooltipLegendTemplate is set.

## App-side workaround

Partial. Set `rs.rolloverModifierProps.showRollover = false` on series that need no tooltip, so they are excluded instead of rebuilt hidden. Supply a light `rolloverModifierProps.tooltipTemplate` without the feGaussianBlur filter. Leave tooltipLegendTemplate unset unless needed.

## Verify

measure.md#fps: 10 series + RolloverModifier. Scenario A: pointer held still in the plot for 5 s while data streams with a fixed X visibleRange (autoRange Never, appends within or beyond the range), so the values under the pointer do not change. Scenario B: hover sweep. Scenario C: CursorModifier({ showTooltip: true }) with the pointer still during the same stream. Pass: LoAF script time in createSvg/createContextualFragment drops in A and C, the Paint count per frame falls, and frame p95 and long frames per 10 s win or stay neutral in all three (compare-runs, 5 runs per side).

## Other locations

- `esm/Charting/Visuals/Annotations/RolloverTooltipSvgAnnotation.js:106` — filter id contains Date.now(), so the markup differs every ms: it cannot serve as a cache key, and a new <filter> plus feGaussianBlur is created each time
- `esm/Charting/Visuals/Annotations/RolloverTooltipSvgAnnotation.js:116` — tooltipLegendTemplate SVG is re-parsed on each update too
- `esm/Charting/Visuals/Annotations/RolloverTooltipSvgAnnotation.js:130` — document.querySelector for placementDivId on every update (external placement only)
- `esm/Charting/Visuals/Annotations/CursorTooltipSvgAnnotation.js:143` — same pattern: clear() + create() on every render in SeriesArea. With showTooltip: true this is a full tooltip parse per render; with the default showTooltip false the cached svgString is normally the empty '<svg></svg>', so the default cost is small
- `esm/Charting/Visuals/Annotations/CursorTooltipSvgAnnotation.js:212` — legend template re-parsed each render
- `esm/Charting/ChartModifiers/CursorModifier.js:665` — default template id `id_${Date.now()}` defeats the equality guard in CursorTooltipSvgAnnotation.seriesInfos (CursorTooltipSvgAnnotation.js:58), so every move with showTooltip: true invalidates and produces new markup
- `esm/Charting/Visuals/Annotations/RolloverLegendSvgAnnotation.js:73` — with tooltipLegendTemplate set, deleted and re-parsed on every render, whatever the pointer state
- `esm/Charting/Visuals/Annotations/annotationHelpers.js:6` — each parse also allocates a new live Range (document.createRange). The document keeps updating it on DOM mutations until GC; one cached Range would do

## Review notes

- Found by reviewer slice `s07-annotations-legend`.
- Adversarial verification (corrected): Re-read RolloverTooltipSvgAnnotation.js:1-193, CursorTooltipSvgAnnotation.js:40-231, RolloverLegendSvgAnnotation.js:65-88, CursorModifier.js:75-145, :215-245, :540-618 and :660-670, RolloverModifier.js:70-80, :537-628 and :844-870, SvgAnnotationBase.js:30-88, AnnotationBase.js:926-942 and SciChartRenderer.js:160-190, :360-396, :532-550. The code_quote matches RolloverTooltipSvgAnnotation.js:52-58 verbatim. Inside the series area, update() always runs clear() (:74-88) and then SvgAnnotationBase.update -> create (:90-101) -> generateSvgString (:102-109, Date.now() id at :106) -> defaultTooltipTemplate (:152-193, feOffset + feGaussianBlur filter) -> annotationHelpers.createSvg. Both renderer paths call update for every DOM annotation with no visibility check: renderDomOnly -> drawSvgAnnotations (:74 -> :532 -> :550) and render -> getAnnotationDrawFunctions (:201 -> :360/:375) -> :396. RolloverModifier showTooltip defaults to true (:75). updateSeriesAnnotations hides every tooltip first (:544-548) and shows only the hit ones (:613-620 -> updateRolloverModifierProps :858-868), so hidden tooltips keep their last seriesInfo and are fully re-templated and re-parsed. The other locations check out: :116 legend re-parse, :130 querySelector (external placement only), RolloverLegendSvgAnnotation.js:73 delete+create on every render once a tooltipLegendTemplate is set, CursorModifier.js:665 Date.now() id, which defeats the CursorTooltipSvgAnnotation.js:58 equality guard. I also checked for an infinite-render loop through that guard. There is none: onParentSurfaceLayoutComplete runs only inside a full render (SciChartRenderer.js:170-182), while isInvalidated is still true, so the svgOnly invalidate is dropped (SciChartSurface.js:582). Severity high (per frame while the pointer is in the plot) and evidence S hold. DOM-07, DOM-04 and SC-21 apply and their Avoid fields do not excuse this. Corrections: (1) The CursorTooltipSvgAnnotation.js:143 note overstated the default case. With showTooltip false (CursorModifier.js:78) the seriesInfos setter runs only on series attach and detach and on pointer leave (:550, :615), so the cached svgString is normally the empty '<svg></svg>' and the default per-render parse is tiny. The full tooltip parse per render happens with showTooltip: true. (2) Fix diff bug: RolloverTooltipSvgAnnotation.clear() (:74-88) removes the node but never calls setSvg(undefined), unlike SvgAnnotationBase.clear. The proposed create() early returns (`this.svg && this.isHidden`, `this.svg && same string`) would therefore treat a node already removed by clear()/delete() (SvgAnnotationBase.delete :64-67, notifyPropertyChanged :131-136) as present, so the tooltip would never come back, or `removeChild` would throw. The corrected diff tests that this.svg is still a child of svgRoot. Both tooltip fixes now key on the clipped markup, so a clipping change also rebuilds. (3) trade_off and verify corrected. On a chart whose X axis scrolls with the stream, the values under a still pointer change every frame, so visible tooltips still re-parse. Scenario A now uses a fixed X visibleRange, and trade_off names the legend-template paths that this diff leaves alone.

