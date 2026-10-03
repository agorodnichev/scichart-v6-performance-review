# 046 · PolarCursorModifier updates after the render has re-armed invalidation, and the default cursor tooltip template stamps Date.now() into its SVG, so each full render with the pointer over the series area schedules one more frame

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/ChartModifiers/Polar/PolarCursorModifier.js:277` |
| Severity | **medium** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | frame time (extra rAF + SVG rebuild), also per-move script time |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | SC-14 (web-performance skill) |
| Effort to fix | small |

## Code

```js
    onParentSurfaceRendered() {
        this.update();
    }
```

## Call path and frequency

Full render: SciChartRenderer.render sets isInvalidated = false (SciChartRenderer.js:188), draws, then calls onParentSurfaceRendered (:318, :742-750) -> PolarCursorModifier.update (PolarCursorModifier.js:533) -> tooltipAnnotation.seriesInfos = getSeriesInfos() (:619, a hit test of every series). The CursorTooltipSvgAnnotation setter (CursorTooltipSvgAnnotation.js:52-61) runs defaultCursorTooltipSvgTemplate, whose `id_${Date.now()}` (CursorModifier.js:665) makes the string differ every time, so the 'only rerender if content changed' guard (:58) never holds -> notifyPropertyChanged -> DomAnnotationBase.js:248-249 svgOnly invalidate -> SciChartSurface.js:581-588 requestAnimationFrame(renderDomOnly), because invalidation is re-armed by then -> next frame CursorTooltipSvgAnnotation.update clear()+create() re-parses the tooltip SVG (:137-146). Per pointermove: modifierMouseMove -> update() (:267) moves the render-context radial/circular lines -> a full render -> the post-render update() runs again, so every series is hit-tested twice per move.

## Why it costs

Every full render while hovering leaves one more animation frame that tears down and re-parses the tooltip SVG, which has a feGaussianBlur filter with a new id, and repaints it. The first frame after the pointer stops therefore does one more render than needed. Each move also hit-tests every series twice: in the handler, then again after the render.

**Scale where it matters:** Polar charts with PolarCursorModifier({ showTooltip: true }) or a tooltipLegendTemplate; N series. This runs per pointer event and after every full render while the pointer is in the series area.

## Fix (library side)

```diff
--- esm/Charting/ChartModifiers/Polar/PolarCursorModifier.js
-    onParentSurfaceRendered() {
-        this.update();
-    }
+    onParentSurfaceRendered() { }
+    onParentSurfaceLayoutComplete() {
+        // like CursorModifier: runs before the renderer re-arms invalidation, so changes land in this frame
+        this.update();
+    }
@@ modifierMouseMove(args)
         if (isActionAllowed) {
-            this.update();
+            // radial/circular lines are render-context annotations: a full render follows and runs update() once
+            if (this.radialAnnotation || this.circularAnnotation) this.parentSurface.invalidateElement();
+            else this.update();
         }
--- esm/Charting/ChartModifiers/CursorModifier.js
-    const id = `id_${Date.now()}`;
+    const id = `id_${svgAnnotation.id}`; // stable per annotation, so identical content compares equal
```

**Trade-off:** Hit tests in layout-complete use the previous frame's render-pass data, as the cartesian CursorModifier already does. The filter id is unique per annotation rather than per call, which is still unique in the document because the old node is removed before the new one is created.

## App-side workaround

Pass a tooltipSvgTemplate with a stable filter id (or no blur filter). Subclass PolarCursorModifier to move update() from onParentSurfaceRendered to onParentSurfaceLayoutComplete.

## Verify

measure.md#fps idle check: polar chart with PolarCursorModifier({ showTooltip: true }), pointer resting in the series area, then one full render triggered (e.g. change a series stroke); trace an idle window between wp: marks. Pass: no 'Animation frame fired' after the full render (one renderDomOnly frame before). Hover scenario with a dev counter: hit tests per pointermove equal the series count (twice that before).

## Other locations

- `esm/Charting/ChartModifiers/CursorModifier.js:665` — Date.now() id defeats the content guard; also used by the cartesian CursorModifier on every move
- `esm/Charting/Visuals/Annotations/CursorTooltipSvgAnnotation.js:58` — unchanged-content guard that never holds with the default template
- `esm/Charting/Visuals/Annotations/CursorTooltipSvgAnnotation.js:143` — clear()+create() re-parse on every DOM render (annotations slice)
- `esm/Charting/Services/SciChartRenderer.js:318` — onParentSurfaceRendered runs after isInvalidated was reset at :188

## Review notes

- Found by reviewer slice `s10-modifiers-input`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

