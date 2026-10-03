# 019 · 3D autoRange Always rescans every XyzDataSeries3D point (min/max) on every rendered frame, including camera-only frames

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting3D/Visuals/Axis/AxisBase3D.js:481` |
| Severity | **high** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (also INP during orbit drag) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
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

The ranges of an XyzDataSeries3D change only when its data changes, but the getters recompute them from scratch on every read, and the 3D renderer reads them on every frame. During a pure camera orbit the data is constant, yet each frame pays three full passes over the data. The work is in wasm, so it runs on the main thread and is invisible as JS self time. The cost grows linearly with the point count and stays in every frame for as long as the chart is animating or being dragged. Grid data series already cache yRange (BaseGridDataSeries3D.js:31), so the uncached XYZ series is the gap. The scene entities do not re-upload data on such frames (RenderableSeriesSceneEntity.js:35 gates updateSeries on RenderableSeriesSceneEntityState.validate, :70-89), so these scans are the only O(N) CPU work left in an orbit frame.

**Scale where it matters:** XyzDataSeries3D scatter, point-line or column series with 100k to 1M points and EAutoRange.Always on 1 to 3 axes. Frames run on every orbit drag move, zoom or data append (60 to 120 Hz). That is one full O(N) native scan per axis per series per frame, on the NaN-aware path (the code comment says the SIMD path is not used), even when the data has not changed since the last frame. A frame that follows a data change still needs one scan per column; the saving comes on frames with no data change (orbit, zoom, animation), and on repeated reads within the same frame.

## Fix (library side)

```diff
--- a/esm/Charting3D/Model/DataSeries/XyzDataSeries3D.js
+++ b/esm/Charting3D/Model/DataSeries/XyzDataSeries3D.js
@@ -34,6 +34,10 @@
         this.yValues = new webAssemblyContext.SCRTDoubleVector();
         this.zValues = new webAssemblyContext.SCRTDoubleVector();
         this.metadata = [];
+        // Cached x/y/z min-max, cleared by notifyDataChanged(); every mutator in this class calls it
+        this.xRangeCache = undefined;
+        this.yRangeCache = undefined;
+        this.zRangeCache = undefined;
         if ((options === null || options === void 0 ? void 0 : options.xValues) && (options === null || options === void 0 ? void 0 : options.yValues) && (options === null || options === void 0 ? void 0 : options.zValues)) {
             this.appendRange(options.xValues, options.yValues, options.zValues, options === null || options === void 0 ? void 0 : options.metadata);
         }
@@ -66,28 +70,40 @@
      * @inheritDoc
      */
     get xRange() {
-        // Todo, an optimisation here is to know if containsNaN or not. When false, this will use SIMD calculations
-        const nativeRange = this.webAssemblyContext.NumberUtil.MinMax(this.xValues, true);
-        const tsRange = new NumberRange(nativeRange.minD, nativeRange.maxD);
-        nativeRange.delete();
-        return tsRange;
+        if (this.xRangeCache === undefined) {
+            this.xRangeCache = this.computeMinMax(this.xValues);
+        }
+        return this.xRangeCache;
     }
     /**
      * @inheritDoc
      */
     get yRange() {
-        // Todo, an optimisation here is to know if containsNaN or not. When false, this will use SIMD calculations
-        const nativeRange = this.webAssemblyContext.NumberUtil.MinMax(this.yValues, true);
-        const tsRange = new NumberRange(nativeRange.minD, nativeRange.maxD);
-        nativeRange.delete();
-        return tsRange;
+        if (this.yRangeCache === undefined) {
+            this.yRangeCache = this.computeMinMax(this.yValues);
+        }
+        return this.yRangeCache;
     }
     /**
      * @inheritDoc
      */
     get zRange() {
+        if (this.zRangeCache === undefined) {
+            this.zRangeCache = this.computeMinMax(this.zValues);
+        }
+        return this.zRangeCache;
+    }
+    /**
+     * @inheritDoc
+     */
+    notifyDataChanged() {
+        // Clear before raising dataChanged, so handlers that read a range see the new data
+        this.xRangeCache = this.yRangeCache = this.zRangeCache = undefined;
+        super.notifyDataChanged();
+    }
+    computeMinMax(values) {
         // Todo, an optimisation here is to know if containsNaN or not. When false, this will use SIMD calculations
-        const nativeRange = this.webAssemblyContext.NumberUtil.MinMax(this.zValues, true);
+        const nativeRange = this.webAssemblyContext.NumberUtil.MinMax(values, true);
         const tsRange = new NumberRange(nativeRange.minD, nativeRange.maxD);
         nativeRange.delete();
         return tsRange;
```

**Trade-off:** Code that writes into the native vectors directly (getNativeXValues().set) without calling notifyDataChanged() would get a stale range. Such code already gets no redraw today, so this changes nothing in practice. The cached NumberRange can become the axis visibleRange object (when growBy is unset), so NumberRange has to stay effectively immutable, which is how the library already uses it. The cache costs three small objects per series.

## App-side workaround

Use EAutoRange.Once or EAutoRange.Never on the 3D axes. Then set axis.visibleRange yourself after each data update, from a running min/max that you keep while appending.

## Verify

measure.md#fps, orbit-drag scenario for 5 s on a 3D scatter with a 1M-point XyzDataSeries3D, autoRange Always on all three axes and static data, 5 runs per side. Pass: compare-runs is 'win' on frameP95Ms, no regression on the other four metrics, and LoAF/trace-summary show no NumberUtil.MinMax (wasm) time in frames that had no appendRange.

## Other locations

- `esm/Charting3D/Model/DataSeries/XyzDataSeries3D.js:70` — xRange: NumberUtil.MinMax over all xValues on every call, uncached (also reported by slice s13-3d-series-modifiers)
- `esm/Charting3D/Model/DataSeries/XyzDataSeries3D.js:80` — yRange: same uncached full MinMax scan
- `esm/Charting3D/Model/DataSeries/XyzDataSeries3D.js:90` — zRange: same uncached full MinMax scan
- `esm/Charting3D/Visuals/SciChart3DRenderer.js:49` — shouldAutoRange is true on every frame for EAutoRange.Always, with no data-changed check
- `esm/Charting3D/Visuals/SciChart3DRenderer.js:116` — prepareAxes runs autorange for all three axes on every render
- `esm/Charting3D/Visuals/ViewportManager3DBase.js:41` — calculateAutoRange calls getMaximumRange on every call
- `esm/Charting3D/Visuals/Axis/LogarithmicAxis3D.js:163` — same per-frame getMaximumRangeAs path for log axes
- `esm/Charting3D/Visuals/Primitives/RenderableSeriesSceneEntity.js:35` — data re-upload is skipped when RenderableSeriesSceneEntityState.validate passes, so on camera-only frames the MinMax scans are the remaining O(N) CPU work
- `esm/Charting3D/Model/DataSeries/BaseGridDataSeries3D.js:31` — grid yRange already caches in yRangeCached and notifyDataChanged clears it (:137-141): the pattern to copy

## Review notes

- Found by reviewer slice `s12-pie-3d-surface`.
- Adversarial verification (corrected): Re-read AxisBase3D.js:442-492: the code_quote matches verbatim but starts at :481 (renderableSeries.asArray().forEach), not :483, so primary.line is now 481. Caller chain re-established with rg: OrbitModifier3D.modifierMouseMove (:53) -> performModifierAction -> camera.orbitalYaw += (:98) -> CameraController set orbitalYaw (:226) -> notifyPropertyChanged (:236) -> SciChart3DSurface.childPropertyChanged (:908, subscribed in set camera :440) -> invalidateElement (:569; coalesced by sciChart3DRenderer.isInvalidated, TSRRequestCanvasDraw :587) -> doDrawingLoop (:629) -> SciChart3DRenderer.render (:67) -> prepareAxes (:116, :179-185, all three axes) -> tryPerformAutoRangeOn (:48-52, shouldAutoRange is unconditionally true for EAutoRange.Always) -> ViewportManager3DBase.calculateAutoRange (:39-41; DefaultViewportManager3D does not override it) -> AxisBase3D.getMaximumRange (:442, call :459) -> getMaximumRangeAs (:481-487) -> XyzDataSeries3D.xRange/yRange/zRange (:68/:78/:88, MinMax(values, true) at :70/:80/:90) with no cache. LogarithmicAxis3D.getMaximumRange (:154, :163) takes the same path. Guards checked and none defeat the claim: no dirty flag or cache in XyzDataSeries3D or BaseDataSeries3D (BaseDataSeries3D.notifyDataChanged :83-86 only sets isModified and raises dataChanged). The AxisCore visibleRange setter (:333-343) has an equals() check, so the autorange does not cause an invalidate loop; the cost comes only from the scans. isModified cannot serve as the cache key because RenderableSeriesSceneEntityState.reset (:121) clears it every update. Mechanism on camera-only frames: RenderableSeriesSceneEntity.js:35 re-uploads series data only when RenderableSeriesSceneEntityState.validate (:70-89) sees the data modified or the axis cube changed, so on an orbit or animation frame the three wasm MinMax passes are the only O(N) CPU work left. Default autoRange is EAutoRange.Once (AxisCore.js:92), so the cost needs an explicit Always, as the scale field says. Fix: every XyzDataSeries3D mutator (append :112, appendRange :149, update :166, insert :192, insertRange :234, removeAt :255, removeRange :273, clear :290, setMetadataAt :305, setMetadata :319) calls notifyDataChanged. reserve/capacity do not change values. rg finds no library writes to getNative*Values() outside the class (XyzSeriesInfo3D and the scene entities only read). No code assigns NumberRange.min/max in place, so returning the cached object (it can become axis.visibleRange; tryPerformAutoRangeOn :53 then skips the assignment by identity) is safe. Corrections: (1) primary.line 483 -> 481 to match the quote start. (2) The fix_diff was pseudo-hunks with "(same ...)" placeholders, so it was replaced by a real unified diff generated against the file and checked with node --check; it initialises the three caches in the constructor (one object shape) and clears them before super.notifyDataChanged() so dataChanged handlers see fresh ranges. (3) other_locations: removed the duplicate XyzDataSeries3D:70 entry. The grid pointer was wrong (:135 is a JSDoc line and :241-245 is unrelated), so it now cites the yRangeCached cache at BaseGridDataSeries3D.js:31 and its clear in notifyDataChanged at :137-141. Added RenderableSeriesSceneEntity.js:35. (4) The why_it_costs and scale fields now state that frames with a data change still need one scan, so the saving comes on camera-only and animation frames. Severity high is kept: the cost is per rendered frame and per orbit pointermove (coalesced to one per frame), and grows with N. Evidence S is kept: the per-frame scan is certain on this path for EAutoRange.Always, and only its magnitude depends on N.
- Duplicate merged from slice `s13-3d-series-modifiers`: XyzDataSeries3D x/y/zRange are uncached full MinMax scans, re-run for every axis on every frame when autoRange is Always
