# 048 · AxisCubeEntity pushes all three axis descriptors (ticks, labels, styles) into wasm on every frame, even when they compare equal

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting3D/Visuals/Axis/AxisCubeEntity.js:74` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | V8-07 (web-performance skill) |
| Effort to fix | small |

## Code

```js
        const xScrtAxisDesc = scrtAxisCubeDescriptor.GetXAxisDescPtr();
        const yScrtAxisDesc = scrtAxisCubeDescriptor.GetYAxisDescPtr();
        const zScrtAxisDesc = scrtAxisCubeDescriptor.GetZAxisDescPtr();
        const descriptorsMapping = [
            [xScrtAxisDesc, xAxisDescriptor],
            [yScrtAxisDesc, yAxisDescriptor],
            [zScrtAxisDesc, zAxisDescriptor]
        ];
        descriptorsMapping.forEach(el => {
            updateScrtAxisDescriptor(this.webAssemblyContext, el[0], el[1]);
        });
```

## Call path and frequency

Every rendered 3D frame (orbit drag, zoom, streaming data): SciChart3DSurface.doDrawingLoop (esm/Charting3D/Visuals/SciChart3DSurface.js:629 -> :639) -> SciChart3DRenderer.render (SciChart3DRenderer.js:67) -> prepareRenderData (:118) -> getSceneDescriptor (:40, :25-27) -> AxisBase3D.toAxisDescriptor x3 (AxisBase3D.js:376: getTickCoordsAndLabels :380/:531-545, formatLabel per major tick :515, 7 parseColorToTArgb + 2 parseColorToUIntAbgr regex parses per axis :390-425/:580-595) -> rootEntity.visitEntities(setRenderPassData) (:121) -> native scene calls AxisCubeEntity.Update (AxisCubeEntity.js:32) -> getDescriptorsEqual x3 (:55-57) -> updateScrtAxisDescriptor x3 (:74-76 -> :149-194). Frequency: once per rendered frame per 3D surface.

## Why it costs

The code already deep-compares each new descriptor with the last one, and uses the result only to decide DestroyMeshes(). The full push into the native descriptors (which persist between frames, since they are reached by pointer through GetXAxisDescPtr) happens anyway. During a camera orbit the ticks, labels and styles do not change, so every frame repeats hundreds of JS-to-wasm boundary crossings, allocates and frees native vectors, and marshals label strings, all to write the same values. The descriptor itself is also rebuilt on every frame (tick generation, label formatting, regex color parsing), and its arrays and objects become garbage one frame later. A bug in getTextStylesEqual compares a.multilineSpacing with itself, so a change to that value alone is never detected.

**Scale where it matters:** 3 axes, with about 10 major ticks, about 40 minor ticks and about 10 labels per axis by default. Each axis costs about 85 fixed embind calls plus one push_back per major tick, minor tick and label (about 145 per axis, about 435 per frame), plus new/delete of SCRTTextStyle, FloatVector x2 and WStringVector, and about 30 JS-to-wasm UTF-32 string conversions. This repeats on every frame of a camera orbit, and on every surface on the page.

## Fix (library side)

```diff
--- a/esm/Charting3D/Visuals/Axis/AxisCubeEntity.js
+++ b/esm/Charting3D/Visuals/Axis/AxisCubeEntity.js
@@ Update(deltaTime) {
-        if (!getDescriptorsEqual(xAxisDescriptor, this.lastXDescriptor) ||
-            !getDescriptorsEqual(yAxisDescriptor, this.lastYDescriptor) ||
-            !getDescriptorsEqual(zAxisDescriptor, this.lastZDescriptor)) {
+        const xChanged = !getDescriptorsEqual(xAxisDescriptor, this.lastXDescriptor);
+        const yChanged = !getDescriptorsEqual(yAxisDescriptor, this.lastYDescriptor);
+        const zChanged = !getDescriptorsEqual(zAxisDescriptor, this.lastZDescriptor);
+        if (xChanged || yChanged || zChanged) {
             scrtAxisCubeEntity.DestroyMeshes();
         }
@@
-        const xScrtAxisDesc = scrtAxisCubeDescriptor.GetXAxisDescPtr();
-        const yScrtAxisDesc = scrtAxisCubeDescriptor.GetYAxisDescPtr();
-        const zScrtAxisDesc = scrtAxisCubeDescriptor.GetZAxisDescPtr();
-        const descriptorsMapping = [ ... ];
-        descriptorsMapping.forEach(el => {
-            updateScrtAxisDescriptor(this.webAssemblyContext, el[0], el[1]);
-        });
+        // native descriptors persist between frames: push only the axes that changed
+        if (xChanged) updateScrtAxisDescriptor(this.webAssemblyContext, scrtAxisCubeDescriptor.GetXAxisDescPtr(), xAxisDescriptor);
+        if (yChanged) updateScrtAxisDescriptor(this.webAssemblyContext, scrtAxisCubeDescriptor.GetYAxisDescPtr(), yAxisDescriptor);
+        if (zChanged) updateScrtAxisDescriptor(this.webAssemblyContext, scrtAxisCubeDescriptor.GetZAxisDescPtr(), zAxisDescriptor);
--- a/esm/Charting3D/Visuals/Axis/IAxisDescriptor.js
+++ b/esm/Charting3D/Visuals/Axis/IAxisDescriptor.js
@@ -76 +76 @@
-        a.multilineSpacing === a.multilineSpacing);
+        a.multilineSpacing === b.multilineSpacing);
```

**Trade-off:** This assumes the native SCRTAxisDescriptor keeps its last values between frames. It is a persistent member reached by pointer, and DestroyMeshes only destroys meshes, but the C++ side is not visible here, so confirm with the axis-cube visual tests (buildAxisCubeSpec). The equality fix is required, or multilineSpacing-only changes would stop reaching wasm. The descriptor is still built in JS on every frame. A further step would cache toAxisDescriptor() per axis, keyed on visibleRange, axisSize and a property-change counter.

## App-side workaround

Only the volume can be reduced. Set drawMinorTickLines/drawMinorGridLines to false (fewer minor coordinates) and lower maxAutoTicks. The per-frame push itself cannot be avoided from app code.

## Verify

measure.md#fps, orbit-drag scenario for 5 s on a default 3D surface with three NumericAxis3D, 5 runs per side, with an app counter wrapped around updateScrtAxisDescriptor. Pass: the counter stays at 0 during orbit frames (3 only when a range or style changes), compare-runs is 'win' or 'neutral' on frameP95Ms with no regression, and an axis-cube screenshot diff shows no change.

## Other locations

- `esm/Charting3D/Visuals/Axis/AxisBase3D.js:376` — toAxisDescriptor runs per frame per axis: ticks, label formatting (:515) and 9 regex color parses
- `esm/Charting3D/Visuals/SciChart3DRenderer.js:118` — prepareRenderData allocates RenderPassInfo3D, SceneDescriptor and 3 descriptors per frame
- `esm/Charting3D/Visuals/Axis/AxisCubeEntity.js:182` — FloatVector/WStringVector created, filled with one push_back per element, and deleted per axis per frame
- `esm/Charting3D/Visuals/Axis/IAxisDescriptor.js:76` — getTextStylesEqual compares a.multilineSpacing with itself
- `esm/Charting3D/Visuals/Primitives/SurfaceMeshSceneEntity.js:158` — same pattern per frame per mesh series: new SCRTGridDrawingProperties, 2 regex color parses, 6 SCRTAxisRange alloc/delete, even when nothing changed
- `esm/Charting3D/Visuals/Primitives/CrosshairLinesSceneEntity.js:44` — same pattern: a new native SCRTLinesMesh per rendered frame while the crosshair is visible

## Review notes

- Found by reviewer slice `s12-pie-3d-surface`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

