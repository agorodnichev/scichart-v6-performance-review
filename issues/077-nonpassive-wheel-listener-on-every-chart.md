# 077 · MouseManager attaches a non-passive wheel listener to every chart canvas, even when no attached modifier uses the wheel, so a page scroll that starts over any chart waits for the main thread

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Core/Mouse/MouseManager.js:74` |
| Severity | **medium** |
| Pipeline stage | Composite (`composite`) |
| Metric | frame time / scroll start latency (dropped frames while scrolling the page) |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
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
-        source.addEventListener("wheel", this.onMouseWheel);
+        // Non-passive only while some modifier can consume the wheel (it needs preventDefault);
+        // otherwise the compositor scrolls the page over this chart without waiting for the main thread.
+        this.wheelPassive = !this.anyModifierHandlesWheel();
+        source.addEventListener("wheel", this.onMouseWheel, { passive: this.wheelPassive });
@@
+    anyModifierHandlesWheel() {
+        const surfaces = [this.sciChartSurface, ...(this.sciChartSurface.subCharts || [])];
+        return surfaces.some(s => s.chartModifiers.asArray().some(cm => cm.modifierGroup !== undefined ||
+            Object.getPrototypeOf(cm).modifierMouseWheel !== Object.getPrototypeOf(ChartModifierBase.prototype).constructor.prototype.modifierMouseWheel));
+    }
+    refreshWheelListener() { // call from chartModifiers.collectionChanged (SciChartSurfaceBase.js:269)
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

**Trade-off:** Adds a re-subscribe when modifiers change, which is rare. Detection works by method override, so a custom modifier that consumes the wheel without overriding modifierMouseWheel needs an explicit flag. Surfaces with grouped modifiers stay non-passive because they may forward wheel events to other charts. Behavior is unchanged otherwise: without a wheel modifier, handled is never set, so the page already scrolls today.

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
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

