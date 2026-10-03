# 052 · DataValue sub-charts with a wrapper container write wrapper styles and then read section clientWidth/clientHeight on every frame, which forces one layout per sub-chart

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/SciChartSubSurface.js:214` |
| Severity | **medium** |
| Pipeline stage | Layout (`layout`) |
| Metric | frame time during pan, zoom or autoranged streaming |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Rule | EVT-07 (web-performance skill) |
| Effort to fix | medium |

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

native Draw(parent canvas) -> SciChartSurface.js:1331 onRenderSurfaceDraw -> :1346 resolveSurfaceOrders (visible sub-charts) -> :1352 chart.doDrawingLoop(batchContext) for each sub-chart -> :640 render -> SciChartRenderer.js:148-149 updateSubLayout (every render) -> SciChartSubSurface.js:208-210 DataValue mode always takes the branch -> :214 updateWrapper -> sciChartSubSurfaceCommon.js:185-188 (style.left/top/width/height writes) -> SciChartSubSurface.js:215 getOffsets -> sciChartSubSurfaceCommon.js:196-203 (4x getElementsByClassName, then clientWidth/clientHeight on each section element that exists). Runs per rendered frame per DataValue sub-chart; the forced layout needs at least one app-supplied *-section element inside the wrapper. The polar variant is the same (SciChartPolarSubSurface.js:202-203).

## Why it costs

When the computed position or size changes, the four inline style writes dirty style and layout. The clientWidth/clientHeight read that follows makes the browser run style and layout synchronously inside the rAF callback. Because the write/read pairs alternate across sub-charts (and other sub-chart DOM work runs in between), layout runs once per sub-chart instead of once per frame. Identical style strings do not dirty layout, but in DataValue mode the width is the difference of two float coordinates (sciChartSubSurfaceCommon.js:110-121), so its string can change in the last digits even during a pure pan. The section sizes being read depend only on the wrapper size and sectionScale, so most of these reads return the same values.

**Scale where it matters:** K visible sub-charts created with subChartContainerId, a DataValue (or partly DataValue) coordinate mode, and app-supplied left-section/top-section/right-section/bottom-section elements inside the wrapper, for example inset sub-charts with HTML titles or legends that follow the data. While the parent re-renders and their position or size changes (pan, zoom, streaming with autorange), the frame does K interleaved write-then-read pairs, so up to K forced layouts per frame. Without section elements getOffsets reads nothing and no layout is forced by this code.

## Fix (library side)

```diff
--- esm/Charting/Visuals/sciChartSubSurfaceCommon.js:180
 function updateWrapper(sub, padding) {
     if (!sub.parentSurface || !sub.subChartContainer) {
-        return;
+        return undefined;
     }
     const { width: viewWidth, height: viewHeight } = translateToNotScaledRect(sub.parentSurface.viewRect);
+    const width = viewWidth - padding.left - padding.right;
+    const height = viewHeight - padding.top - padding.bottom;
     sub.subChartContainer.style.left = convertToHtmlPx(padding.left);
     sub.subChartContainer.style.top = convertToHtmlPx(padding.top);
-    sub.subChartContainer.style.width = convertToHtmlPx(viewWidth - padding.left - padding.right);
-    sub.subChartContainer.style.height = convertToHtmlPx(viewHeight - padding.top - padding.bottom);
+    sub.subChartContainer.style.width = convertToHtmlPx(width);
+    sub.subChartContainer.style.height = convertToHtmlPx(height);
+    return { width, height };
 }
--- esm/Charting/Visuals/SciChartSubSurface.js:297 (same in SciChartPolarSubSurface.js:292)
     updateWrapper(subChartOffset) {
-        sciChartSubSurfaceCommon.updateWrapper(this, subChartOffset);
+        return sciChartSubSurfaceCommon.updateWrapper(this, subChartOffset);
     }
--- esm/Charting/Services/SciChartRenderer.js:149
-            this.sciChartSurface.updateSubLayout();
+            this.sciChartSurface.updateSubLayout(true); // isDrawing, already declared in ISciChartSubSurface.d.ts:74
--- esm/Charting/Visuals/SciChartSubSurface.js:207 (same in SciChartPolarSubSurface.js:195)
-    updateSubLayout() {
+    updateSubLayout(isDrawing = false) {
         if (!this.offset ||
@@ :214
-            this.updateWrapper(unscaledSubChartOffset);
-            const subChartWrapperOffset = this.getOffsets(this.subChartContainer);
+            const wrapperSize = this.updateWrapper(unscaledSubChartOffset);
+            // Section sizes depend on the wrapper size, not on its position. Re-read them (forced layout) only when
+            // the offset was reset (sectionScale, padding, changeViewportSize, ...), on a manual updateSubLayout() call,
+            // or when the wrapper size moved by >= 0.5px. The tolerance matters: a DataValue width is a difference of
+            // two float coordinates and jitters in the last digits during a pure pan.
+            const last = this.measuredWrapperSize;
+            if (!isDrawing || !this.offset || !this.wrapperOffsetCache || !wrapperSize || !last ||
+                Math.abs(wrapperSize.width - last.width) >= 0.5 || Math.abs(wrapperSize.height - last.height) >= 0.5) {
+                this.wrapperOffsetCache = this.getOffsets(this.subChartContainer);
+                this.measuredWrapperSize = wrapperSize;
+            }
+            const subChartWrapperOffset = this.wrapperOffsetCache;
```

**Trade-off:** If section content changes size while the wrapper size stays within 0.5px and nothing resets this.offset, the sub-chart keeps the old section offsets until the app calls updateSubLayout() (documented for this case in ISciChartSubSurface.d.ts:72-74, and kept as an always-fresh read by the fix) or the wrapper resizes. During a zoom that resizes the wrapper, one forced layout per sub-chart per frame remains; a ResizeObserver on the section elements would remove that too but is a larger change.

## App-side workaround

Use a relative coordinate mode for sub-charts whose wrapper holds *-section elements, or, for DataValue-positioned sub-charts, omit subChartContainerId or keep the wrapper free of left/top/right/bottom-section elements (position the HTML labels yourself), so getOffsets reads no layout.

## Verify

measure.md#fps, `pan` on a chart with 4 or more DataValue sub-charts that have subChartContainerId wrappers containing a top-section and a left-section element. Pass: 'Forced by script' for getOffsets in trace-summary drops to 0 during pan, forcedLayoutMs in __wpProbe.loaf.read() goes down, frame p95 is a win or neutral, and take_screenshot after changing a section's text and calling updateSubLayout() shows the sub-chart re-laid out.

## Other locations

- `esm/Charting/Visuals/sciChartSubSurfaceCommon.js:185` — four inline style writes per frame
- `esm/Charting/Visuals/sciChartSubSurfaceCommon.js:200` — clientWidth/clientHeight reads right after the writes
- `esm/Charting/Visuals/SciChartPolarSubSurface.js:202` — same write-then-read in the polar sub-chart

## Review notes

- Found by reviewer slice `x1-frame-path`.
- Adversarial verification (corrected): Re-read esm/Charting/Visuals/SciChartSubSurface.js:207-219 (code_quote matches lines 207-215; the file has CRLF endings, content identical) and sciChartSubSurfaceCommon.js:180-204 (four style writes at 185-188, four getElementsByClassName at 196-199, clientWidth/clientHeight reads at 200-203). Caller chain confirmed: SciChartSurface.js:1331 onRenderSurfaceDraw -> :1346 resolveSurfaceOrders (visible sub-charts only) -> :1352 chart.doDrawingLoop(batchContext) -> :640 this.sciChartRenderer.render(context) -> SciChartRenderer.js:148-149 updateSubLayout() (unconditional for every sub-surface) -> SciChartSubSurface.js:208-210: in a DataValue (or partly DataValue) coordinate mode the branch runs on every render, not only when this.offset was reset -> :214 updateWrapper (writes) -> :215 getOffsets (reads). Polar is identical (SciChartPolarSubSurface.js:195-206, 292-296). No dirty flag or cache defeats it in DataValue mode. Rule EVT-07 Avoid does not exempt this (the reads follow style writes). Corrections: (1) the forced layout happens only when the wrapper actually contains elements with class left-section/top-section/right-section/bottom-section: getOffsets reads clientWidth/clientHeight only on elements it finds (sciChartSubSurfaceCommon.js:200-203 use ?.), and those sections are app-supplied markup, so scale/verify/app_workaround now state that; (2) the original fix compared wrapper width/height with strict equality, but in DataValue mode the width is rightAbsolute - leftAbsolute from two coordinate-calculator outputs (sciChartSubSurfaceCommon.js:110-121, utils/translate.js:94-112), which jitters in the last float digits during a pure pan (a node simulation of a linear calculator changed the width string in 85 of 199 pan steps), so the cache would miss most frames; the corrected fix uses a 0.5px tolerance against the size at the last read; (3) the original cache was not cleared on sectionScale/padding/changeViewportSize changes (getOffsets multiplies by sectionScale) and would also have broken the documented manual refresh (ISciChartSubSurface.d.ts:72-74: 'Call if you update the size of html elements in the wrapper'); the corrected fix re-reads whenever this.offset was reset and on any call without isDrawing, and the renderer passes isDrawing=true (parameter already declared in ISciChartSubSurface.d.ts:74); (4) effort medium (four files). Severity stays medium: per frame, but only in an opt-in configuration (DataValue mode + subChartContainerId + section elements), and the per-layout cost is not shown by the code. Evidence stays S: the write-then-read order per sub-chart per rendered frame is certain on this path.

