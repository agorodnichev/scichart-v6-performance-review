# 009 · Rectangle and polar-column hit tests always run the O(N) scan and evaluate the Y test (4 embind calls) for every column before the X test

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/HitTest/hitTestHelpersRectangleSeries.js:156` |
| Severity | **high** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | INP (pointermove processing) and frame time while hovering |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | SC-06, V8-01, GPU-28 (web-performance skill) |
| Effort to fix | small |

## Code

```js
    const updateResValuesFn = (left$, right$, index$) => {
        // Calculating data bounds
        if (left$ < resLeftDataBoundCoord)
            resLeftDataBoundCoord = left$;
        if (right$ > resRightDataBoundCoord)
            resRightDataBoundCoord = right$;
        const isYHit$ = testIsYHit(yValues, y1Values, yCoordinateCalculator, yHitCoord, defaultY1, index$, columnYMode);
        const { isHit: isXHit$, xCoordDist: xCoordDist$, xHitCoord: xHitCoord$ } = testIsXHitFn(left$, right$);
        const isBothHit$ = isXHit$ && isYHit$;
```

## Call path and frequency

pointermove -> Core/Mouse/MouseManager.js:114 -> :322 -> Charting/ChartModifiers/RolloverModifier.js:273 update() -> :579 hitTestRenderableSeries -> :347 hitTestXSlice (CursorModifier.js:457/460 and SeriesSelectionModifier.js:159 the same way) -> HitTest/RectangleSeriesHitTestProvider.js:60 hitTestXSlice -> :27 hitTest -> :45 this.hitTestForBox -> :71 hitTestHelpersRectangleSeries.hitTestForBoxUnsorted (unconditionally) -> hitTestHelpersRectangleSeries.js:187-241 per-element loop -> :150 updateResValuesFn -> :156 testIsYHit (:4-5 two get(), :20-21 two GetCoordinate). Also per render while hovering via SciChartRenderer.js:174 -> RolloverModifier.js:294. Used by FastRectangleRenderableSeries (:360), PolarColumnRenderableSeries (:115) and PolarStackedColumnRenderableSeries (:325). Frequency: per pointer event x series x 1-3, plus per frame while hovering.

## Why it costs

RectangleSeriesHitTestProvider.hitTestForBox ignores sorting and always calls the unsorted O(N) helper; the O(log N) helper hitTestForBoxSorted exists (hitTestHelpersRectangleSeries.js:31) but its call is commented out. Inside the scan, the Y test runs before the X test, so every column pays 4 embind round trips whose result is discarded unless the X test hits (normally 1-2 columns). The X reads already use typed-array views (:183-184); the Y reads use vector.get(). All of this runs synchronously in the pointermove handler and in the Rollover update on each render.

**Scale where it matters:** Per element: 1-2 GetCoordinate for X, then testIsYHit with 2 vector get() + 2 GetCoordinate. testIsXHitFn also returns a new object per element; on polar charts each element also allocates a 2-element array plus a forEach closure. 20k rectangles (Gantt or histogram-style data) means about 100k JS->wasm calls and 20k-60k short-lived objects per hit test.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/HitTest/hitTestHelpersRectangleSeries.js
+++ b/esm/Charting/Visuals/RenderableSeries/HitTest/hitTestHelpersRectangleSeries.js
@@ const updateResValuesFn = (left$, right$, index$) => {
         if (right$ > resRightDataBoundCoord)
             resRightDataBoundCoord = right$;
-        const isYHit$ = testIsYHit(yValues, y1Values, yCoordinateCalculator, yHitCoord, defaultY1, index$, columnYMode);
         const { isHit: isXHit$, xCoordDist: xCoordDist$, xHitCoord: xHitCoord$ } = testIsXHitFn(left$, right$);
-        const isBothHit$ = isXHit$ && isYHit$;
+        // Y only decides anything when X hits: skip 2 vector reads + 2 coordinate conversions otherwise
+        const isBothHit$ = isXHit$ &&
+            testIsYHit(yValues, y1Values, yCoordinateCalculator, yHitCoord, defaultY1, index$, columnYMode);
```

**Trade-off:** None for the reordering: isYHit$ is only read in isBothHit$, so results are identical. A larger follow-up would dispatch sorted, non-overlapping Mid/Start columns to hitTestForBoxSorted (O(log N)), but that helper assumes columns do not overlap, so it needs a data-shape check or an opt-in flag.

## App-side workaround

Override hitTestForBox in a RectangleSeriesHitTestProvider subclass (the class documents it as the extension point) to call hitTestHelpersRectangleSeries.hitTestForBox(..., isSorted, isPolar) when the data is sorted and the columns do not overlap, and assign it to rs.hitTestProvider. Or exclude large rectangle series from Rollover/Cursor hit tests (showRollover = false / includeSeries(rs, false)).

## Verify

measure.md#fps with a 'hover' scenario hook that drives CursorModifier at 120 moves/s for 5 s over a FastRectangleRenderableSeries with 20k StartEnd rectangles (and a 360-column PolarColumnRenderableSeries), 5 runs per side; measure.md#inp for single moves. Pass: compare-runs 'win' on frameP95Ms and on LoAF script time in hitTestForBoxUnsorted, with identical hit results on a recorded pointer path.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/HitTest/RectangleSeriesHitTestProvider.js:71` — always the unsorted O(N) helper; the sorted O(log N) call is commented out
- `esm/Charting/Visuals/RenderableSeries/HitTest/hitTestHelpersRectangleSeries.js:4` — testIsYHit reads y/y1 through vector.get()
- `esm/Charting/Visuals/RenderableSeries/HitTest/hitTestHelpersRectangleSeries.js:140` — polar: allocates a 2-element array and a forEach closure per element
- `esm/Charting/Visuals/RenderableSeries/HitTest/hitTestHelpersRectangleSeries.js:266` — vertical charts always take the O(N) scan, even for sorted data

## Review notes

- Found by reviewer slice `s05-labels-hittest-anim`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

