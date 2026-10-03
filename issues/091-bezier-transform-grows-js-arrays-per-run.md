# 091 · BezierRenderDataTransform (also inside SmoothStackedMountainRenderableSeries) builds each run's output in growable JS arrays, about 3 x visible points x interpolationPoints values, and drops them after the copy into wasm on every pan, zoom or data run

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/RenderDataTransforms/BezierRenderDataTransform.js:11` |
| Severity | **medium** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | frame time (GC) |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/57a1fddafb848c9e2c7a07db85542a5e/): reproduced on WebGL and WebGPU ([source](../demos/091-bezier-transform-growable-arrays/)) |
| Rule | V8-06 (web-performance skill) |
| Effort to fix | small |

## Code

```js
export const bezierTransform = (oldX, oldY, iStart, iEnd, interpolationPoints, curvature, y1Values) => {
    var _a, _b;
    const oldXSize = oldX.length;
    const newxValues = [];
    const newyValues = [];
    const newindexes = [];
```

## Call path and frequency

Two entry points. (1) App-attached transform: SciChartRenderer.js:354 rs.draw -> BaseRenderableSeries.draw (BaseRenderableSeries.js:623-624), when a BezierRenderDataTransform or XyyBezierRenderDataTransform is created with drawing providers. (2) Built in: SmoothStackedMountainRenderableSeries installs SmoothStackedRenderDataTransform (Xyy variant) in its constructor (SmoothStackedMountainRenderableSeries.js:38-41), and StackedXyCollection.draw runs it for each visible series (StackedXyCollection.js:183). Both reach BaseRenderDataTransform.runTransform (:31-41), which skips the work while requiresTransform is false and indexRange and resamplingHash are unchanged, and reruns on every pan or zoom frame that moves the visible index range and on every data change (onDataChange :58-60; StackedXyCollection.js:90-91, 109-110). -> runTransformInternal (BezierRenderDataTransform.js:126-144) -> bezierTransform (:8-80): three Array.push per output vertex (:54-56, :64-66) and easing.inOutCubic per vertex (:61); getPoint (:36) and getControlPoint (:14-31) allocate about three small objects per source point. appendDoubleVectorFromJsArray then copies the three arrays into the wasm vectors (:140-142; appendDoubleVectorFromJsArray.js:97 HEAPF64.set from a plain Array). The Xyy variant runs bezierTransform twice (:206, :209) and uses only newyValues1 from the first call. Rate: per pan or zoom frame and per data update; idle redraws skip it.

## Why it costs

The arrays grow by push, so V8 reallocates and copies their backing stores several times per run; at 100k doubles each backing store is well above the regular-object size limit and goes to large-object space. All of it becomes garbage right after HEAPF64.set copies it into wasm, and HEAPF64.set from a plain Array converts element by element instead of a typed-array copy. The output size is known before the loop, so exactly sized Float64Arrays (or reused scratch buffers) remove the regrowth and the per-element conversion. The eased t is the same for every segment and can be computed once per run, though that part is minor next to the two bezier evaluations per vertex.

**Scale where it matters:** Output per array = (iEnd - iStart) x interpolationPoints (default 20) + 1; three arrays per call, six for the Xyy and SmoothStacked variants (two of them unused). 5k visible points give about 100k values per array, 300k per run (600k for Xyy). When the series resamples, the input is the resampled count (:130-131) rather than all visible points, which caps the size.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/RenderDataTransforms/BezierRenderDataTransform.js
+++ b/esm/Charting/Visuals/RenderableSeries/RenderDataTransforms/BezierRenderDataTransform.js
@@ -8,9 +8,19 @@
-export const bezierTransform = (oldX, oldY, iStart, iEnd, interpolationPoints, curvature, y1Values) => {
+// Internal: same values as bezierTransform, written into exactly sized Float64Arrays
+const bezierTransformF64 = (oldX, oldY, iStart, iEnd, interpolationPoints, curvature, y1Values) => {
     var _a, _b;
     const oldXSize = oldX.length;
-    const newxValues = [];
-    const newyValues = [];
-    const newindexes = [];
+    // each segment emits max(1, ceil(interpolationPoints)) vertices, plus one closing vertex
+    const perSegment = Math.max(1, Math.ceil(interpolationPoints));
+    const outSize = Math.max(0, iEnd - iStart) * perSegment + 1;
+    const newxValues = new Float64Array(outSize);
+    const newyValues = new Float64Array(outSize);
+    const newindexes = new Float64Array(outSize);
+    // the eased t depends only on j, not on the segment: compute it once per run
+    const tByJ = new Float64Array(perSegment);
+    for (let j = 1; j < interpolationPoints; j++)
+        tByJ[j] = easing.inOutCubic(j / interpolationPoints);
@@ -53,28 +63,33 @@
     for (let i = iStart; i < iEnd; i++) {
-        newxValues.push(pCur.x);
-        newindexes.push(index);
-        newyValues.push(Math.min(pCur.y, getY1(index)));
+        // index counts the vertices written so far, so it is also the write position
+        newxValues[index] = pCur.x;
+        newindexes[index] = index;
+        newyValues[index] = Math.min(pCur.y, getY1(index));
         index++;
@@
         for (let j = 1; j < interpolationPoints; j++) {
-            const t = easing.inOutCubic(j / interpolationPoints);
+            const t = tByJ[j];
             const x = bezier(pCur.x, p2.xc, p3.xc, pNext.x, t);
             const y = bezier(pCur.y, p2.yc, p3.yc, pNext.y, t);
-            newxValues.push(x);
-            newyValues.push(Math.min(y, getY1(index)));
-            newindexes.push(index);
+            newxValues[index] = x;
+            newyValues[index] = Math.min(y, getY1(index));
+            newindexes[index] = index;
             index++;
         }
@@
-    newxValues.push(pNext.x);
-    newyValues.push(Math.min(pNext.y, getY1(index)));
-    newindexes.push(index);
+    newxValues[index] = pNext.x;
+    newyValues[index] = Math.min(pNext.y, getY1(index));
+    newindexes[index] = index;
     return { newxValues, newyValues, newindexes };
 };
+/** Public export keeps its typed signature (number[] arrays) */
+export const bezierTransform = (oldX, oldY, iStart, iEnd, interpolationPoints, curvature, y1Values) => {
+    const r = bezierTransformF64(oldX, oldY, iStart, iEnd, interpolationPoints, curvature, y1Values);
+    return { newxValues: Array.from(r.newxValues), newyValues: Array.from(r.newyValues), newindexes: Array.from(r.newindexes) };
+};
@@ -139 @@ class BezierRenderDataTransform { runTransformInternal(renderPassData) {
-        const { newxValues, newyValues, newindexes } = bezierTransform(vectorToArrayViewF64(oldX, this.wasmContext), vectorToArrayViewF64(oldY, this.wasmContext), iStart, iEnd, this.interpolationPoints, this.curvature);
+        const { newxValues, newyValues, newindexes } = bezierTransformF64(vectorToArrayViewF64(oldX, this.wasmContext), vectorToArrayViewF64(oldY, this.wasmContext), iStart, iEnd, this.interpolationPoints, this.curvature);
@@ -206,209 @@ class XyyBezierRenderDataTransform { runTransformInternal(renderPassData) {
-        const { newxValues: newxValues1, newyValues: newyValues1, newindexes: newindexes1 } = bezierTransform(vectorToArrayViewF64(oldX, this.wasmContext), vectorToArrayViewF64(oldY1, this.wasmContext), iStart, iEnd, this.interpolationPoints, this.curvature);
+        const { newxValues: newxValues1, newyValues: newyValues1, newindexes: newindexes1 } = bezierTransformF64(vectorToArrayViewF64(oldX, this.wasmContext), vectorToArrayViewF64(oldY1, this.wasmContext), iStart, iEnd, this.interpolationPoints, this.curvature);
@@
-        const { newxValues, newyValues, newindexes } = bezierTransform(vectorToArrayViewF64(oldX, this.wasmContext), vectorToArrayViewF64(oldY, this.wasmContext), iStart, iEnd, this.interpolationPoints, this.curvature, this.forceYGreaterThanY1 ? vectorToArrayViewF64(y1Values, this.wasmContext) : undefined);
+        const { newxValues, newyValues, newindexes } = bezierTransformF64(vectorToArrayViewF64(oldX, this.wasmContext), vectorToArrayViewF64(oldY, this.wasmContext), iStart, iEnd, this.interpolationPoints, this.curvature, this.forceYGreaterThanY1 ? vectorToArrayViewF64(y1Values, this.wasmContext) : undefined);
```

**Trade-off:** Output values are bit-identical (checked against the original over integer, non-integer and zero interpolationPoints, with and without y1Values). bezierTransform is a public export typed as returning number[] (types/.../BezierRenderDataTransform.d.ts:9-13), so the fix keeps it as a wrapper and only the internal callers use the Float64Array variant; the only visible difference through the wrapper is that a missing neighbour on a 1-point range comes back as NaN instead of undefined, which HEAPF64.set already turned into NaN. Typed arrays are still allocated per run; keeping them as fields on the transform and growing them by doubling would remove that too, at the cost of holding the largest buffer for the life of the series. Precomputing the four Bernstein weights per j would also remove four Math.pow calls per vertex with identical results.

## App-side workaround

Lower interpolationPoints, and use Bezier smoothing (or SmoothStackedMountainRenderableSeries) only on series with a modest number of visible points; for dense data, plain lines look the same because the source points are already under a pixel apart.

## Verify

measure.md#fps with the `pan` scenario on a FastLineRenderableSeries with a BezierRenderDataTransform and about 5k visible points, and again on a SmoothStackedMountain collection, 5 runs per side. Pass: "Minor GC" plus "Major GC" time per second in the trace-summary window goes down, and frameP95Ms is not worse.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/RenderDataTransforms/BezierRenderDataTransform.js:61` — easing recomputed for every interpolated vertex (minor)
- `esm/Charting/Visuals/RenderableSeries/RenderDataTransforms/BezierRenderDataTransform.js:206` — the Xyy variant runs the transform twice per run and uses only the y array of the first call
- `esm/Charting/Visuals/RenderableSeries/RenderDataTransforms/BezierRenderDataTransform.js:140` — copies the three plain arrays into wasm with HEAPF64.set
- `esm/Charting/Visuals/RenderableSeries/SmoothStackedMountainRenderableSeries.js:38` — built-in series that always installs SmoothStackedRenderDataTransform
- `esm/Charting/Visuals/RenderableSeries/StackedXyCollection.js:183` — runs the smooth-stacked transform for each visible series per draw
- `types/Charting/Visuals/RenderableSeries/RenderDataTransforms/BezierRenderDataTransform.d.ts:9` — public bezierTransform typed as returning number[]; keep that signature

## Review notes

- Found by reviewer slice `s04-drawing-providers`.
- Adversarial verification (corrected): Re-read BezierRenderDataTransform.js in full: code_quote matches lines 8-13 verbatim (CRLF file), primary line 11 is the first array declaration inside it. Call chain confirmed: SciChartRenderer.js:354 rs.draw -> BaseRenderableSeries.draw :623-624 (only when the transform lists that drawing provider) -> BaseRenderDataTransform.runTransform :31-41 -> BezierRenderDataTransform.runTransformInternal :126-144 -> bezierTransform :8-80 -> appendDoubleVectorFromJsArray :140-142 (appendDoubleVectorFromJsArray.js:97 HEAPF64.set). Second, built-in path the original missed: SmoothStackedMountainRenderableSeries.js:38-41 installs SmoothStackedRenderDataTransform (the Xyy variant) with no drawing providers, and StackedXyCollection.draw runs it per visible series at StackedXyCollection.js:183, with a fresh getIndicesRange per draw. So the cost is not only for opt-in transforms. Guard check: runTransform :31-33 skips the work while requiresTransform is false and indexRange/resamplingHash are unchanged, so idle redraws (cursor, rollover) do not rerun it; a pan or zoom frame that moves the index range, and any data change (onDataChange :58-60; StackedXyCollection.js:90-91, 109-110), do. useForYRange is false by default, so the y-range path (BaseRenderableSeries.js:694-695) does not add runs. When the input is resampled, iStart=0 and iEnd=resampled count-1 (:130-131), which caps the input size. Output count per run is exactly (iEnd-iStart)*max(1, ceil(interpolationPoints))+1; the Xyy variant calls bezierTransform twice (:206, :209) and uses only newyValues1 from the first call, so 2 of its 6 arrays are built and dropped unused. Corrections: (1) the original fix sized the arrays as (iEnd-iStart)*interpolationPoints+1, which throws RangeError for a non-integer interpolationPoints (new Float64Array(6.5)) and truncates output for interpolationPoints=0; replaced with max(1, ceil(ip)) per segment and verified bit-identical to the original over 216 cases (N 1..200, ip 0/1/2/2.5/3/20, with and without y1Values, NaN y) in a scratch harness. Also dropped the extra counter: index already equals the write position. (2) bezierTransform is a public export (esm/index.js:709, types/index.d.ts:1052) typed as returning number[]; the original trade-off "none in behaviour" was wrong, so the fix keeps the export as a wrapper and moves the internal callers to a typed-array variant. (3) Rule: SC-24 is satisfied (the transform reuses this.pointSeries and clears it) and V8-07 is about storing new objects in long-lived containers, which does not happen; the fitting rule is V8-06 (allocate large scratch columns once). (4) Severity low -> medium: per pan/zoom frame and per data update on an opt-in transform or the SmoothStackedMountain series, V8-06 impact medium; not high because the arrays die young and the cost depends on visible points x interpolationPoints. (5) The easing recompute is a few multiplies per vertex, minor next to the two bezier evaluations with four Math.pow; title de-emphasizes it.

