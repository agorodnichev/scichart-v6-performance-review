# 040 · Tabular TableDataSeries renumbers row positions with one embind xValues.set(i, i) per remaining row after every remove or insert

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Model/TableDataSeries.js:346` |
| Severity | **medium** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | frame time (per data update) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
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
@@ deleteRowAtPosition(rowPosition)
-        const xValues = this.getNativeXValues();
         const n = this.count();
+        // Take the view after super.removeAt (a native edit can move the buffer). The loop treats every
+        // element independently, so a FIFO series' physical order does not matter here.
+        const xView = vectorToArrayViewF64(this.getNativeXValues(), this.webAssemblyContext);
         let shifted = false;
         for (let i = 0; i < n; i++) {
-            const x = xValues.get(i);
+            const x = xView[i];
             if (x > rowPosition) {
-                xValues.set(i, x - 1);
+                xView[i] = x - 1;
                 shifted = true;
             }
         }
@@ renumberRowPositions(fromIndex)
     renumberRowPositions(fromIndex) {
-        const xValues = this.getNativeXValues();
         const n = this.count();
-        for (let i = Math.max(0, fromIndex); i < n; i++) {
-            xValues.set(i, i);
-        }
+        // Callers run after removeAt/removeRange/insertRangeN, which throw on FIFO (throwIfFifo),
+        // so the vector is linear; take the view after the native edit and do not keep it.
+        const xView = vectorToArrayViewF64(this.getNativeXValues(), this.webAssemblyContext);
+        for (let i = Math.max(0, fromIndex); i < n; i++) {
+            xView[i] = i;
+        }
     }
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
- Adversarial verification (corrected): Quote matches TableDataSeries.js:346-352 verbatim (primary moved from :350, the set() line, to :346 where the quote starts). rg shows three callers of renumberRowPositions: removeAt :217 (only when isTabular), removeRange :234 (only when isTabular) and insertRange :493 (always); removeRow :238 and removeRows :242 delegate to them, and insertRow/insertRows delegate to insertRange. Each runs after the native edit: BaseDataSeries.removeAt :423-436 (getNativeXValues().removeAt, per-column removeAt, string stores, then notifyDataChanged), removeRange :447-460, insertRangeN :383-411. All three throw on FIFO first (throwIfFifo at BaseDataSeries.js:428, :454, :396), so the x vector is linear when renumbering runs and a view index equals the logical index. No batching or guard: the loop does one embind set() per row from fromIndex to count(). deleteRowAtPosition :252-273 does get() + set() for every row, also with no guard. vectorToArrayViewF64 is exported from esm/utils/vectorToArray.js:74 and builds the view from dataPtr/size, so taking it after the native edit is correct. SC-06 Do/Avoid (scichart.md:154) supports a view used at once. Severity medium kept: the rate is per data update (per removal or insert call), not per frame by itself; a per-message removeRow is an app pattern SC-01 already advises against. Evidence S: n-fromIndex crossings per call is certain from the code. Corrected the fix diff to spell out deleteRowAtPosition instead of a comment.

