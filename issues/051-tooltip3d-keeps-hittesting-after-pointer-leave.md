# 051 · TooltipModifier3D never clears mousePoint on pointer leave, so every later render hit-tests all series at a stale point (and keeps a mesh render loop alive)

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting3D/ChartModifiers/TooltipModifier3D.js:249` |
| Severity | **medium** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | frame time on live/animated 3D charts |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/8c9a9cbac6767167b811d1dbda9c7933/): reproduced on WebGL and WebGPU ([source](../demos/051-tooltip3d-stale-after-leave/)) |
| Rule | CNV-02, SC-27 (web-performance skill) |
| Effort to fix | small |

## Code

```js
    modifierMouseMove(args) {
        this.activePointerEvents.set(args.pointerId, args);
        super.modifierMouseMove(args);
        if (this.getIsActionAllowed(args)) {
            this.update();
        }
    }
    onParentSurfaceRendered() {
        this.update();
    }
```

## Call path and frequency

Per rendered frame after the pointer left the canvas: data append (XyzDataSeries3D notifyDataChanged -> BaseRenderableSeries3D.js:275-278 invalidate) or camera animation -> SciChart3DRenderer.js:144 -> SciChart3DSurface.js:623 -> TooltipModifier3D.js:249-250 update() -> :257-259 N hitTests at the last in-chart pointer position -> tooltip/crosshair updated at that stale position.

## Why it costs

Every render after the pointer left still runs N hit tests at the last in-chart position: per included series an SCRTGetSelectionInfo wasm call plus HitTestInfo3D/SeriesInfo3D allocations, and the tooltip and crosshair stay drawn at that stale spot and keep updating there. If that spot is over a surface mesh, the self-sustaining re-render of finding 020 continues with no pointer on the chart at all.

**Scale where it matters:** 3D charts with streaming data or camera animation (ResetCamera3DModifier, app-driven orbit) and TooltipModifier3D; N series per render while the pointer is elsewhere on the page.

## Fix (library side)

```diff
--- a/esm/Charting3D/ChartModifiers/TooltipModifier3D.js
+++ b/esm/Charting3D/ChartModifiers/TooltipModifier3D.js
@@     onParentSurfaceRendered() {
         this.update();
     }
+    /** @inheritDoc */
+    modifierMouseLeave(args) {
+        super.modifierMouseLeave(args);
+        this.mousePoint = undefined;
+        if (this.tooltipAnnotation) {
+            this.tooltipAnnotation.seriesInfo = undefined;
+            this.tooltipAnnotation.isHidden = true;
+        }
+        if (this.crosshairEntity) {
+            this.crosshairEntity.isVisible = false;
+        }
+    }
+    /** @inheritDoc */
+    modifierPointerCancel(args) {
+        this.modifierMouseLeave(args);
+    }
```

**Trade-off:** The tooltip and crosshair hide when the pointer leaves the chart; an app that relied on the tooltip staying at the last position loses that.

## App-side workaround

Subclass TooltipModifier3D and add the modifierMouseLeave override above.

## Verify

measure.md#fps: 3D scatter appending 1k points per frame with TooltipModifier3D; move the pointer over a point, then off the chart; trace 5 s. Pass: no hitTest/SCRTGetSelectionInfo in LoAF topScripts during the window and the tooltip is hidden; with a surface mesh, the idle check shows 0 'Animation frame fired' once data stops.

## Other locations

- `esm/Charting/ChartModifiers/ChartModifierBase.js:149` — base modifierMouseLeave only deletes the pointer id; mousePoint stays set
- `esm/Charting3D/ChartModifiers/SeriesSelectionModifier3D.js:144` — the sibling modifier does clear mousePoint on leave

## Review notes

- Found by reviewer slice `s13-3d-series-modifiers`.
- Adversarial verification (corrected): Quote matches TooltipModifier3D.js:242-251 (CRLF file; primary :249 is onParentSurfaceRendered). rg over esm/Charting3D: only SeriesSelectionModifier3D overrides modifierMouseLeave (:141-159, clears mousePoint at :144) and modifierPointerCancel (:161-163); TooltipModifier3D has neither, and its base chain ChartModifierBase3D (no handlers) -> ChartModifierBase.js:148-150/:157-159 only deletes the pointer id; mousePoint is only written by updatePointerInfo :237-251. MouseManager.js:76/:236-243 dispatches mouseleave to every modifier (:504-508), so the leave reaches TooltipModifier3D and is ignored. Per-render chain confirmed: BaseRenderableSeries3D.js:275-278 dataSeriesDataChanged -> invalidateParentCallback -> SciChart3DRenderer.render :144 scs.onSciChartRendered() -> SciChart3DSurface.js:621-624 cm.onParentSurfaceRendered() -> TooltipModifier3D.js:249-250 update() -> :254 only guard is !this.mousePoint -> :257-259 hitTest per included visible series (BaseRenderableSeries3D.js:262-273: prepareSelectionBuffer + sceneEntity.hitTest -> RenderableSeriesSceneEntity.hitTestXyz SCRTGetSelectionInfo + HitTestInfo3D/SeriesInfo3D allocations) -> :276-298 tooltip/crosshair writes. No rAF coalescing or visibility guard stops it; it runs on every render for as long as the surface renders after the pointer left. The mesh case links to finding 020 (HitTestInfo3D.isEqual by reference -> TooltipSvgAnnotation3D.js:49-53 notify -> re-render), which this stale point keeps alive. Fix checked: base leave first, then clear mousePoint and hide via the equality-guarded setters (AnnotationBase isHidden :105-110, seriesInfo :49-53), which invalidate once so the hidden state is drawn; pointercancel delegates like the sibling modifier. Severity medium kept (per rendered frame but a fixed N hit tests per frame, the same work as while hovering; the data-sized mesh loop is finding 020), evidence S kept. Corrected why_it_costs: the internal label F1 is replaced with finding 020, and selection-buffer reads are stated as the SCRTGetSelectionInfo wasm call whose internal cost is not visible.

