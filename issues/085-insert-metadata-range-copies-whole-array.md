# 085 · insertRange on a series with metadata copies the whole metadata array three times (two slices and a concat), and the generator branch reads the global `length`

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Model/BaseDataSeries.js:1317` |
| Severity | **low** |
| Pipeline stage | JS execution (`js`) |
| Metric | memory (GC), frame time on insert |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | V8-06 (web-performance skill) |
| Effort to fix | small |

## Code

```js
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

app -> XyDataSeries.insertRange (esm/Charting/Model/XyDataSeries.js:143) / other insertRange variants -> BaseDataSeries.insertRangeN (esm/Charting/Model/BaseDataSeries.js:383) -> insertMetadataRange (:410 -> :1304-1319). Rate: per insertRange, only when the series has metadata or a metadata generator.

## Why it costs

The native insert is one memmove. The metadata side allocates two partial copies and a full concatenation; at this size they go to large-object/old space, so each insert leaves big garbage for a major GC.

**Scale where it matters:** Series of 100k-10M points with metadata and repeated insertRange, for example prepending older history while the user pans left. Each insert allocates about 3n array slots and drops the old n-slot array.

## Fix (library side)

```diff
--- a/esm/Charting/Model/BaseDataSeries.js
+++ b/esm/Charting/Model/BaseDataSeries.js
@@ insertRangeN
-            this.insertMetadataRange(startIndex, metadata);
+            this.insertMetadataRange(startIndex, metadata, xValues.length);
@@
-    insertMetadataRange(startIndex, metadata) {
+    insertMetadataRange(startIndex, metadata, length) {
@@
-        const previousValues = this.metadataProperty.slice(0, startIndex);
-        const nextValues = this.metadataProperty.slice(startIndex);
-        this.metadataProperty = previousValues.concat(metadata, nextValues);
+        const md = this.metadataProperty;
+        const oldLength = md.length;
+        md.length = oldLength + length;                          // grow once, in place
+        md.copyWithin(startIndex + length, startIndex, oldLength); // shift the tail
+        for (let i = 0; i < length; i++) md[startIndex + i] = metadata[i];
```

**Trade-off:** copyWithin on a JS array is still an O(n) element loop, but it allocates nothing. Growing length first makes the array holey until the loop fills it. The extra parameter also fixes the `length` correctness bug, where a generator-backed insert misaligned the metadata.

## App-side workaround

Avoid metadata on series that get insertRange, or rebuild them with clear() plus appendRange of the merged data when inserts are rare.

## Verify

measure.md#mem: insertRange(0, 1,000 points with metadata) into a 1M-point series, 10 times. Pass: heapPerActionMb is lower and Major GC time in the window goes down, with frameP95Ms during the inserts not worse (measure.md#fps).

## Other locations

- `esm/Charting/Model/BaseDataSeries.js:410` — Caller in insertRangeN; it does not pass xValues.length
- `esm/Charting/Model/BaseDataSeries.js:1310` — `length` is not a parameter here, so it resolves to window.length (the frame count). In a Worker it throws ReferenceError

## Review notes

- Found by reviewer slice `s08-data-series`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

