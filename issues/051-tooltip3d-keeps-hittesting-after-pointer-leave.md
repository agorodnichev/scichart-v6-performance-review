# 051 · TooltipModifier3D never clears mousePoint on pointer leave, so every later render hit-tests all series at a stale point (and keeps a mesh render loop alive)

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting3D/ChartModifiers/TooltipModifier3D.js:249` |
| Severity | **medium** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | frame time on live/animated 3D charts |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
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

Hit testing (selection-buffer reads, allocations) continues on every frame for a pointer that is no longer over the chart, and the tooltip stays visible at a stale spot. If that spot is over a surface mesh, the F1 render loop continues with no pointer on the chart at all.

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
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

