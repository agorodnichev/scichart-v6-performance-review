# 046 · PolarCursorModifier updates after the render has re-armed invalidation, and the default cursor tooltip template stamps Date.now() into its SVG, so each full render with the pointer over the series area schedules one more frame

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/ChartModifiers/Polar/PolarCursorModifier.js:277` |
| Severity | **medium** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | frame time (extra rAF + SVG rebuild), also per-move script time |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
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

After each full render while the pointer rests in the series area over a hit series, update() schedules one more animation frame (renderDomOnly) that tears down and re-parses the tooltip SVG, which has a feGaussianBlur filter with a new id, and repaints it. A full invalidation that arrives before that frame cancels it (SciChartSurface.js:593-595), so during continuous movement it is mostly absorbed. It shows as one extra frame after the pointer stops, and as one extra DOM-only frame after each full render of a live chart while the user hovers. Each move also hit-tests every series twice: in the handler, then again after the render that the moved radial/circular line triggered.

**Scale where it matters:** Polar charts with PolarCursorModifier({ showTooltip: true }) or a tooltipLegendTemplate (showTooltip defaults to false, PolarCursorModifier.js:84), with N series. The extra frame needs at least one series hit, because the default template returns a constant "<svg></svg>" otherwise (CursorModifier.js:668-669). The double hit test per pointermove also needs a radial or circular line (showRadialLine/showCircularLine), whose move forces a full render.

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
- Adversarial verification (corrected): Re-read PolarCursorModifier.js:246-279 (modifierMouseMove -> update at :267; onParentSurfaceRendered -> update at :277-278), :200-222 (tooltip is a CursorTooltipSvgAnnotation with defaultCursorTooltipSvgTemplate), :522-532 (getSeriesInfos hit-tests every included series), :533-621 (update; seriesInfos set at :619 only when showTooltip || tooltipLegendTemplate, showTooltip defaults to false at :84); SciChartRenderer.js:88-320 (render: layout-complete hooks :169-182, isInvalidated = false at :188, onParentSurfaceRendered at :318 -> :742-758), :39-81 (renderDomOnly does not call any modifier hook, so there is no loop); CursorTooltipSvgAnnotation.js:52-62 (content guard), :137-146 (clear()+create()); CursorModifier.js:663-712 (Date.now() filter id; constant "<svg></svg>" when no series is hit), :292-298 (cartesian CursorModifier uses onParentSurfaceLayoutComplete); DomAnnotationBase.js:247-250 (svgOnly unless reDrawChartOnChange; SciChartDefaults.alwaysRedrawFullChartOnSvgChange = false at SciChartDefaults.js:128); SciChartSurface.js:581-600 (svgOnly path schedules requestAnimationFrame(renderDomOnly) when not invalidated; a later full invalidate cancels it). Mechanism confirmed: after every full render with the pointer in the series area and at least one series hit, the post-render update() builds a new SVG string that never equals the previous one, so it schedules a renderDomOnly frame that tears down and re-parses the tooltip SVG. Every pointermove moves the render-context radial/circular LineAnnotations (full invalidate), so the post-render update repeats the handler's hit test of every series. Corrections: why_it_costs and scale overstated the extra frame; the scheduled rAF is cancelled when a full invalidation arrives first (SciChartSurface.js:593-595), so during continuous movement it is usually absorbed, and the extra frame is certain after the pointer stops or on idle-hover full renders, and only when a series is hit and showTooltip or tooltipLegendTemplate is set. The double hit test per move needs showTooltip/tooltipLegendTemplate plus a radial or circular line (both default on). Fix diff checked: changes in onParentSurfaceLayoutComplete run before :188, so the new positions land in the same frame and their invalidations are absorbed. Severity medium and evidence S kept.

