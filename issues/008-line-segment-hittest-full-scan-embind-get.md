# 008 · Line-segment and unsorted-line hit tests scan the whole series in JS, 3 passes, with an embind get() per value, on every pointer move

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/HitTest/hitTestHelpers.js:193` |
| Severity | **high** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | INP (pointermove processing) and frame time while hovering |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | SC-06, V8-01, GPU-28 (web-performance skill) |
| Effort to fix | small |

## Code

```js
    updateMinMaxFn(getXFn, getYFn);
    updateMinMaxFn(getX1Fn, getY1Fn);
    const xHitValue = xCoordinateCalculator.getDataValue(xHitCoord);
    const yHitValue = yCoordinateCalculator.getDataValue(yHitCoord);
    const isWithinDataBounds = minX <= xHitValue && xHitValue <= maxX && minY <= yHitValue && yHitValue <= maxY;
    // Test for lines
    let minDistance = Number.MAX_VALUE;
    let minDistanceIndex = -1;
    for (let i = 0; i < numberOfSegments; i++) {
        const x = getXFn(i);
        const y = getYFn(i);
        const x1 = getX1Fn(i);
        const y1 = getY1Fn(i);
        const xCoord = xCoordinateCalculator.getCoordinate(x);
```

## Call path and frequency

pointermove -> Core/Mouse/MouseManager.js:107 onPointerMove -> :114 modifierMouseMove -> :322 cm.modifierMouseMove (synchronous, no rAF coalescing) -> Charting/ChartModifiers/RolloverModifier.js:252 modifierMouseMove -> :273 update() -> :579 hitTestRenderableSeries (plus :483 when snapToDataPoint and :634 when tooltipLegendTemplate is set) -> :347 hitTestXSlice -> HitTest/LineSegmentSeriesHitTestProvider.js:124 hitTestXSlice -> :12 hitTest -> :25 hitTestXy (closures at :40-43) -> hitTestHelpers.js:178 getNearestLineSegment. The same scan runs per render while the pointer is in the plot: Charting/Services/SciChartRenderer.js:174 onParentSurfaceLayoutComplete -> RolloverModifier.js:294 update(). CursorModifier.js:457/460 and SeriesSelectionModifier.js:159 (enableHover) reach it too; for an unsorted FastLineRenderableSeries via LineSeriesHitTestProvider.js:24 hitTestUnsorted (:92-96). Frequency: per pointer event x included series x 1-3, plus per frame while hovering.

## Why it costs

For sorted series the library answers with one native SCRTHitTestHelper.GetNearestXyPoint call. Unsorted lines and all line-segment series fall back to a JS scan over the entire data set (the visible range is not used). Every read goes through an embind getter instead of a Float64Array view, and the bounding box is computed in two extra full passes before the distance pass. This is synchronous main-thread work inside the pointermove handler and inside the render (Rollover update), so it adds to input processing time and to frame time in proportion to N.

**Scale where it matters:** Matters from about 10k segments. Per segment the code makes 8 vector get() calls (2 + 2 in the bounding-box passes, 4 in the segment pass) and 4 GetCoordinate calls, all JS->wasm. A FastLineSegmentRenderableSeries with 100k points (50k segments) means about 600k embind calls per hit test, repeated 1-3 times per pointer move and again on every frame while hovering.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/HitTest/hitTestHelpers.js
+++ b/esm/Charting/Visuals/RenderableSeries/HitTest/hitTestHelpers.js
@@ const getNearestLineSegment = (...) => {
     let minY = Number.MAX_VALUE;
     let maxY = Number.NEGATIVE_INFINITY;
-    const updateMinMaxFn = (getXFn$, getYFn$) => { for (let i = 0; i < numberOfSegments; i++) { ... } };
-    updateMinMaxFn(getXFn, getYFn);
-    updateMinMaxFn(getX1Fn, getY1Fn);
-    const xHitValue = xCoordinateCalculator.getDataValue(xHitCoord);
-    const yHitValue = yCoordinateCalculator.getDataValue(yHitCoord);
-    const isWithinDataBounds = minX <= xHitValue && xHitValue <= maxX && minY <= yHitValue && yHitValue <= maxY;
     // Test for lines
     let minDistance = Number.MAX_VALUE;
     let minDistanceIndex = -1;
     for (let i = 0; i < numberOfSegments; i++) {
         const x = getXFn(i);
         const y = getYFn(i);
         const x1 = getX1Fn(i);
         const y1 = getY1Fn(i);
+        // bounding box in the same pass (was 2 extra passes, 4 more reads per segment)
+        if (x < minX) minX = x;
+        if (x > maxX) maxX = x;
+        if (x1 < minX) minX = x1;
+        if (x1 > maxX) maxX = x1;
+        if (y < minY) minY = y;
+        if (y > maxY) maxY = y;
+        if (y1 < minY) minY = y1;
+        if (y1 > maxY) maxY = y1;
         const xCoord = xCoordinateCalculator.getCoordinate(x);
@@ after the loop
+    const xHitValue = xCoordinateCalculator.getDataValue(xHitCoord);
+    const yHitValue = yCoordinateCalculator.getDataValue(yHitCoord);
+    const isWithinDataBounds = minX <= xHitValue && xHitValue <= maxX && minY <= yHitValue && yHitValue <= maxY;
     return {
--- a/esm/Charting/Visuals/RenderableSeries/HitTest/LineSegmentSeriesHitTestProvider.js
+++ b/esm/Charting/Visuals/RenderableSeries/HitTest/LineSegmentSeriesHitTestProvider.js
+import { vectorToArrayViewF64 } from "../../../../utils/vectorToArray";
@@ hitTestXy(x, y, hitTestRadius) {
-        const getXFn = (i) => xNativeValues.get(2 * i);
-        const getYFn = (i) => yNativeValues.get(2 * i);
-        const getX1Fn = (i) => xNativeValues.get(2 * i + 1);
-        const getY1Fn = (i) => yNativeValues.get(2 * i + 1);
+        // Zero-copy views: one typed-array load per read instead of one embind call. The scan
+        // allocates nothing in wasm, so the views stay attached. Fifo rings keep the logical get().
+        const xs = dataSeries.fifoCapacity ? undefined : vectorToArrayViewF64(xNativeValues, this.webAssemblyContext);
+        const ys = dataSeries.fifoCapacity ? undefined : vectorToArrayViewF64(yNativeValues, this.webAssemblyContext);
+        const getXFn = xs ? (i) => xs[2 * i] : (i) => xNativeValues.get(2 * i);
+        const getYFn = ys ? (i) => ys[2 * i] : (i) => yNativeValues.get(2 * i);
+        const getX1Fn = xs ? (i) => xs[2 * i + 1] : (i) => xNativeValues.get(2 * i + 1);
+        const getY1Fn = ys ? (i) => ys[2 * i + 1] : (i) => yNativeValues.get(2 * i + 1);
 (same change for hitTestXyXy at :91-94 with x1Values/y1Values, and in LineSeriesHitTestProvider.hitTestUnsorted at :92-95)
```

**Trade-off:** Fifo series keep the embind path because a raw view is in ring order. Results are unchanged: a throwaway Node equivalence check of the fused pass against the original (2,000 random cases with NaNs) gave identical outputs (correctness only, not timing). The scan is still O(N). A further step is to reuse the previous end-point coordinates in the Line case (x1 of segment i is x of segment i+1), which halves the GetCoordinate calls.

## App-side workaround

Exclude large segment or unsorted series from hover hit tests: set rs.rolloverModifierProps.showRollover = false or modifier.includeSeries(rs, false), and keep enableHover off in SeriesSelectionModifier. Alternatively, assign rs.hitTestProvider to a subclass of LineSegmentSeriesHitTestProvider that builds the closures over vectorToArrayViewF64 views as above. Keep line data sorted in X so the native path is used.

## Verify

measure.md#fps with a 'hover' scenario hook that drives RolloverModifier across the plot at 120 moves/s for 5 s, on a FastLineSegmentRenderableSeries with 100k points; also measure.md#inp for single moves; 5 runs per side. Pass: compare-runs 'win' on frameP95Ms and on LoAF script time attributed to getNearestLineSegment, with identical hit results (nearest index, isHit) on a recorded pointer path.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/HitTest/LineSegmentSeriesHitTestProvider.js:40` — hitTestXy closures over xNativeValues.get(2*i)
- `esm/Charting/Visuals/RenderableSeries/HitTest/LineSegmentSeriesHitTestProvider.js:91` — hitTestXyXy closures over four vectors' get()
- `esm/Charting/Visuals/RenderableSeries/HitTest/LineSegmentSeriesHitTestProvider.js:124` — hitTestXSlice and hitTestDataPoint both route to the full scan, so Rollover and Cursor always take it
- `esm/Charting/Visuals/RenderableSeries/HitTest/LineSeriesHitTestProvider.js:92` — hitTestUnsorted, same closures over get()
- `esm/Charting/Visuals/RenderableSeries/Polar/HitTest/PolarLineSeriesHitTestProvider.js:31` — exported opt-in provider: same full scan with 2 get + 2 GetCoordinate + convertPolarToCartesian and a Point per data point

## Review notes

- Found by reviewer slice `s05-labels-hittest-anim`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

