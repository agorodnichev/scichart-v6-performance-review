# 050 · Hover/selection flips (and idempotent marker/visibility sets) flag a full point-cloud geometry rebuild although no 3D entity renders them

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting3D/Visuals/RenderableSeries/BaseRenderableSeries3D.js:314` |
| Severity | **medium** |
| Pipeline stage | GPU upload (`gpu-upload`) |
| Metric | frame time on hover enter/leave and click selection (also INP for selection click) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/b673d6e7b69ab60d5205e218a617f308/): reproduced on WebGL and WebGPU ([source](../demos/050-hover-triggers-geometry-rebuild/)) |
| Rule | GPU-08, CNV-07 (web-performance skill) |
| Effort to fix | small |

## Code

```js
    notifyPropertyChanged(propertyName) {
        var _a;
        (_a = this.sceneEntityProperty) === null || _a === void 0 ? void 0 : _a.notifySeriesPropertyChanged(propertyName);
        if (this.invalidateParentCallback) {
            this.invalidateParentCallback();
        }
    }
```

## Call path and frequency

Per hover change: SeriesSelectionModifier3D.js:124-131 modifierMouseMove (or :133-139 per render) -> :219 s.isHovered = ... -> BaseRenderableSeries3D.js:212-218 -> :312-314 sceneEntity.notifySeriesPropertyChanged(HOVERED) -> ScatterPointsSceneEntity.js:53-58 -> RenderableSeriesSceneEntity.js:53-56 state.setRenderableSeriesPropertyChanged() -> next frame RenderableSeriesSceneEntity.js:35-37 Update: validate() false -> ScatterPointsSceneEntity.js:69-124 updateSeries (rebuildPointMetadata over count points, UpdateMeshesVec re-transforms and re-uploads all points). Same on click selection (SeriesSelectionModifier3D.js:180-183) for each series whose isSelected flips. grep over esm/Charting3D/Visuals/Primitives finds no use of isHovered/isSelected.

## Why it costs

A flag that changes nothing on screen forces the per-series geometry path: an O(n) JS loop over metadata, an O(n) wasm transform into world coordinates and a full vertex buffer re-upload, in the frame right after the pointer crosses a series edge.

**Scale where it matters:** Point clouds / point-line / column series of 100k-1M points with SeriesSelectionModifier3D (enableHover) or click selection; each hover enter/leave rebuilds 1-2 series, each click up to 2.

## Fix (library side)

```diff
--- a/esm/Charting3D/Visuals/RenderableSeries/BaseRenderableSeries3D.js
+++ b/esm/Charting3D/Visuals/RenderableSeries/BaseRenderableSeries3D.js
@@ import { PROPERTY } from "./Constants";
+// Series flags that no built-in 3D scene entity reads: they must not flag a geometry rebuild
+const NON_GEOMETRY_PROPERTIES = [PROPERTY.HOVERED, PROPERTY.IS_SELECTED, PROPERTY.SERIES_NAME];
@@ notifyPropertyChanged(propertyName) {
         var _a;
-        (_a = this.sceneEntityProperty) === null || _a === void 0 ? void 0 : _a.notifySeriesPropertyChanged(propertyName);
+        if (!NON_GEOMETRY_PROPERTIES.includes(propertyName)) {
+            (_a = this.sceneEntityProperty) === null || _a === void 0 ? void 0 : _a.notifySeriesPropertyChanged(propertyName);
+        }
         if (this.invalidateParentCallback) {
@@ set isVisible(isVisible) {
         var _a;
         const oldValue = this.isVisibleProperty;
+        if (oldValue === isVisible) {
+            return;
+        }
         this.isVisibleProperty = isVisible;
--- a/esm/Charting3D/Visuals/PointMarkers/BasePointMarker3D.js
+++ b/esm/Charting3D/Visuals/PointMarkers/BasePointMarker3D.js
@@ set fill(fill) {
+        if (this.fillProperty === fill) {
+            return;
+        }
         this.fillProperty = fill;
@@ set size(size) {
+        if (this.sizeProperty === size) {
+            return;
+        }
         this.sizeProperty = size;
```

**Trade-off:** A custom 3D scene entity that draws hover/selection state from notifySeriesPropertyChanged(HOVERED/IS_SELECTED) would need to read the series flags in Render() instead. The surface is still invalidated, so app restyling in onHoveredChanged/onSelectedChanged (which goes through stroke/opacity setters) keeps working. The OPACITY and double-rebuild cases live in the s12 scene-entity files.

## App-side workaround

Exclude large clouds from hover (excludedSeriesIds or enableHover: false), or subclass the series and override notifyPropertyChanged to skip forwarding HOVERED/IS_SELECTED to sceneEntity.

## Verify

measure.md#fps: one ScatterRenderableSeries3D with 1M points + SeriesSelectionModifier3D({ enableHover: true }); scenario = pointer sweeps on and off the cloud 10 times in 5 s. Pass: LoAF topScripts no longer show updateSeries/rebuildPointMetadata on hover flips, compare-runs 'win' on longFramesPer10s and frameP99Ms.

## Other locations

- `esm/Charting3D/Visuals/RenderableSeries/BaseRenderableSeries3D.js:217` — isHovered setter -> notifyPropertyChanged(PROPERTY.HOVERED)
- `esm/Charting3D/Visuals/RenderableSeries/BaseRenderableSeries3D.js:204` — isSelected setter -> notifyPropertyChanged(PROPERTY.IS_SELECTED)
- `esm/Charting3D/Visuals/RenderableSeries/BaseRenderableSeries3D.js:231` — isVisible setter notifies even when the value did not change
- `esm/Charting3D/Visuals/PointMarkers/BasePointMarker3D.js:60` — fill/size setters (also :73) have no equality guard; ColumnSceneEntity.updateSeries re-assigns pointMarker.fill on every update
- `esm/Charting3D/ChartModifiers/SeriesSelectionModifier3D.js:219` — hover flips isHovered on enter/leave; :180-183 click flips isSelected
- `esm/Charting3D/Visuals/Primitives/RenderableSeriesSceneEntity.js:55` — any property name sets the rebuild flag (s12 file); Scatter/PointLine/SurfaceMesh never read isHovered/isSelected
- `esm/Charting3D/Visuals/Primitives/ScatterPointsSceneEntity.js:119` — rebuild = O(n) rebuildPointMetadata JS loop + UpdateMeshesVec over all points (:123) (s12 file)
- `esm/Charting3D/Visuals/Primitives/ColumnSceneEntity.js:47` — FILL/POINT_MARKER3D/DATA_POINT_WIDTH run updateSeries immediately and are flagged again, so two full rebuilds; OPACITY also flagged although it is applied with SetOpacity (s12 file)

## Review notes

- Found by reviewer slice `s13-3d-series-modifiers`.
- Adversarial verification (corrected): Quote matches BaseRenderableSeries3D.js:312-318 (CRLF file; primary :314 is the forward line). Chain re-established: SeriesSelectionModifier3D.js:124-131 modifierMouseMove and :133-139 onParentSurfaceRendered -> :210-219 updateHoverState sets s.isHovered for every included series -> BaseRenderableSeries3D.js:212-218 (equality-guarded, so only enter/leave flips notify) -> :312-314 sceneEntity.notifySeriesPropertyChanged(HOVERED) -> ScatterPointsSceneEntity.js:53-58 (only POINT_MARKER3D handled) -> RenderableSeriesSceneEntity.js:53-56 state.setRenderableSeriesPropertyChanged() -> next engine Update RenderableSeriesSceneEntity.js:31-38: RenderableSeriesSceneEntityState.validate :86-89 returns false on that flag alone -> ScatterPointsSceneEntity.updateSeries :69-124 (rebuildPointMetadata O(count) loop at :119, UpdateMeshesVec over all points at :123). Click: :176-185 sets isSelected=false on all then true on the hit (:199-205 guard) -> up to 2 series flagged. PointLine3D (:52-63), Column (:43-56) and SurfaceMesh (:108-116, state validate :70-71) all fall through to the same super flag. rg over esm/Charting3D shows no scene entity reads isHovered/isSelected/seriesName (parentSeries.* reads listed: none of them). No guard defeats it: the flag is only cleared by reset() after a rebuild. BasePointMarker3D.js:59-62/:72-75 have no equality guard; ColumnSceneEntity.updateSeries :74-76 reassigns pointMarker.fill. isVisible setter :221-231 notifies unconditionally. Severity medium kept (per discrete hover enter/leave or click, not per pointer event), evidence S kept (flag -> full rebuild is certain on this path). Corrected: fix_diff drops PARENT_SURFACE from the skip list (not a hover/selection path, a one-time attach event, so excluding it only adds risk) and spells out the guards as blocks; rule adds CNV-07 (hover must not redraw the data layer).

