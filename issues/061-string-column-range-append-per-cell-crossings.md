# 061 · Range appends on string columns (XyTextDataSeries, TableDataSeries) write blanks in bulk, then rewrite every cell through setValueAt at about 5 wasm calls per cell

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Model/XyTextDataSeries.js:177` |
| Severity | **medium** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | frame time (per data update) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | SC-01, TASK-13 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
        const firstRow = Math.max(startIndex, 0);
        for (let i = 0; i < written; i++) {
            store.setValueAt(firstRow + i, textValues[dropped + i]);
        }
```

## Call path and frequency

app -> XyTextDataSeries.appendRange (esm/Charting/Model/XyTextDataSeries.js:94-96) -> BaseDataSeries.appendRangeN (esm/Charting/Model/BaseDataSeries.js:195) -> appendEmptyToStringColumns (:219 -> :1014-1017) -> StringColumnStore.appendEmpty (:127; on FIFO, releaseEvictedBy :355-359) -> onAppend (:220-221) -> XyTextDataSeries.writeText (:165-178) -> StringColumnStore.setValueAt (:165-173) per row. TableDataSeries.appendRange (:444, onAppend :458) -> writeStringCells (:421-433) runs the same loop per string column. Rate: per data update, per appended row.

## Why it costs

A range call is meant to cross the boundary once per batch (SC-01), and the numeric columns do (one HEAPF64.set). The string column bulk-writes blanks and then rewrites every row through the single-cell API, so appendRange becomes per-row boundary traffic. Release(-1) on a fresh blank is a crossing that does no work.

**Scale where it matters:** XyTextDataSeries (text labels for FastTextRenderableSeries) and tabular TableDataSeries with string columns, with appendRange batches of 100s-10,000s rows. Example: a streaming FIFO text series. About 5 embind crossings per row (6 for an unseen string), plus 2 per evicted row on a full FIFO.

## Fix (library side)

```diff
--- a/esm/Charting/Model/StringColumnStore.js
+++ b/esm/Charting/Model/StringColumnStore.js
+    /** Bulk setValueAt for logical rows [firstRow, firstRow + values.length). */
+    setValuesAt(firstRow, values) {
+        this.throwIfDeleted();
+        const n = values.length;
+        Guard.isTrue(firstRow >= 0 && firstRow + n <= this.codes.size(), "rows must be within the column");
+        const newCodes = new Int32Array(n);
+        for (let i = 0; i < n; i++) newCodes[i] = this.encode(values[i]); // AddRef before Release, as setValueAt
+        const cap = this.fifoCapacity;
+        const start = cap ? this.codes.getStartIndex() : 0;
+        const view = this.rawCodesView(); // after encode(): Append may grow the heap
+        const released = [];
+        for (let i = 0; i < n; i++) {
+            const p = cap ? (start + firstRow + i) % cap : firstRow + i;
+            if (view[p] >= 0) released.push(view[p]); // blanks (-1) need no Release
+            view[p] = newCodes[i];
+        }
+        for (const code of released) this.dictionary.Release(code);
+    }
--- a/esm/Charting/Model/XyTextDataSeries.js
+++ b/esm/Charting/Model/XyTextDataSeries.js
@@ writeText(startIndex, textValues)
-        for (let i = 0; i < written; i++) {
-            store.setValueAt(firstRow + i, textValues[dropped + i]);
-        }
+        store.setValuesAt(firstRow, dropped === 0 && written === textValues.length ? textValues : textValues.slice(dropped, dropped + written));
--- a/esm/Charting/Model/TableDataSeries.js (writeStringCells: same replacement per store)
```

**Trade-off:** AddRef stays one crossing per value because the shipped wasm API has no batch AddRef; a native batch encode would remove it. The FIFO mapping (start + row) % capacity must match SCRTIntFifoVector's logical indexing, the same rule getTextAt documents, so the existing FIFO string-column tests must pass. The blank pre-fill could also be skipped for columns the subclass fills, but that changes the onAppend contract.

## App-side workaround

Nothing inside the API. For high-rate labels, keep the strings in a JS array keyed by row and render them with a numeric XyDataSeries and a custom data label provider.

## Verify

measure.md#fps, scenario "stream": an XyTextDataSeries with fifoCapacity 10,000, appendRange of 200 rows per frame at 60 Hz for 10 s. 5 runs per side. Pass: "win" on frameP95Ms, and the LoAF script time attributed to appendRange/writeText/setValueAt drops.

## Other locations

- `esm/Charting/Model/StringColumnStore.js:165` — setValueAt makes these embind calls per cell: codes.size(), codes.get(), dictionary.AddRef (plus Append for a new string), dictionary.Release(previousCode), which is -1 for a fresh blank, and codes.set()
- `esm/Charting/Model/TableDataSeries.js:433` — writeStringCells: the same per-cell loop for every string column on appendRange/appendRows/insertRange
- `esm/Charting/Model/BaseDataSeries.js:219` — appendEmptyToStringColumns writes a blank code for every new row before onAppend overwrites it
- `esm/Charting/Model/StringColumnStore.js:359` — releaseEvictedBy: codes.get + dictionary.Release per evicted row once a FIFO column is full
- `esm/Charting/Model/StringColumnStore.js:248` — removeRange: codes.get + Release per removed row

## Review notes

- Found by reviewer slice `s08-data-series`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

