# 091 · BezierRenderDataTransform builds its output in growable JS arrays (20 values per source point) and recomputes the easing for every segment on each pan, zoom or data run

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/RenderDataTransforms/BezierRenderDataTransform.js:11` |
| Severity | **low** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | frame time (GC) |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | V8-06, V8-07, SC-24 (web-performance skill) |
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

SciChartRenderer.js:354 -> BaseRenderableSeries.js:624, when an app attaches a BezierRenderDataTransform or XyyBezierRenderDataTransform with drawing providers -> BaseRenderDataTransform.runTransform (:31-41), which reruns whenever indexRange changes, so on every pan frame -> BezierRenderDataTransform.runTransformInternal (:126) -> bezierTransform (:8-80). Per output vertex it does an Array.push for x, y and index. getPoint (:36) and getControlPoint (:14-31) return new objects per point, and easing.inOutCubic runs per vertex (:61). appendDoubleVectorFromJsArray then copies the 3 arrays (:140-142). The Xyy variant runs bezierTransform twice (:206, :209). Rate: per pan or zoom frame and per data update.

## Why it costs

Growable JS arrays reallocate and copy as they grow, and they become garbage right after the copy into wasm. The easing values are identical for every segment. The output size is known up front ((iEnd - iStart) x interpolationPoints + 1), so the arrays could be preallocated, or written straight into the resized wasm vectors through views.

**Scale where it matters:** Visible points x interpolationPoints (default 20) x 3 arrays per run. 5k visible points means about 300k array elements built and discarded per pan frame.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/RenderDataTransforms/BezierRenderDataTransform.js
+++ b/esm/Charting/Visuals/RenderableSeries/RenderDataTransforms/BezierRenderDataTransform.js
@@ export const bezierTransform = (...) => {
-    const newxValues = [];
-    const newyValues = [];
-    const newindexes = [];
+    const outSize = Math.max(0, iEnd - iStart) * interpolationPoints + 1;
+    const newxValues = new Float64Array(outSize);
+    const newyValues = new Float64Array(outSize);
+    const newindexes = new Float64Array(outSize);
+    let o = 0;
+    // the easing is the same for every segment: compute it once per run
+    const tWeights = new Float64Array(interpolationPoints);
+    for (let j = 1; j < interpolationPoints; j++)
+        tWeights[j] = easing.inOutCubic(j / interpolationPoints);
@@
-        newxValues.push(pCur.x);
-        newindexes.push(index);
-        newyValues.push(Math.min(pCur.y, getY1(index)));
+        newxValues[o] = pCur.x;
+        newindexes[o] = index;
+        newyValues[o] = Math.min(pCur.y, getY1(index));
+        o++;
@@
-            const t = easing.inOutCubic(j / interpolationPoints);
+            const t = tWeights[j];
@@ (inner and final pushes likewise: write at o, then o++)
```

**Trade-off:** None in behaviour: appendDoubleVectorFromJsArray accepts typed arrays (it uses .length and HEAPF64.set). Keeping scratch buffers across runs would also remove the per-run allocation, at the cost of holding the largest buffer.

## App-side workaround

Lower interpolationPoints, and apply the transform only to series with a modest number of visible points.

## Verify

measure.md#fps, `pan` on a FastLineRenderableSeries with a BezierRenderDataTransform and 5k visible points, 5 runs per side. Pass: 'Minor GC' time per second in the trace-summary window goes down, and frameP95Ms is not worse.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/RenderDataTransforms/BezierRenderDataTransform.js:61` — easing recomputed for every interpolated vertex
- `esm/Charting/Visuals/RenderableSeries/RenderDataTransforms/BezierRenderDataTransform.js:206` — the Xyy variant runs the transform twice per run

## Review notes

- Found by reviewer slice `s04-drawing-providers`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

