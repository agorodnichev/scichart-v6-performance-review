# 008 · Line-segment hit tests (and unsorted-line hover selection) scan the whole series in JS, 3 passes, with an embind get() per value, on every pointer move

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/HitTest/hitTestHelpers.js:193` |
| Severity | **high** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | INP (pointermove processing) and frame time while hovering |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
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

pointermove -> Core/Mouse/MouseManager.js:70 listener -> :107 onPointerMove -> :114 modifierMouseMove -> :322 cm.modifierMouseMove (synchronous, no rAF coalescing) -> Charting/ChartModifiers/RolloverModifier.js:252 modifierMouseMove -> :273 update() (returns early unless the pointer is in the series area) -> :579 hitTestRenderableSeries per included series (plus :483 when snapToDataPoint and :634 when tooltipLegendTemplate is set) -> :346-350 hitTestXSlice (default hitTestRadius 0) or hitTestDataPoint -> HitTest/LineSegmentSeriesHitTestProvider.js:124/:128 -> :12 hitTest -> :25 hitTestXy (closures at :40-43) or :74 hitTestXyXy (closures at :91-94) -> hitTestHelpers.js:178 getNearestLineSegment. CursorModifier.js:456-460 reaches it the same way. The same scan runs per render while the pointer is in the plot: Charting/Services/SciChartRenderer.js:174 onParentSurfaceLayoutComplete -> RolloverModifier.js:294 update(). Unsorted FastLineRenderableSeries: LineSeriesHitTestProvider overrides only hitTest (:24 hitTestUnsorted, closures :92-96). Rollover and Cursor therefore use the native BaseHitTestProvider hitTestXSlice/hitTestDataPoint for it. Only hitTest() callers reach the scan: SeriesSelectionModifier.js:159 per pointermove when enableHover is true, :237 per click, and app code. Frequency for line-segment series: per pointer event x included series x 1-3, plus per render while hovering.

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
- `esm/Charting/Visuals/RenderableSeries/HitTest/LineSeriesHitTestProvider.js:92` — hitTestUnsorted, same closures over get(); reached only through hitTest() (SeriesSelectionModifier hover/click, app code). Rollover and Cursor use the native base XSlice/DataPoint path for FastLine
- `esm/Charting/Visuals/RenderableSeries/Polar/HitTest/PolarLineSeriesHitTestProvider.js:31` — exported opt-in provider: same full scan with 2 get + 2 GetCoordinate + convertPolarToCartesian and a Point per data point

## Review notes

- Found by reviewer slice `s05-labels-hittest-anim`.
- Adversarial verification (corrected): Re-read HitTest/hitTestHelpers.js:178-228. The code_quote matches lines 193-206 verbatim. Two full bounding-box passes run (:183-194), then the segment pass (:201-221) with 4 get() reads and 4 getCoordinate calls per segment. getCoordinate is this.nativeCalculator.GetCoordinate (CoordinateCalculatorBase.js:52-53), so it crosses into wasm. Nothing narrows the scan to the visible range, and nothing caches between moves. LineSegmentSeriesHitTestProvider.js: hitTest :12-20 -> hitTestXy :25 (closures :40-43 over xNativeValues.get(2*i)) or hitTestXyXy :74 (closures :91-94). hitTestXSlice :124 and hitTestDataPoint :128 both route to hitTest, so every modifier hits the full scan. FastLineSegmentRenderableSeries.js:55 wires this provider. Pointer chain: MouseManager.js:70 addEventListener('pointermove', onPointerMove) -> :107 onPointerMove -> :114 modifierMouseMove, synchronous with no rAF coalescing -> :322 cm.modifierMouseMove -> RolloverModifier.js:252 -> :273 update() -> early return unless the pointer is in the series area -> :579 hitTestRenderableSeries per included series (plus :483 when snapToDataPoint and :634 getSeriesInfos when tooltipLegendTemplate is set) -> :346-350 hitTestXSlice (default hitTestRadius 0, :65) or hitTestDataPoint. Cursor takes the same route at CursorModifier.js:456-460. It also runs per render while hovering: SciChartRenderer.js:174 onParentSurfaceLayoutComplete -> RolloverModifier.js:293-294 update(). The scale arithmetic checks out: 8 get + 4 GetCoordinate = 12 embind calls per segment, so 50k segments means about 600k calls. CORRECTED the unsorted FastLine part. LineSeriesHitTestProvider overrides only hitTest (:11-26 -> hitTestUnsorted :74, closures :92-95). Its hitTestXSlice and hitTestDataPoint are inherited from BaseHitTestProvider.js:30/:66, which use the native SCRTHitTestHelper.GetNearestXyPoint (hitTestHelpers.js:76-96). So Rollover and Cursor do NOT reach the JS scan for unsorted FastLine series. Only hitTest() callers do: SeriesSelectionModifier.js:159 on pointermove when enableHover is true (default false, :52), :237 per click, and app code. I narrowed the title, call_path and that other_location to match. Rules: SC-06 and V8-01 name per-index get(i) loops and repeated passes, and their Avoid fields excuse only small collections. Fix checked: the fused min/max uses `if (x < minX)`, which treats NaN like the original ternaries. getDataValue moved after the loop returns the same values. vectorToArrayViewF64 (utils/vectorToArray.js:74-87) uses dataPtrZero for FIFO vectors (raw ring order), so the FIFO fallback to get() is required and correct. The import path ../../../../utils/vectorToArray resolves to esm/utils from HitTest/. this.webAssemblyContext is set in BaseHitTestProvider.js:19. The loop's embind calls (GetCoordinate/GetDataValue with doubles) do not allocate, so the views stay attached. Severity high is kept: per pointer event per included series, plus per render while hovering. Evidence S is kept: the per-move full scan is certain, and its absolute cost scales with N.

