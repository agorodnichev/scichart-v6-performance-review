# 040 · Tabular TableDataSeries renumbers row positions with one embind xValues.set(i, i) per remaining row after every remove or insert

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Model/TableDataSeries.js:350` |
| Severity | **medium** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | frame time (per data update) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | SC-06, TASK-13 (web-performance skill) |
| Effort to fix | small |

## Code

```js
    renumberRowPositions(fromIndex) {
        const xValues = this.getNativeXValues();
        const n = this.count();
        for (let i = Math.max(0, fromIndex); i < n; i++) {
            xValues.set(i, i);
        }
    }
```

## Call path and frequency

app -> TableDataSeries.removeAt (esm/Charting/Model/TableDataSeries.js:211) / removeRange (:225) / removeRow (:238) / removeRows (:242) / insertRange (:476) -> BaseDataSeries.removeAt (esm/Charting/Model/BaseDataSeries.js:423, a native O(n) shift) -> renumberRowPositions (:346-352): one embind set() per row from fromIndex to the end. Rate: per data update. A live table that drops its oldest row per message pays it per message.

## Why it costs

Writing the sequence 0..n-1 is a trivial loop, but each element is written through an embind method call, so the cost is n boundary crossings. A Float64Array view over the same vector writes it with no crossing.

**Scale where it matters:** Tabular TableDataSeries (the columns option) used as a live table or log. Removing row 0 renumbers every remaining row: 100k rows means 100k JS->wasm calls per removal, on top of the native memmove.

## Fix (library side)

```diff
--- a/esm/Charting/Model/TableDataSeries.js
+++ b/esm/Charting/Model/TableDataSeries.js
-import { vectorToArray } from "../../utils/vectorToArray";
+import { vectorToArray, vectorToArrayViewF64 } from "../../utils/vectorToArray";
@@
     renumberRowPositions(fromIndex) {
-        const xValues = this.getNativeXValues();
         const n = this.count();
-        for (let i = Math.max(0, fromIndex); i < n; i++) {
-            xValues.set(i, i);
-        }
+        // insert/remove throw on FIFO (throwIfFifo), so this vector is linear; take the view after the native edit
+        const xView = vectorToArrayViewF64(this.getNativeXValues(), this.webAssemblyContext);
+        for (let i = Math.max(0, fromIndex); i < n; i++) {
+            xView[i] = i;
+        }
     }
@@ deleteRowAtPosition (same: read and write through one view instead of get()/set() per row)
```

**Trade-off:** The view must be created after the native remove or insert (an allocation can detach it) and must not be kept. No behavior change otherwise.

## App-side workaround

Remove in batches: one removeRows(0, k) per frame instead of removeRow per message, so the renumber runs once per frame.

## Verify

measure.md#fps, scenario "stream": a tabular TableDataSeries with 100k rows, appendRow plus removeRow(0) per message at 60 messages/s for 10 s. 5 runs per side. Pass: "win" on frameP95Ms, and renumberRowPositions drops out of the LoAF topScripts.

## Other locations

- `esm/Charting/Model/TableDataSeries.js:263` — deleteRowAtPosition: xValues.get(i) plus xValues.set(i, x - 1) for every row
- `esm/Charting/Model/TableDataSeries.js:217` — Called after every removeAt / removeRow
- `esm/Charting/Model/TableDataSeries.js:234` — Called after every removeRange / removeRows
- `esm/Charting/Model/TableDataSeries.js:493` — Called after every insertRange / insertRows

## Review notes

- Found by reviewer slice `s08-data-series`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

