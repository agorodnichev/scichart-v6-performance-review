# 076 · Every pointer and wheel event reads MouseEvent.offsetX/offsetY, which forces style and layout whenever anything on the page dirtied layout since the last frame

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/ChartModifiers/ModifierMouseArgs.js:57` |
| Severity | **medium** |
| Pipeline stage | Layout (`layout`) |
| Metric | frame time during hover/pan (also INP for pointerdown/up) |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
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
+        // offsetX/Y force style+layout when anything is dirty; use the origin cached by MouseManager instead
+        const rect = targetRect !== null && targetRect !== void 0 ? targetRect : pointerEvent.target.getBoundingClientRect();
+        const mousePoint = new Point((pointerEvent.clientX - rect.left) * DpiHelper.PIXEL_RATIO, (pointerEvent.clientY - rect.top) * DpiHelper.PIXEL_RATIO);
   (same change in fromWheelEvent :39 and fromMouseEvent :22)
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
+        if (this.rectDirty) {
+            const r = this.canvas.getBoundingClientRect();
+            // offsetX is measured from the padding edge, getBoundingClientRect from the border edge
+            this.rect = { left: r.left + this.canvas.clientLeft, top: r.top + this.canvas.clientTop };
+            this.rectDirty = false;
+        }
+        return this.rect;
+    }
     onPointerMove(event) {
-        const modifierEvent = ModifierMouseArgs.fromPointerEvent(event);
+        const modifierEvent = ModifierMouseArgs.fromPointerEvent(event, this.getCanvasRect());
@@ onPointerDown (also the tap event), onPointerUp, onPointerCancel, onMouseWheel (fromWheelEvent), onDoubleClick/onMouseLeave/onMouseEnter/onDrop (fromMouseEvent): pass this.getCanvasRect() the same way
@@ unsubscribe(): disconnect resizeObserver, remove the scroll and pointerenter listeners
```

**Trade-off:** The rect is read once after a resize, scroll or pointerenter rather than on every event. If the canvas moves without any of those (content above it grows while the pointer stays inside), coordinates are stale until the next enter or scroll. offsetX is in the target's local CSS space and from its padding edge, while clientX - rect.left is in viewport space from the border edge: the cached origin adds clientLeft/clientTop for app-styled borders, and charts inside CSS-transformed or scaled containers need the cached scale (rect.width / canvas.offsetWidth) applied as well.

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
- Adversarial verification (corrected): Re-read ModifierMouseArgs.js:20-70 (fromMouseEvent :22, fromWheelEvent :39, fromPointerEvent :57 all read offsetX/offsetY), MouseManager.js:66-80 (subscribe on the canvas), :98-279 (every handler builds args through these factories: pointercancel :100, pointermove :113, pointerdown :133 and tap :152, pointerup :179, dblclick :203, wheel :221, leave :242, enter :260, drop :277), SciChartSurfaceBase.js:290-296 (the source is the WebGL or 2D canvas, which has no children, so the target is the canvas), SciChartSurface.js:365-375 (sub-surfaces unsubscribe their own MouseManager, so one read per event per top-level surface). No cached rect or coordinate exists anywhere on this path. The mechanism is real: offsetX/offsetY are on the list of layout-forcing reads, and in Chromium the first read updates style and layout for the target. It costs only when something dirtied style or layout since the last frame; SciChart's own SVG writes run in rAF and are laid out in that frame, so the trigger is usually app code or a DOM write by an earlier handler in the same frame. Evidence H and severity medium kept for that reason. Corrections to the fix: offsetX is measured from the target's padding edge and getBoundingClientRect from the border edge, so the cached origin must add canvas.clientLeft/clientTop to be exact when app CSS gives the canvas a border; the diff only rewired onPointerMove, and now names the other handlers (down/up/cancel, wheel through fromWheelEvent, dblclick/leave/enter/drop through fromMouseEvent) that need the same rect.

