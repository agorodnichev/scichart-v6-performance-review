# 052 · DataValue sub-charts with a wrapper container write wrapper styles and then read section clientWidth/clientHeight on every frame, which forces one layout per sub-chart

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/SciChartSubSurface.js:214` |
| Severity | **medium** |
| Pipeline stage | Layout (`layout`) |
| Metric | frame time during pan, zoom or autoranged streaming |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | EVT-07 (web-performance skill) |
| Effort to fix | small |

## Code

```js
    updateSubLayout() {
        if (!this.offset ||
            this.coordinateMode === ESubSurfacePositionCoordinateMode.DataValue ||
            this.coordinateMode.includes(ESubSurfacePositionCoordinateMode.DataValue)) {
            // includes subchart wrapper
            const subChartOffset = this.calcPadding();
            const unscaledSubChartOffset = new Thickness(translateToNotScaled(subChartOffset.top), translateToNotScaled(subChartOffset.right), translateToNotScaled(subChartOffset.bottom), translateToNotScaled(subChartOffset.left));
            this.updateWrapper(unscaledSubChartOffset);
            const subChartWrapperOffset = this.getOffsets(this.subChartContainer);
```

## Call path and frequency

native Draw(parent canvas) -> SciChartSurface.js:1331 onRenderSurfaceDraw -> :1352 chart.doDrawingLoop(batchContext) for each sub-chart -> :640 render -> SciChartRenderer.js:148-149 updateSubLayout -> SciChartSubSurface.js:214 updateWrapper -> sciChartSubSurfaceCommon.js:185-188 (style.left/top/width/height writes) -> SciChartSubSurface.js:215 getOffsets -> sciChartSubSurfaceCommon.js:196-203 (4x getElementsByClassName + clientWidth/clientHeight reads). Runs per rendered frame per DataValue sub-chart. The polar variant is the same (SciChartPolarSubSurface.js:202-203).

## Why it costs

When the computed position changes, the four inline style writes dirty style and layout. The clientWidth read that follows makes the browser run style and layout synchronously inside the rAF callback. Because the write/read pairs alternate across sub-charts, the layout runs once per sub-chart instead of once per frame. Identical style values do not dirty layout, so a static chart pays only the reads.

**Scale where it matters:** K sub-charts created with subChartContainerId and a DataValue coordinate mode, for example inset or annotation-like sub-charts that follow the data. While their position or size changes (pan, zoom, streaming with autorange), the frame does K interleaved write-then-read pairs, so K forced layouts per frame.

## Fix (library side)

```diff
--- esm/Charting/Visuals/sciChartSubSurfaceCommon.js:180
 function updateWrapper(sub, padding) {
     if (!sub.parentSurface || !sub.subChartContainer) {
-        return;
+        return false;
     }
     const { width: viewWidth, height: viewHeight } = translateToNotScaledRect(sub.parentSurface.viewRect);
+    const w = viewWidth - padding.left - padding.right;
+    const h = viewHeight - padding.top - padding.bottom;
+    const sizeChanged = sub.lastWrapperWidth !== w || sub.lastWrapperHeight !== h;
+    sub.lastWrapperWidth = w;
+    sub.lastWrapperHeight = h;
     sub.subChartContainer.style.left = convertToHtmlPx(padding.left);
     sub.subChartContainer.style.top = convertToHtmlPx(padding.top);
-    sub.subChartContainer.style.width = convertToHtmlPx(viewWidth - padding.left - padding.right);
-    sub.subChartContainer.style.height = convertToHtmlPx(viewHeight - padding.top - padding.bottom);
+    sub.subChartContainer.style.width = convertToHtmlPx(w);
+    sub.subChartContainer.style.height = convertToHtmlPx(h);
+    return sizeChanged;
 }
--- esm/Charting/Visuals/SciChartSubSurface.js:214 (and :297 updateWrapper returns the value)
-            this.updateWrapper(unscaledSubChartOffset);
-            const subChartWrapperOffset = this.getOffsets(this.subChartContainer);
+            const wrapperResized = this.updateWrapper(unscaledSubChartOffset);
+            // section sizes depend on the wrapper size, not its position: read layout only after a resize
+            if (wrapperResized || !this.wrapperOffsetCache) {
+                this.wrapperOffsetCache = this.getOffsets(this.subChartContainer);
+            }
+            const subChartWrapperOffset = this.wrapperOffsetCache;
```

**Trade-off:** If section content changes size without the wrapper resizing (for example text in a section), the cached offsets go stale. Clear wrapperOffsetCache wherever this.offset is reset (sectionScale, changeViewportSize), or watch the sections with a ResizeObserver. During a zoom that changes the wrapper size, one forced layout per sub-chart remains.

## App-side workaround

Use a relative coordinate mode for sub-charts that need an HTML wrapper, or omit subChartContainerId (no HTML sections) for DataValue-positioned sub-charts.

## Verify

measure.md#fps, `pan` on a chart with 4 or more DataValue sub-charts that have subChartContainerId wrappers. Pass: 'Forced by script' for getOffsets in trace-summary drops to 0 during pan, forcedLayoutMs in __wpProbe.loaf.read() goes down, and frame p95 is a win or neutral.

## Other locations

- `esm/Charting/Visuals/sciChartSubSurfaceCommon.js:185` — four inline style writes per frame
- `esm/Charting/Visuals/sciChartSubSurfaceCommon.js:200` — clientWidth/clientHeight reads right after the writes
- `esm/Charting/Visuals/SciChartPolarSubSurface.js:202` — same write-then-read in the polar sub-chart

## Review notes

- Found by reviewer slice `x1-frame-path`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

