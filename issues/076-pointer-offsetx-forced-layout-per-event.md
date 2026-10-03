# 076 · Every pointer and wheel event reads MouseEvent.offsetX/offsetY, which forces style and layout whenever anything on the page dirtied layout since the last frame

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/ChartModifiers/ModifierMouseArgs.js:57` |
| Severity | **medium** |
| Pipeline stage | Layout (`layout`) |
| Metric | frame time during hover/pan (also INP for pointerdown/up) |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | EVT-08 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
        const mousePoint = new Point(pointerEvent.offsetX * DpiHelper.PIXEL_RATIO, pointerEvent.offsetY * DpiHelper.PIXEL_RATIO);
```

## Call path and frequency

canvas 'pointermove' listener (MouseManager.js:70) -> onPointerMove (:107) -> ModifierMouseArgs.fromPointerEvent (:113 -> ModifierMouseArgs.js:57). The same read happens in pointerdown (:133), pointerup (:179), pointercancel (:100), wheel (:221 -> ModifierMouseArgs.js:39) and leave/enter/dblclick/drop (ModifierMouseArgs.js:22). It runs once per input event on every surface.

## Why it costs

In Chromium, offsetX/offsetY compute the position relative to the target node and update style and layout first. If a task since the last frame wrote styles or DOM, the pointer handler runs a full-document layout inside script. The frame then lays out again after SciChart's rAF writes its SVG annotations, so there are two layouts per frame where one would do.

**Scale where it matters:** Every hover, pan and wheel interaction. The cost appears on pages whose own code writes DOM between frames: live dashboards updating HTML labels from a feed, framework commits, or SciChart's own DOM tooltip removal with placementDivId.

## Fix (library side)

```diff
--- esm/Charting/ChartModifiers/ModifierMouseArgs.js
-    static fromPointerEvent(pointerEvent) {
+    static fromPointerEvent(pointerEvent, targetRect) {
         Guard.notNull(pointerEvent, "pointerEvent");
-        const mousePoint = new Point(pointerEvent.offsetX * DpiHelper.PIXEL_RATIO, pointerEvent.offsetY * DpiHelper.PIXEL_RATIO);
+        // offsetX/Y force style+layout when anything is dirty; use a rect cached by MouseManager instead
+        const rect = targetRect !== null && targetRect !== void 0 ? targetRect : pointerEvent.target.getBoundingClientRect();
+        const mousePoint = new Point((pointerEvent.clientX - rect.left) * DpiHelper.PIXEL_RATIO, (pointerEvent.clientY - rect.top) * DpiHelper.PIXEL_RATIO);
--- esm/Core/Mouse/MouseManager.js
@@ subscribe(source)
         this.canvas = source;
+        this.rectDirty = true;
+        this.markRectDirty = () => { this.rectDirty = true; };
+        this.resizeObserver = new ResizeObserver(this.markRectDirty);
+        this.resizeObserver.observe(source);
+        window.addEventListener("scroll", this.markRectDirty, { passive: true, capture: true });
+        source.addEventListener("pointerenter", this.markRectDirty);
@@
+    getCanvasRect() {
+        if (this.rectDirty) { this.rect = this.canvas.getBoundingClientRect(); this.rectDirty = false; }
+        return this.rect;
+    }
     onPointerMove(event) {
-        const modifierEvent = ModifierMouseArgs.fromPointerEvent(event);
+        const modifierEvent = ModifierMouseArgs.fromPointerEvent(event, this.getCanvasRect());
@@ unsubscribe(): disconnect resizeObserver, remove the scroll and pointerenter listeners
```

**Trade-off:** The rect is read once after a resize, scroll or pointerenter rather than on every event. If the canvas moves without any of those (content above it grows while the pointer stays inside), coordinates are stale until the next enter or scroll. offsetX is in the target's local CSS space and clientX - rect.left is in viewport space, so charts inside CSS-scaled containers need the cached scale (rect.width / canvas.offsetWidth) applied as well.

## App-side workaround

Keep the page's own DOM writes inside requestAnimationFrame, so layout is clean when pointer events dispatch. Nothing inside the library can be switched off.

## Verify

measure.md#fps hover scenario: an app timer writes text into a page element at 60 Hz while the pointer sweeps over the chart for 5 s, 5 runs per side. Pass: 'Forced by script' in trace-summary.mjs --between wp:start wp:end shows no layout from MouseManager.onPointerMove, and frameP95Ms wins or is neutral.

## Other locations

- `esm/Charting/ChartModifiers/ModifierMouseArgs.js:39` — fromWheelEvent, per wheel event
- `esm/Charting/ChartModifiers/ModifierMouseArgs.js:22` — fromMouseEvent (leave/enter/dblclick/drop)
- `esm/Core/Mouse/MouseManager.js:113` — per pointermove caller

## Review notes

- Found by reviewer slice `s10-modifiers-input`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

