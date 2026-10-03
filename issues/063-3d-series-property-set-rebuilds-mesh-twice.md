# 063 · 3D point-line/scatter/column property setters rebuild the whole series synchronously, then the next frame rebuilds it again

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting3D/Visuals/Primitives/PointLine3DSceneEntity.js:60` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | INP (also frame time) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | DATA-06 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
    notifySeriesPropertyChanged(propertyName) {
        if (propertyName === PROPERTY.STROKE ||
            propertyName === PROPERTY.STROKE_THICKNESS ||
            propertyName === PROPERTY.STROKE_DASH_ARRAY ||
            propertyName === PROPERTY.IS_LINE_STRIP ||
            propertyName === PROPERTY.IS_ANTIALIASED ||
            propertyName === PROPERTY.POINT_MARKER3D ||
            propertyName.startsWith("pointMarker.")) {
            this.updateSeries();
        }
        super.notifySeriesPropertyChanged(propertyName);
```

## Call path and frequency

App sets series.stroke (esm/Charting3D/Visuals/RenderableSeries/BaseRenderableSeries3D.js:134-137) or pointMarker.size -> BaseRenderableSeries3D.notifyPropertyChanged (:312-317) / pointMarkerPropertyChanged (:329-331) -> PointLine3DSceneEntity.notifySeriesPropertyChanged (PointLine3DSceneEntity.js:52-60) -> updateSeries() synchronously (:73-105: rebuildPointMetadata over all N at :100, native UpdateMeshesVec at :104) -> super sets isRenderableSeriesPropertyChanged (RenderableSeriesSceneEntity.js:53-56) + invalidate -> next frame: RenderableSeriesSceneEntity.Update (:31-38) -> validate() false -> updateSeries() again -> reset. Per property set: 2 full rebuilds. k sets in one task: k+1. Column: updateSeries (ColumnSceneEntity.js:74-76) writes pointMarker3D.fill on every call -> BasePointMarker3D.fill setter notifies without an equality check (PointMarkers/BasePointMarker3D.js:59-61) -> series invalidate during the frame -> one extra rendered frame per column rebuild.

## Why it costs

updateSeries is the full data path: a JS loop over all N metadata entries plus the native mesh rebuild. Calling it inside the setter does that work once per property, synchronously in the caller's task (the input handler, for a UI control), and the state flag that the same notification sets makes the next frame do it again with fresher render-pass data. The synchronous results are overwritten before they reach the screen. For ColumnRenderableSeries3D with series.fill set, every rebuild also self-notifies through pointMarker.fill and requests one more full 3D frame.

**Scale where it matters:** Series with 100k+ points. App code that sets several style properties together (theme switch, a settings panel, or animating pointMarker.size) does k synchronous O(N) JS loops plus k native mesh rebuilds in the input task, then another in the next frame. Only the last result is ever drawn.

## Fix (library side)

```diff
--- a/esm/Charting3D/Visuals/Primitives/PointLine3DSceneEntity.js
+++ b/esm/Charting3D/Visuals/Primitives/PointLine3DSceneEntity.js
@@ notifySeriesPropertyChanged(propertyName) {
-        if (propertyName === PROPERTY.STROKE || ... || propertyName.startsWith("pointMarker.")) {
-            this.updateSeries();
-        }
+        // the state flag set by super makes the next frame's Update() call updateSeries() once
         super.notifySeriesPropertyChanged(propertyName);
--- a/esm/Charting3D/Visuals/Primitives/ScatterPointsSceneEntity.js
@@ -55,3 +55,0 @@
-        if (propertyName === PROPERTY.POINT_MARKER3D) {
-            this.updateSeries();
-        }
--- a/esm/Charting3D/Visuals/Primitives/ColumnSceneEntity.js
@@ notifySeriesPropertyChanged(propertyName) {
-        if (propertyName === PROPERTY.POINT_MARKER3D || propertyName === PROPERTY.USE_METADATA_COLORS || propertyName === PROPERTY.FILL) {
-            this.updateSeries();
-        }
-        else if (propertyName === PROPERTY.OPACITY) {
+        if (propertyName === PROPERTY.OPACITY) {
             this.nativeEntity.SetOpacity(this.parentSeries.opacity);
         }
-        else if (propertyName === PROPERTY.DATA_POINT_WIDTH_X || propertyName === PROPERTY.DATA_POINT_WIDTH_Z) {
-            this.updateSeries();
-        }
@@ updateSeries() {
-        if (this.parentSeries.fill) {
+        if (this.parentSeries.fill && pointMarker3D.fill !== this.parentSeries.fill) {
             pointMarker3D.fill = this.parentSeries.fill;
         }
```

**Trade-off:** Native mesh state now changes at the next frame instead of inside the setter. Nothing reads native mesh state between the setter and the frame except hitTest, which reads the selection buffer of the last drawn frame either way. When the series is not yet rendered, updateSeries already returns early (no currentRenderPassData), so construction-time behavior is unchanged.

## App-side workaround

Set style properties before the series is attached or before the first render (updateSeries returns early then), and avoid re-setting unchanged values. For ColumnRenderableSeries3D, set pointMarker.fill instead of series.fill to avoid the extra frame per rebuild.

## Verify

measure.md#inp: a button that sets stroke, strokeThickness and pointMarker.size on a 1M-point PointLineRenderableSeries3D, with an app counter wrapped around updateSeries, 5 runs per side. Pass: the counter reads 1 per click instead of 4, and the processingMs subpart is 'win' with the other two not worse. For columns: measure.md#fps idle check after one appendRange. Pass: one rendered frame, not two.

## Other locations

- `esm/Charting3D/Visuals/Primitives/ScatterPointsSceneEntity.js:56` — sync updateSeries on POINT_MARKER3D, then again in the next frame
- `esm/Charting3D/Visuals/Primitives/ColumnSceneEntity.js:47` — sync updateSeries for POINT_MARKER3D/USE_METADATA_COLORS/FILL/DATA_POINT_WIDTH_X/Z
- `esm/Charting3D/Visuals/Primitives/ColumnSceneEntity.js:75` — unconditional pointMarker3D.fill write self-notifies and requests an extra frame
- `esm/Charting3D/Visuals/Primitives/RenderableSeriesSceneEntity.js:36` — the frame-time rebuild that already covers the change

## Review notes

- Found by reviewer slice `s12-pie-3d-surface`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

