# 030 · A DataValue-positioned sub-chart with a subChartContainer writes 4 inline styles and then reads clientWidth/clientHeight of its sections on every frame, forcing a synchronous layout per sub-chart

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/SciChartSubSurface.js:207` |
| Severity | **medium** |
| Pipeline stage | Layout (`layout`) |
| Metric | frame time (also INP on pan/zoom) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/91e8b2da94216d1669badb28679555d4/): reproduced on WebGL and WebGPU ([source](../demos/030-datavalue-subchart-forced-layout/)) |
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
            // subSurface offset (after measuring content of the wrapper)
            this.offset = Thickness.mergeAdd(subChartOffset, subChartWrapperOffset);
        }
    }
```

## Call path and frequency

Engine frame -> SciChartSurface.onRenderSurfaceDraw (esm/Charting/Visuals/SciChartSurface.js:1347-1352, once per visible sub-chart) -> doDrawingLoop (:640) -> SciChartRenderer.render (esm/Charting/Services/SciChartRenderer.js:148-149, isSubSurface) -> SciChartSubSurface.updateSubLayout (esm/Charting/Visuals/SciChartSubSurface.js:207-219) -> sciChartSubSurfaceCommon.updateWrapper (:180-189, 4 style writes) -> getOffsets (:190-205, up to 4 layout reads). Per sub-chart per frame when coordinateMode includes DataValue and subChartContainerId resolved to an element (SciChartSubSurface.js:80-85) that contains section elements.

## Why it costs

The wrapper's position and size are written as inline styles and the section sizes are read back in the same task, so the read forces style recalculation and layout inside script; with several such sub-charts, writes and reads alternate, giving one layout per sub-chart instead of one per frame. Chromium skips invalidation for an inline-style write with an unchanged value, so the forced layout happens on frames where left/top/size changed (pan or zoom of the parent along the sub-chart's DataValue axes) or where earlier DOM writes in the same frame (SVG annotation updates, clip-path rewrites) have dirtied style. While panning only left/top change, which cannot change the section sizes, so that read is wasted.

**Scale where it matters:** Parent surfaces with N sub-charts positioned in DataValue coordinates that also use an HTML wrapper (subChartContainerId with top/left/right/bottom section elements): up to N forced layouts per frame while panning, zooming or streaming the parent. Without a container, updateWrapper returns early and getOffsets returns zero, so the common configuration is not affected.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/sciChartSubSurfaceCommon.js
+++ b/esm/Charting/Visuals/sciChartSubSurfaceCommon.js
 function updateWrapper(sub, padding) {
     if (!sub.parentSurface || !sub.subChartContainer) {
-        return;
+        return false;
     }
     const { width: viewWidth, height: viewHeight } = translateToNotScaledRect(sub.parentSurface.viewRect);
-    sub.subChartContainer.style.left = convertToHtmlPx(padding.left);
-    sub.subChartContainer.style.top = convertToHtmlPx(padding.top);
-    sub.subChartContainer.style.width = convertToHtmlPx(viewWidth - padding.left - padding.right);
-    sub.subChartContainer.style.height = convertToHtmlPx(viewHeight - padding.top - padding.bottom);
+    const style = sub.subChartContainer.style;
+    const last = sub.lastWrapperBox || (sub.lastWrapperBox = {});
+    const left = convertToHtmlPx(padding.left), top = convertToHtmlPx(padding.top);
+    const width = convertToHtmlPx(viewWidth - padding.left - padding.right);
+    const height = convertToHtmlPx(viewHeight - padding.top - padding.bottom);
+    if (last.left !== left) style.left = last.left = left;
+    if (last.top !== top) style.top = last.top = top;
+    const sizeChanged = last.width !== width || last.height !== height;
+    if (sizeChanged) { style.width = last.width = width; style.height = last.height = height; }
+    return sizeChanged;
 }
--- a/esm/Charting/Visuals/SciChartSubSurface.js   (same in SciChartPolarSubSurface.js:202-203 and :292-293)
+++ b/esm/Charting/Visuals/SciChartSubSurface.js
-            this.updateWrapper(unscaledSubChartOffset);
-            const subChartWrapperOffset = this.getOffsets(this.subChartContainer);
+            const sizeChanged = this.updateWrapper(unscaledSubChartOffset);
+            if (sizeChanged || !this.wrapperOffset) {
+                // a move (left/top) cannot change the section sizes: read layout only after a resize
+                this.wrapperOffset = this.getOffsets(this.subChartContainer);
+            }
+            const subChartWrapperOffset = this.wrapperOffset;
@@ updateWrapper(subChartOffset)
-        sciChartSubSurfaceCommon.updateWrapper(this, subChartOffset);
+        return sciChartSubSurfaceCommon.updateWrapper(this, subChartOffset);
# also set this.wrapperOffset = undefined wherever this.offset = undefined is set (SciChartSubSurface.js:117, 130, 143, 156, 173, 187, 200, 230)
```

**Trade-off:** In DataValue mode, section content that changes size without a wrapper resize (for example a title text change by the app) is no longer picked up on the next frame; it is picked up on the next resize or offset reset, which is what Relative and Pixel modes already do today. To keep it live, refresh wrapperOffset from a ResizeObserver on the four sections (EVT-08). Zoom frames that change the wrapper size still pay one forced layout per sub-chart. The lastWrapperBox cache assumes nothing else writes those four inline styles.

## App-side workaround

Do not combine DataValue coordinate mode with subChartContainerId; position HTML title sections from the app in the surface's rendered event using cached sizes. Or use Relative or Pixel coordinate mode, where the wrapper is measured only after an offset reset.

## Verify

measure.md#fps, `pan` scenario on a parent with 10 DataValue sub-charts that use subChartContainerId with section elements, 5 runs per side. Pass: trace-summary 'Forced by script' layouts attributed to getOffsets drop to 0 during a pure pan; forcedLayoutMs in __wpProbe.loaf.read() goes down; compare-runs gives 'win' or neutral on frameP95Ms. Not measured.

## Other locations

- `esm/Charting/Visuals/sciChartSubSurfaceCommon.js:185` — style.left/top/width/height written unconditionally (:185-188)
- `esm/Charting/Visuals/sciChartSubSurfaceCommon.js:196` — 4 getElementsByClassName (:196-199) + clientWidth/clientHeight reads (:200-203)
- `esm/Charting/Visuals/SciChartPolarSubSurface.js:195` — same updateWrapper -> getOffsets sequence in the polar sub-surface (:202-203)

## Review notes

- Found by reviewer slice `s01-surface-render`.
- Adversarial verification (corrected): Quote matches verbatim at SciChartSubSurface.js:207-219 (primary moved from :214 to :207; :214-215 noted). Confirmed SciChartRenderer.render calls updateSubLayout for every sub-surface render (:148-149) and onRenderSurfaceDraw renders each visible sub-chart per frame (:1347-1352). In DataValue mode the condition is true on every call regardless of this.offset. updateWrapper (sciChartSubSurfaceCommon.js:180-189) writes 4 inline styles unconditionally; getOffsets (:190-205) reads clientWidth/clientHeight immediately after. Scope narrowed: subChartContainer exists only when subChartContainerId is set (SciChartSubSurface.js:80-85); without it updateWrapper returns early and getOffsets returns Thickness 0, and without section elements there are no reads. Refined the mechanism: same-value inline-style writes do not invalidate in Chromium, so the layout is forced on pan/zoom frames or after other same-frame DOM writes. Listed the offset-reset lines for wrapperOffset and stated the behaviour change in DataValue mode. EVT-07's Avoid does not exempt this case.

