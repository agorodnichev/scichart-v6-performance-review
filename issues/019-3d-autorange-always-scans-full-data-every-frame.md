# 019 · 3D autoRange Always rescans every XyzDataSeries3D point (min/max) on every rendered frame, including camera-only frames

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting3D/Visuals/Axis/AxisBase3D.js:483` |
| Severity | **high** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (also INP during orbit drag) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | V8-01, SC-43 (web-performance skill) |
| Effort to fix | small |

## Code

```js
        renderableSeries.asArray().forEach(r => {
            if (r.isVisible && r.dataSeries) {
                const range = whichAxis === EWhichAxis.xAxis
                    ? r.dataSeries.xRange
                    : whichAxis === EWhichAxis.yAxis
                        ? r.dataSeries.yRange
                        : r.dataSeries.zRange;
```

## Call path and frequency

OrbitModifier3D.modifierMouseMove (esm/Charting3D/ChartModifiers/OrbitModifier3D.js:53 -> :98 camera.orbitalYaw) or any data append -> CameraController.js:226-236 notify -> SciChart3DSurface.childPropertyChanged (SciChart3DSurface.js:908) -> invalidateElement (:569, TSRRequestCanvasDraw) -> engine rAF drawFrame -> SciChart3DSurface.doDrawingLoop (:629) -> SciChart3DRenderer.render (SciChart3DRenderer.js:67) -> prepareAxes (:116, :179-185) -> tryPerformAutoRangeOn (:48-52, true on every frame when autoRange === EAutoRange.Always) -> ViewportManager3DBase.calculateAutoRange (ViewportManager3DBase.js:41) -> AxisBase3D.getMaximumRange (AxisBase3D.js:459) -> getMaximumRangeAs (:483-487) -> XyzDataSeries3D.xRange/yRange/zRange (esm/Charting3D/Model/DataSeries/XyzDataSeries3D.js:70/80/90) -> NumberUtil.MinMax(values, true) over all N values. Frequency: once per rendered frame, per axis with Always, per visible series.

## Why it costs

The ranges of an XyzDataSeries3D change only when its data changes, but the getters recompute them from scratch on every read, and the 3D renderer reads them on every frame. During a pure camera orbit the data is constant, yet each frame pays three full passes over the data. The work is in wasm, so it runs on the main thread and is invisible as JS self time. The cost grows linearly with the point count and stays in every frame for as long as the chart is animating or being dragged. Grid data series already cache yRange (BaseGridDataSeries3D.js:31), so the uncached XYZ series is the gap.

**Scale where it matters:** XyzDataSeries3D scatter, point-line or column series with 100k to 1M points and EAutoRange.Always on 1 to 3 axes. Frames run on every orbit drag move, zoom or data append (60 to 120 Hz). That is one full O(N) native scan per axis per series per frame, on the NaN-aware path (the code comment says the SIMD path is not used), even when the data has not changed since the last frame.

## Fix (library side)

```diff
--- a/esm/Charting3D/Model/DataSeries/XyzDataSeries3D.js
+++ b/esm/Charting3D/Model/DataSeries/XyzDataSeries3D.js
@@ get xRange() {
-        const nativeRange = this.webAssemblyContext.NumberUtil.MinMax(this.xValues, true);
-        const tsRange = new NumberRange(nativeRange.minD, nativeRange.maxD);
-        nativeRange.delete();
-        return tsRange;
+        // cached until the next notifyDataChanged(); every mutator in this class calls it
+        return this.xRangeCache !== undefined ? this.xRangeCache : (this.xRangeCache = this.computeMinMax(this.xValues));
     }
@@ get yRange() {  (same, yRangeCache / this.yValues)
@@ get zRange() {  (same, zRangeCache / this.zValues)
+    computeMinMax(values) {
+        const nativeRange = this.webAssemblyContext.NumberUtil.MinMax(values, true);
+        const tsRange = new NumberRange(nativeRange.minD, nativeRange.maxD);
+        nativeRange.delete();
+        return tsRange;
+    }
+    notifyDataChanged() {
+        this.xRangeCache = this.yRangeCache = this.zRangeCache = undefined;
+        super.notifyDataChanged();
+    }
```

**Trade-off:** Code that writes into the native vectors directly (getNativeXValues().set) without calling notifyDataChanged() would get a stale range. Such code already gets no redraw today, so this changes nothing in practice. The cached NumberRange can become the axis visibleRange object (when growBy is unset), so NumberRange has to stay effectively immutable, which is how the library already uses it. The cache costs three small objects per series.

## App-side workaround

Use EAutoRange.Once or EAutoRange.Never on the 3D axes. Then set axis.visibleRange yourself after each data update, from a running min/max that you keep while appending.

## Verify

measure.md#fps, orbit-drag scenario for 5 s on a 3D scatter with a 1M-point XyzDataSeries3D, autoRange Always on all three axes and static data, 5 runs per side. Pass: compare-runs is 'win' on frameP95Ms, no regression on the other four metrics, and LoAF/trace-summary show no NumberUtil.MinMax (wasm) time in frames that had no appendRange.

## Other locations

- `esm/Charting3D/Model/DataSeries/XyzDataSeries3D.js:70` — xRange: NumberUtil.MinMax over all xValues on every call, uncached (same at :80 yRange and :90 zRange)
- `esm/Charting3D/Visuals/SciChart3DRenderer.js:49` — shouldAutoRange is true on every frame for EAutoRange.Always, with no data-changed check
- `esm/Charting3D/Visuals/SciChart3DRenderer.js:116` — prepareAxes runs autorange for all three axes on every render
- `esm/Charting3D/Visuals/ViewportManager3DBase.js:41` — calculateAutoRange calls getMaximumRange on every call
- `esm/Charting3D/Visuals/Axis/LogarithmicAxis3D.js:163` — same per-frame getMaximumRangeAs path for log axes
- `esm/Charting3D/Model/DataSeries/XyzDataSeries3D.js:70` — same root cause, also reported by slice s13-3d-series-modifiers: XyzDataSeries3D x/y/zRange are uncached full MinMax scans, re-run for every axis on every frame when autoRange is Always
- `esm/Charting3D/Model/DataSeries/XyzDataSeries3D.js:80` — yRange
- `esm/Charting3D/Model/DataSeries/XyzDataSeries3D.js:90` — zRange
- `esm/Charting3D/Model/DataSeries/BaseGridDataSeries3D.js:135` — grid yRange already caches and clears the cache in notifyDataChanged (:241-245): the pattern to copy

## Review notes

- Found by reviewer slice `s12-pie-3d-surface`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.
- Duplicate merged from slice `s13-3d-series-modifiers`: XyzDataSeries3D x/y/zRange are uncached full MinMax scans, re-run for every axis on every frame when autoRange is Always
