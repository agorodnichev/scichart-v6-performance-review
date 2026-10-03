# 078 · Every 3D XYZ series rebuild walks all N metadata entries in JS, even when the series has no metadata and the result is 'all defaults'

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting3D/Visuals/Primitives/RenderableSeriesSceneEntity.js:91` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | V8-01 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
        for (let i = 0; i < count; i++) {
            const meta = metadata[i];
            // Use conditional operators for maximum performance - JIT optimised
            const vertexColor = (_b = (_a = meta === null || meta === void 0 ? void 0 : meta.vertexColor) !== null && _a !== void 0 ? _a : meta === null || meta === void 0 ? void 0 : meta.vertexColorAbgr) !== null && _b !== void 0 ? _b : defaultColor;
            const pointScale = (_c = meta === null || meta === void 0 ? void 0 : meta.pointScale) !== null && _c !== void 0 ? _c : 1.0;
            // Direct assignment to WebAssembly memory views
            colorsView[i] = vertexColor;
            scalesView[i] = pointScale;
```

## Call path and frequency

XyzDataSeries3D.appendRange -> notifyDataChanged -> invalidate -> next frame native Update -> RenderableSeriesSceneEntity.Update (RenderableSeriesSceneEntity.js:31-38) -> state.validate false (isDataSeriesModified, or any axis visibleMin/Max change per RenderableSeriesSceneEntityState.js:73-85) -> ScatterPointsSceneEntity.updateSeries (ScatterPointsSceneEntity.js:69-123) -> rebuildPointMetadata (:119 -> RenderableSeriesSceneEntity.js:78-106) over all count points, then sceneEntityParams.useDefaultColors/useDefaultScale = true when nothing differed. Same for PointLine3DSceneEntity.js:100 and ColumnSceneEntity.js:88. Frequency: once per frame while data streams, or while an axis range animates.

## Why it costs

When no metadata was ever supplied, metadata[i] is undefined for every i. The loop then writes the default color and scale into all N slots and reports hasDefaultColors/hasDefaultScales = true, which makes the native side use the defaults. The whole pass produces a result that a flag on the data series could provide in O(1), yet it runs on every rebuild, including rebuilds caused only by an axis visible-range change where no point's color or scale changed. The cost relative to the native UpdateMeshesVec cannot be judged statically (H).

**Scale where it matters:** Streaming 3D point clouds of 100k to 1M points with appendRange every frame and no per-point metadata (the common case). The loop costs N iterations of reads and two typed-array writes per frame, on top of the native mesh rebuild.

## Fix (library side)

```diff
--- a/esm/Charting3D/Model/DataSeries/XyzDataSeries3D.js
+++ b/esm/Charting3D/Model/DataSeries/XyzDataSeries3D.js
+    // true once any non-undefined metadata was stored; clear() resets it
+    //   append/update/insert:  if (metadata !== undefined) this.hasMetadata = true;
+    //   appendRange/insertRange: if (metadatas) this.hasMetadata = true;
+    //   clear():                this.hasMetadata = false;
--- a/esm/Charting3D/Visuals/Primitives/RenderableSeriesSceneEntity.js
+++ b/esm/Charting3D/Visuals/Primitives/RenderableSeriesSceneEntity.js
@@ rebuildPointMetadata(pointColors, pointScales, metadata, count, defaultColor) {
+        const ds = this.parentSeries.dataSeries;
+        if (ds && ds.hasMetadata === false) {
+            // no per-point colors or scales anywhere: native uses the defaults
+            return { hasDefaultColors: true, hasDefaultScales: true };
+        }
         var _a, _b, _c;
```

**Trade-off:** This relies on the native entity ignoring pointColors/pointScales when useDefaultColors/useDefaultScale are true, which the flags imply but the wasm source is not visible to confirm. After metadata is removed, the vectors may hold stale values that the flags then ignore. hasMetadata stays true after removeRange (conservative). Check visually with metadata on and off.

## App-side workaround

None from app code: the loop runs inside the library on every rebuild. Keeping N per series smaller is the only lever.

## Verify

measure.md#fps, stream scenario: a 500k-point ScatterRenderableSeries3D with one appendRange of 1k points per frame and no metadata, 5 runs per side. Pass: rebuildPointMetadata disappears from __wpProbe.loaf.read() topScripts, compare-runs is 'win' or 'neutral' on frameP95Ms with no regression, and the rendered colors and sizes are unchanged in a screenshot diff.

## Other locations

- `esm/Charting3D/Visuals/Primitives/ScatterPointsSceneEntity.js:119` — caller
- `esm/Charting3D/Visuals/Primitives/PointLine3DSceneEntity.js:100` — caller
- `esm/Charting3D/Visuals/Primitives/ColumnSceneEntity.js:88` — caller
- `esm/Charting3D/Visuals/Primitives/RenderableSeriesSceneEntityState.js:73` — an axis-range-only change also forces the full rebuild including this loop

## Review notes

- Found by reviewer slice `s12-pie-3d-surface`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

