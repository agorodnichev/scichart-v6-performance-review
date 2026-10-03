# 077 · MouseManager attaches a non-passive wheel listener to every chart canvas, even when no attached modifier uses the wheel, so a page scroll that starts over any chart waits for the main thread

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Core/Mouse/MouseManager.js:74` |
| Severity | **medium** |
| Pipeline stage | Composite (`composite`) |
| Metric | frame time / scroll start latency (dropped frames while scrolling the page) |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Rule | EVT-09 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
        source.addEventListener("wheel", this.onMouseWheel);
```

## Call path and frequency

Once per surface: SciChartSurfaceBase constructor (SciChartSurfaceBase.js:290-295) -> MouseManager.subscribe (MouseManager.js:66-80). On every wheel over the canvas: onMouseWheel (:215) -> modifierMouseWheel; preventDefault only if a modifier set handled (:223-225). Only MouseWheelZoomModifier, PolarMouseWheelZoomModifier and OverviewRangeSelectionModifier override modifierMouseWheel; the base implementation is a no-op (ChartModifierBase.js).

## Why it costs

Chromium defaults wheel listeners to passive only on window, document, html and body. A listener on another element may call preventDefault, so the compositor must send the first wheel event of each scroll over that region to the main thread and wait. When the main thread is busy rendering charts, the page scroll starts late over every chart canvas, even though this listener can never cancel when no modifier handles the wheel.

**Scale where it matters:** Pages that scroll and contain several charts (dashboards, reports), especially with live data keeping the main thread busy. It affects every chart, including ones with no wheel modifier.

## Fix (library side)

```diff
--- esm/Core/Mouse/MouseManager.js
+import { ChartModifierBase } from "../../Charting/ChartModifiers/ChartModifierBase";
@@ subscribe(source)
-        source.addEventListener("wheel", this.onMouseWheel);
+        // Non-passive only while some modifier can consume the wheel (it needs preventDefault);
+        // otherwise the compositor scrolls the page over this chart without waiting for the main thread.
+        this.wheelPassive = !this.anyModifierHandlesWheel();
+        source.addEventListener("wheel", this.onMouseWheel, { passive: this.wheelPassive });
@@
+    anyModifierHandlesWheel() {
+        const base = ChartModifierBase.prototype.modifierMouseWheel;
+        const surfaces = [this.sciChartSurface, ...(this.sciChartSurface.subCharts || [])];
+        // group copies sent to other surfaces never set handled on this event, so only own and sub-chart overrides count
+        return surfaces.some(s => s.chartModifiers.asArray().some(cm => cm.modifierMouseWheel !== base));
+    }
+    refreshWheelListener() {
+        // call from chartModifiers.collectionChanged (SciChartSurfaceBase.js:269) of this surface and of each sub-chart
+        // (via parentSurface.mouseManager, since a sub-chart's own MouseManager has no canvas), and from addSubChart/removeSubChart
+        const passive = !this.anyModifierHandlesWheel();
+        if (!this.canvas || passive === this.wheelPassive) return;
+        this.canvas.removeEventListener("wheel", this.onMouseWheel);
+        this.wheelPassive = passive;
+        this.canvas.addEventListener("wheel", this.onMouseWheel, { passive });
+    }
@@ onMouseWheel
-        if (modifierEvent.handled) {
+        if (modifierEvent.handled && !this.wheelPassive) {
             event.preventDefault();
```

**Trade-off:** Adds a re-subscribe when modifiers or sub-charts change, which is rare. Detection works by method override, so a custom modifier that consumes the wheel without overriding modifierMouseWheel needs an explicit flag; a disabled wheel modifier still keeps the listener non-passive. Grouped modifiers do not need it: copies forwarded to other surfaces never set handled on the source event, so the page already scrolls today when only another chart in the group zooms. Behavior is unchanged otherwise: without a wheel modifier, handled is never set, so the page already scrolls today.

## App-side workaround

For charts without wheel modifiers, re-add the bound handler as passive: `const mm = surface.mouseManager; const el = mm["canvas"]; el.removeEventListener("wheel", mm.onMouseWheel); el.addEventListener("wheel", mm.onMouseWheel, { passive: true });`. This relies on a private field. unsubscribe() still removes the listener, because removal matches only the listener and the capture flag.

## Verify

measure.md#fps with a trusted wheel scroll of the page, pointer over a chart that has no wheel modifier, while a 'stream' scenario keeps the main thread busy; with no trusted input, ask the user to enable DevTools Rendering 'Scrolling performance issues'. Pass: the chart canvas is no longer marked as a wheel-handler region, and trace-summary.mjs counts fewer DroppedFrame events than the baseline.

## Other locations

- `esm/Core/Mouse/MouseManager.js:223` — preventDefault only when a modifier handled the wheel
- `esm/Charting/Visuals/SciChartSurfaceBase.js:292` — every surface subscribes
- `esm/Charting/Visuals/sciChartInitCommon.js:164` — related, out of slice: touch-action defaults to 'none' on every chart canvas, which blocks touch page scroll over charts with no pan modifier

## Review notes

- Found by reviewer slice `s10-modifiers-input`.
- Adversarial verification (corrected): Re-read MouseManager.js:54 (onMouseWheel bound once), :66-80 (subscribe: `source.addEventListener("wheel", this.onMouseWheel)` at :74 with no options), :215-231 (onMouseWheel: preventDefault only when modifierEvent.handled, :223-225), :454-472 (modifierMouseWheel: group copies are new objects from ModifierMouseArgs.copy, so a handled flag set on another surface never comes back to the source event; sub-chart handling does come back through updateSubCharts/processSubChartEvent :658-661). SciChartSurfaceBase.js:290-296 (every surface subscribes; createMaster.js:99 uses ECanvasType.canvas2D, so the source is the per-chart 2D canvas). ChartModifierBase.js:136-138 (no-op base). Only MouseWheelZoomModifier.js:84, PolarMouseWheelZoomModifier.js:58, OverviewRangeSelectionModifier.js:138 and MouseWheelZoomModifier3D.js:40 override it; no other wheel listener exists in esm. The listener targets a canvas, not window/document/body, so it is not default-passive and the compositor must wait for it at the start of each wheel scroll over the chart. Severity medium (once per scroll start over a chart) and evidence H (delay depends on main-thread load) kept. Corrections to the fix: the detector compared against `Object.getPrototypeOf(ChartModifierBase.prototype).constructor.prototype.modifierMouseWheel`, which is DeletableEntity.prototype.modifierMouseWheel === undefined (ChartModifierBase extends DeletableEntity, ChartModifierBase.js:12), so every modifier counted as a wheel consumer and any chart with a modifier stayed non-passive; now compares with ChartModifierBase.prototype.modifierMouseWheel. Dropped the modifierGroup clause: forwarded group copies cannot make the source call preventDefault, so passive changes nothing for them. Added the refresh hooks the diff missed: sub-surfaces' MouseManagers are unsubscribed (SciChartSurface.js:371) and have no canvas, so sub-chart modifier changes and addSubChart/removeSubChart must refresh the parent's listener.

