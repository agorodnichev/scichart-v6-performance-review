# 078 · Every 3D XYZ series rebuild walks all N metadata entries in JS, even when the series has no metadata and the result is 'all defaults'

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting3D/Visuals/Primitives/RenderableSeriesSceneEntity.js:91` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
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
@@ constructor(webAssemblyContext, options) {
         this.metadata = [];
+        /** @ignore true once any metadata may be non-undefined; only clear()/setMetadata(empty) reset it */
+        this.hasMetadata = false;
@@ append(x, y, z, metadata) {
             this.metadata.push(metadata);
+            if (metadata !== undefined) this.hasMetadata = true;
@@ appendRange(xValues, yValues, zValues, metadatas) {
             if (metadatas) {
+                this.hasMetadata = true;
@@ update(index, x, y, z, metadata) {
             this.metadata[index] = metadata;
+            if (metadata !== undefined) this.hasMetadata = true;
@@ insert(startIndex, x, y, z, metadata) {
             this.metadata.splice(startIndex, 0, metadata);
+            if (metadata !== undefined) this.hasMetadata = true;
@@ insertRange(startIndex, xValues, yValues, zValues, metadatas) {
             if (metadatas) {
+                this.hasMetadata = true;
@@ clear() {
             this.metadata = [];
+            this.hasMetadata = false;
@@ setMetadataAt(index, metadata) {
             this.metadata[index] = metadata;
+            if (metadata !== undefined) this.hasMetadata = true;
@@ setMetadata(metadatas) {
             this.metadata = metadatas ? [...metadatas] : [];
+            this.hasMetadata = this.metadata.length > 0;
--- a/esm/Charting3D/Visuals/Primitives/RenderableSeriesSceneEntity.js
+++ b/esm/Charting3D/Visuals/Primitives/RenderableSeriesSceneEntity.js
@@ rebuildPointMetadata(pointColors, pointScales, metadata, count, defaultColor) {
         var _a, _b, _c;
+        const ds = this.parentSeries.dataSeries;
+        if (ds && ds.hasMetadata === false) {
+            // no per-point colors or scales anywhere: the flags below make native use the defaults,
+            // so the vectors (sized by getOrCreateVector) need not be filled
+            return { hasDefaultColors: true, hasDefaultScales: true };
+        }
         // Assert vectors exist and have correct size
```

**Trade-off:** This relies on the native entity ignoring pointColors/pointScales when useDefaultColors/useDefaultScale are true, which the flags imply but the wasm source is not visible to confirm. getOrCreateVector only fills new slots on resize, so after metadata is removed the vectors may hold stale values that the flags then ignore. hasMetadata stays true after removeAt/removeRange (conservative). App code that writes into the array returned by getMetadataValues() in place, bypassing the setters, is no longer picked up while hasMetadata is false; it must call setMetadata/setMetadataAt. Check visually with metadata on and off.

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
- Adversarial verification (corrected): Re-read RenderableSeriesSceneEntity.js:78-106 (quote matches :91-98; primary :91 is the loop). Callers: ScatterPointsSceneEntity.js:119, PointLine3DSceneEntity.js:100, ColumnSceneEntity.js:88, each from updateSeries, which RenderableSeriesSceneEntity.Update :31-38 runs whenever state.validate() is false: data modified (RenderableSeriesSceneEntityState.js:71, set by BaseDataSeries3D.notifyDataChanged :83-84 from every XyzDataSeries3D mutator) or any visible-range/world-dimension change (:73-85, so autoRange Always while streaming changes it every frame). No guard skips the loop: getMetadataValues (XyzDataSeries3D.js:62-63) returns the live array, which appendRange without metadata only grows by setting length (:139-143), so every metadata[i] is a hole/undefined and the loop writes defaultColor/1.0 into all N slots and returns both flags true. A local node check with --allow-natives-syntax confirmed the length-grown array stays in fast holey mode (no dictionary transition), so the cost is the plain O(N) pass, not slower. Evidence H kept (its share next to the native UpdateMeshesVec is not visible), severity medium kept (per frame only while streaming or ranging, unmeasured). Fix corrected: the original only maintained the flag in append/update/insert/appendRange/insertRange/clear and missed the public setMetadataAt (:299-307) and setMetadata (:313-321), so an app that adds colors with setMetadata to a series created without metadata would have them ignored; both now update the flag, and the flag is initialized in the constructor so ds.hasMetadata === false holds from the start (UniformGrid series lack the field and keep the loop).

