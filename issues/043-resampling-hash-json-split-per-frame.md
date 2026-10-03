# 043 · Resampling hash per frame per series: JSON.stringify of the params, then a one-string-per-character array and a reduce callback per character

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/utils/hash.js:2` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (GC pressure) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/324c5508c89132536fbe16b9de952c3b/): reproduced on WebGL and WebGPU ([source](../demos/043-resampling-hash-json-split-per-frame/)) |
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

- `esm/Charting/Numerics/Resamplers/ExtremeResamplerHelper.js:73` — calculateResamplingHash, per frame per resampled series (generateObjectHash(rp) at :86); same root cause also reported by slice x2-data-and-lifecycle
- `esm/Charting/Visuals/RenderableSeries/BaseRenderableSeries.js:716` — Y auto-range path computes the same hash when resamplingParams is unset; resampleSeries then reuses rp.hash
- `esm/Charting/Model/TableDataSeries.js:519` — generateObjectHash(rp) again for the shared point-series cache, per toPointSeries

## Review notes

- Found by reviewer slice `s09-filters-numerics-utils`.
- Adversarial verification (corrected): Re-read esm/utils/hash.js:2-9 (quote verbatim). Call path confirmed: SciChartRenderer.prepareSeriesRenderData (esm/Charting/Services/SciChartRenderer.js:610, called per render at :135) -> ExtremeResamplerHelper.resampleSeries (:639) -> when rs.getResamplingParams() is unset (:31-33) builds a new ResamplingParams and, if needsResampling, calls calculateResamplingHash (:43, :73-90) -> generateHash(dataSeries.id), 2x generateNumberHash, generateBooleanHash and generateObjectHash(rp) (:86). resamplingParams is cleared at the end of every draw (esm/Charting/Visuals/RenderableSeries/BaseRenderableSeries.js:662), so no cross-frame cache defeats it. The Y auto-range path getResampledPointSeries (BaseRenderableSeries.js:710-716) computes the hash first when resamplingParams is unset, and needsResampling then stores rp (:1195), so resampleSeries takes the 'rp.resampleRequired' branch (:56-62) and reuses rp.hash: one hash per series per render, not two. needsResampling returns true for every FIFO non-sweeping series (ExtremeResamplerHelper.js:112, dataIsFifo from ResamplingParams.js:28). ResamplingParams (ResamplingParams.js:3-31) is a class instance with two NumberRange instances (min/max only); a representative object serializes to 363 characters in a scratch check. Fix diff checked: a scratch script compared the old split/reduce and the new loop on 20,000 random strings (ASCII and full BMP, including the empty string): 0 mismatches, both ToInt32 each step. Severity medium kept: per-render per resampled series, but a small constant cost (one ~360-char string, one ~450-entry array). Corrected only other_locations, which repeated three locations after the merge and listed the primary location as another location.
- Duplicate merged from slice `x2-data-and-lifecycle`: Resampling cache key is rebuilt per resampled series per frame with JSON.stringify and String.split("")
