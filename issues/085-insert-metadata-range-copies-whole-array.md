# 085 · insertRange on a series with metadata rebuilds the whole metadata array (two slices plus a concat, about 2n+m slots per insert), and the generator branch reads the global `length`

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Model/BaseDataSeries.js:1304` |
| Severity | **low** |
| Pipeline stage | JS execution (`js`) |
| Metric | memory (GC), frame time on insert |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/70c76d555ebdc2b8c60da74c9d250d81/): reproduced on WebGL and WebGPU ([source](../demos/085-insert-metadata-range-copies-whole-array/)) |
| Rule | V8-06 (web-performance skill) |
| Effort to fix | small |

## Code

```js
    insertMetadataRange(startIndex, metadata) {
        if (!metadata) {
            if (!this.metadataGeneratorProperty) {
                return;
            }
            else {
                metadata = Array(length)
                    .fill(1)
                    .map(x => this.metadataGeneratorProperty.getSingleMetadata());
            }
        }
        this.fillMetadataIfUndefined();
        // TODO probably this could be optimized
        const previousValues = this.metadataProperty.slice(0, startIndex);
        const nextValues = this.metadataProperty.slice(startIndex);
        this.metadataProperty = previousValues.concat(metadata, nextValues);
```

## Call path and frequency

app -> XyDataSeries.insertRange (esm/Charting/Model/XyDataSeries.js:143) / other insertRange variants (Xyy, Xyz, Hlc, Ohlc, Xyxy, Xyx, X, BoxPlot, XyText) -> BaseDataSeries.insertRangeN (esm/Charting/Model/BaseDataSeries.js:383) -> insertMetadataRange (:410 -> :1304-1319). Also source insert -> *CustomFilter.filterOnInsert (esm/Charting/Model/Filters/XyCustomFilter.js:48-50) -> insertRange on the filter series. Rate: once per insertRange call, only when metadata is passed or the series has a metadata generator.

## Why it costs

The native x/y insert resizes the WASM vector and shifts the tail in place. The metadata side instead builds a brand-new n+m array through two temporary slices on every insert. The slices die young, but at 100k+ elements they are large objects that add scavenge pressure; the replaced metadata array is long-lived (old generation), so every insert leaves an n-slot old-space array that only a major GC reclaims.

**Scale where it matters:** Series of 100k-10M points with metadata and repeated insertRange, for example prepending older history while the user pans left. With n existing and m inserted points, each insert allocates about 2n+m array slots (n in the two slices, n+m in the concat result) and drops the old n-slot metadata array plus the n slots of slices.

## Fix (library side)

```diff
--- a/esm/Charting/Model/BaseDataSeries.js
+++ b/esm/Charting/Model/BaseDataSeries.js
@@ -410 +410 @@ insertRangeN
-            this.insertMetadataRange(startIndex, metadata);
+            this.insertMetadataRange(startIndex, metadata, xValues.length);
@@ -1304,19 +1304,22 @@
-    insertMetadataRange(startIndex, metadata) {
+    insertMetadataRange(startIndex, metadata, length) {
         if (!metadata) {
             if (!this.metadataGeneratorProperty) {
                 return;
             }
             else {
                 metadata = Array(length)
                     .fill(1)
                     .map(x => this.metadataGeneratorProperty.getSingleMetadata());
             }
         }
         this.fillMetadataIfUndefined();
-        // TODO probably this could be optimized
-        const previousValues = this.metadataProperty.slice(0, startIndex);
-        const nextValues = this.metadataProperty.slice(startIndex);
-        this.metadataProperty = previousValues.concat(metadata, nextValues);
+        // grow in place, like appendMetadataRange does, then shift the tail up
+        const md = this.metadataProperty;
+        const oldLength = md.length;
+        md.length = oldLength + length;
+        for (let i = oldLength - 1; i >= startIndex; i--) md[i + length] = md[i];
+        for (let i = 0; i < length; i++) md[startIndex + i] = metadata[i];
     }
```

**Trade-off:** The tail shift is still O(n) per insert, but it allocates nothing beyond growing the existing array. A plain backward loop is used because Array.prototype.copyWithin on a JS Array takes V8's generic per-element path and is not cheaper than slice+concat. The array is already HOLEY (Array(n).fill in fillMetadataIfUndefined, length += n in appendMetadataRange), so growing length adds no elements-kind transition. The array keeps its identity, as it already does for appendMetadataRange and setMetadataAt; an object returned earlier by toJSON() (options.metadata is the live array, BaseDataSeries.js:1191) now sees the insert. The extra parameter also fixes the `length` bug, so generator-backed inserts now generate xValues.length items instead of window.length items (or throwing in a Worker).

## App-side workaround

Avoid metadata on series that get insertRange, or rebuild them with clear() plus appendRange of the merged data when inserts are rare.

## Verify

measure.md#mem: insertRange(0, 1,000 points with metadata) into a 1M-point series, 10 times. Pass: heapPerActionMb is lower and Major GC time in the window goes down, with frameP95Ms during the inserts not worse (measure.md#fps). Correctness: with setMetadataGenerator and no metadata argument, after insertRange of k points getMetadataAt(i) lines up with getNativeXValues().get(i) and the metadata length equals count(); the same call inside a Worker no longer throws.

## Other locations

- `esm/Charting/Model/BaseDataSeries.js:410` — Caller in insertRangeN; it does not pass xValues.length
- `esm/Charting/Model/BaseDataSeries.js:1310` — `length` is not a parameter or module binding here, so it resolves to globalThis.length: window.length (child frame count, usually 0, so generated metadata is [] and the metadata array falls behind the x values). In a Worker or Node it throws ReferenceError. Same code in cjs/Charting/Model/BaseDataSeries.js:1413 and index.min.js
- `esm/Charting/Model/BaseDataSeries.js:1281` — appendMetadataRange already grows metadataProperty in place (length += n, then indexed writes); the fix follows the same pattern
- `esm/Charting/Model/Filters/XyCustomFilter.js:50` — filterOnInsert re-issues insertRange with metadata on the derived series, so a filtered series pays the copy again

## Review notes

- Found by reviewer slice `s08-data-series`.
- Adversarial verification (corrected): Re-read esm/Charting/Model/BaseDataSeries.js:383-415 (insertRangeN) and :1265-1319 (appendMetadataRange, insertMetadata, insertMetadataRange). Quote matched verbatim but started at 1309 while primary pointed at 1317; re-anchored primary to the function header 1304 and quoted 1304-1319 so the missing `length` parameter is visible. Caller chain: XyDataSeries.insertRange (XyDataSeries.js:143) -> super.insertRangeN (:144) -> BaseDataSeries.insertRangeN (BaseDataSeries.js:383) -> this.insertMetadataRange(startIndex, metadata) (:410) -> slice/slice/concat (:1317-1319). Same for Xyy/Xyz/Hlc/Ohlc/Xyxy/Xyx/X/BoxPlot/XyText insertRange; XyCustomFilter.filterOnInsert (Filters/XyCustomFilter.js:48-50) and the other *CustomFilter.filterOnInsert re-issue insertRange on derived series with metadata. No guard: the only early return (:1305-1307) is when there is neither metadata nor a generator; no suspendUpdates batching applies to this copy. `length` has no binding in the module (imports :1-23, top-level const :35, class :46), so :1310 reads globalThis.length: window.length (child frame count, usually 0 -> metadata=[] -> metadata array falls behind x by N); ReferenceError in a Worker/Node (confirmed in Node: (0,eval)('length') throws ReferenceError). Same code in cjs/Charting/Model/BaseDataSeries.js:1413 and index.min.js. Corrections: (1) title/scale overstated the copying: the two slices together copy n slots once, and concat copies n+m, so ~2n+m slots are allocated per insert, not 3n; (2) the proposed fix used Array.prototype.copyWithin, which on a JS Array runs V8's generic per-element HasProperty/Get/Set path; a local Node 22 sanity check (1M-element holey array, 1k-element insert at 0) showed copyWithin no cheaper in CPU than slice+concat, while a plain backward loop was several times cheaper, so the diff now uses a backward loop (checked equal to slice+concat output for startIndex 0,1,3,5); (3) trade_off: the array is already HOLEY (fillMetadataIfUndefined uses Array(n).fill at :1384, appendMetadataRange does length += n at :1283, setMetadataGenerator uses Array(n).fill().map at :790), so growing length adds no new elements-kind transition, and appendMetadataRange (:1281-1287) already mutates metadataProperty in place, so in-place insert does not change identity semantics the library relies on; (4) why_it_costs: the slices are short-lived young (new large-object space) garbage freed by scavenges; the expensive part is the dropped long-lived n-slot array, which only a major GC reclaims. Severity low kept: insertRange is per app data update, not per frame/input, and only with metadata or a generator. Evidence S kept: the allocations and the global `length` read happen on every such call.

