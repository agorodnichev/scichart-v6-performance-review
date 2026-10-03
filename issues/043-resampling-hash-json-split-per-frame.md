# 043 · Resampling hash per frame per series: JSON.stringify of the params, then a one-string-per-character array and a reduce callback per character

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/utils/hash.js:2` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (GC pressure) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | V8-10, V8-06 (web-performance skill) |
| Effort to fix | small |

## Code

```js
const generateHash = (s) => s.split("").reduce((a, b) => {
    a = (a << 5) - a + b.charCodeAt(0);
    return a & a;
}, 0);
const generateObjectHash = (obj) => {
    const str = JSON.stringify(obj);
    return generateHash(str);
};
```

## Call path and frequency

Every render: SciChartRenderer.prepareSeriesRenderData (esm/Charting/Services/SciChartRenderer.js:639) -> ExtremeResamplerHelper.resampleSeries (esm/Charting/Numerics/Resamplers/ExtremeResamplerHelper.js:31-43; rp is rebuilt every frame because BaseRenderableSeries.draw clears resamplingParams at BaseRenderableSeries.js:662) -> calculateResamplingHash (ExtremeResamplerHelper.js:73-89) -> generateHash(dataSeries.id) + 2x generateNumberHash + generateBooleanHash + generateObjectHash(rp) (hash.js:2-9). Or via the Y auto-range path BaseRenderableSeries.getResampledPointSeries (BaseRenderableSeries.js:716). Once per frame per series that needs resampling.

## Why it costs

split("") allocates an array with one entry per UTF-16 unit and reduce calls a closure for each, only to fold the characters into an int; JSON.stringify(rp) produces a fresh string from an object graph that contains class instances (ResamplingParams, two NumberRange), which V8-10 says keeps the call off the fast serializer. All of it is young garbage created every frame for every resampled series.

**Scale where it matters:** Every FIFO series (dataIsFifo forces resampling) and every series with more points than the viewport needs, every frame; a typical rp serializes to about 370 characters, so roughly 450 array entries and 450 callback calls per series per frame. Matters on surfaces with tens to hundreds of streaming series.

## Fix (library side)

```diff
--- a/esm/utils/hash.js
+++ b/esm/utils/hash.js
@@ -1,5 +1,9 @@
 // https://stackoverflow.com/questions/7616461/generate-a-hash-from-string-in-javascript
-const generateHash = (s) => s.split("").reduce((a, b) => {
-    a = (a << 5) - a + b.charCodeAt(0);
-    return a & a;
-}, 0);
+// Same values as the split/reduce version, without a per-character array and callback
+const generateHash = (s) => {
+    let a = 0;
+    for (let i = 0; i < s.length; i++) {
+        a = ((a << 5) - a + s.charCodeAt(i)) | 0;
+    }
+    return a;
+};
```

**Trade-off:** Hash values are identical (checked over 20k random strings in a scratch script, including non-ASCII). The whole-object JSON.stringify(rp) key stays on purpose: TableDataSeries.js:513-518 records that hand-listed fields caused stale resampling caches, so one ~370-char string per resampled series per frame remains.

## App-side workaround

none (internal); fewer resampled series per surface reduces it.

## Verify

measure.md#fps, stream scenario with 50 FIFO series on one surface (each resampled every frame), 10 s, 5 runs per side. Pass: 'Minor GC' time per second in the trace-summary window goes down, frameP95Ms is 'win' or neutral, and calculateResamplingHash/generateHash time in LoAF topScripts drops.

## Other locations

- `esm/Charting/Numerics/Resamplers/ExtremeResamplerHelper.js:73` — calculateResamplingHash, per frame per resampled series
- `esm/Charting/Visuals/RenderableSeries/BaseRenderableSeries.js:716` — Y auto-range path computes the same hash
- `esm/Charting/Model/TableDataSeries.js:519` — generateObjectHash(rp) per toPointSeries
- `esm/Charting/Numerics/Resamplers/ExtremeResamplerHelper.js:86` — same root cause, also reported by slice x2-data-and-lifecycle: Resampling cache key is rebuilt per resampled series per frame with JSON.stringify and String.split("")
- `esm/utils/hash.js:2` — generateHash = s.split("").reduce(...); generateObjectHash = generateHash(JSON.stringify(obj)); generateNumberHash = toString + split
- `esm/Charting/Visuals/RenderableSeries/BaseRenderableSeries.js:716` — same hash on the getYRange path when resamplingParams is unset
- `esm/Charting/Model/TableDataSeries.js:519` — generateObjectHash(rp) again for the shared point-series cache

## Review notes

- Found by reviewer slice `s09-filters-numerics-utils`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.
- Duplicate merged from slice `x2-data-and-lifecycle`: Resampling cache key is rebuilt per resampled series per frame with JSON.stringify and String.split("")
