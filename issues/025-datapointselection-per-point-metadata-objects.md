# 025 · DataPointSelectionModifier gives every point of every series its own metadata object, at attach and on every later append, and keeps doing so after the modifier is removed

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/ChartModifiers/DataPointSelectionModifier.js:171` |
| Severity | **high** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory (also frame time via GC on streaming series, and attach time) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | V8-04, V8-07 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
        if (!baseDataSeries.hasMetadataGenerator()) {
            baseDataSeries.setMetadataGenerator(new TemplateMetadataGenerator({ isSelected: false }));
        }
```

## Call path and frequency

Attach: DataPointSelectionModifier.onAttach (DataPointSelectionModifier.js:138) -> onAttachSeries (:160) for each included series. Every series added later: SciChartSurface.js:1431-1432 calls cm.onAttachSeries(rs) on all modifiers, and this one does not check inclusion -> setMetadataGenerator (:171) -> BaseDataSeries.js:786-793 `Array(n).fill(1).map(() => getSingleMetadata())` -> IPointMetadata.js:7-8 `Object.assign({}, template)`, so one object per existing point (once per series). Then the O(n) scan at :173-179 calls getMetadataAt(i), with validateIndex, for every point. Per data update afterwards: XyDataSeries.appendRange (XyDataSeries.js:96) -> BaseDataSeries.appendRangeN (:214) -> appendMetadataRange (:1265-1273) allocates `length` new objects and two temporary arrays on every append. onDetachSeries (:185) never removes the generator, so the per-append allocation outlives the modifier. Custom filters then copy the metadata per point (Filters/XyCustomFilter.js:70-76).

## Why it costs

The selection state is one boolean per point. It is stored as an array of n separate JS objects, each about 20-30 bytes plus an 8-byte slot, in place of n slots that point at one shared object. Attaching to a 1M-point series creates 1M objects and 2 temporary 1M-entry arrays in one task. On a live series, every appendRange allocates k objects that end up in a long-lived array. That promotes them to the old generation (V8-07) and adds major-GC work for as long as the series lives, including after the modifier is removed.

**Scale where it matters:** Any included series with 100k+ points (scatter selection is the typical use), or any streaming series that appends k points per update while the modifier is attached. Cost is O(points) objects per series plus k objects per append.

## Fix (library side)

```diff
--- esm/Charting/ChartModifiers/DataPointSelectionModifier.js
+// Points that were never selected share one frozen record, so there is no object per point
+const UNSELECTED = Object.freeze({ isSelected: false });
+const unselectedMetadataGenerator = {
+    getSingleMetadata: () => UNSELECTED,
+    getMetadata: () => undefined,
+    toJSON: () => ({ isSelected: false })
+};
+// Copy-on-write: a point gets its own record only when its selection state is set
+const setSelected = (dataSeries, index, metadata, isSelected) => {
+    if (metadata === UNSELECTED) {
+        metadata = { isSelected };
+        dataSeries.setMetadataAt(index, metadata);
+    } else {
+        metadata.isSelected = isSelected;
+    }
+    return metadata;
+};
@@ onAttachSeries(rs)
         if (!baseDataSeries.hasMetadataGenerator()) {
-            baseDataSeries.setMetadataGenerator(new TemplateMetadataGenerator({ isSelected: false }));
+            baseDataSeries.setMetadataGenerator(unselectedMetadataGenerator);
         }
@@ selectManyPoints / selectSinglePoint / selectPoint (every `x.isSelected = v` on series metadata)
-                                metadata.isSelected = true;
-                                this.addSelectedDataPoint(rs, i, new DataPointInfo(rs, metadata, i));
+                                const md = setSelected(baseDataSeries, i, metadata, true);
+                                this.addSelectedDataPoint(rs, i, new DataPointInfo(rs, md, i));
```

**Trade-off:** Unselected points now share one frozen object. App code that sets `metadata.isSelected = true` directly on a point that was never selected now throws in strict mode, so it must use setMetadataAt or the modifier. App-supplied metadata generators are not affected. The metadata array still has one 8-byte slot per point (BaseDataSeries.js:790 and :1272 still allocate an Array(n) plus a map). Removing that too needs a sparse selection Set in the data series, which changes the public metadata API.

## App-side workaround

Exclude large or streaming series with `excludedSeriesIds`, and add those series to the surface before the modifier. Series added later get the generator whatever their inclusion (SciChartSurface.js:1431). Do not rely on removing the modifier: the generator stays on the series.

## Verify

measure.md#mem: chart with a 1M-point XyDataSeries; add and remove DataPointSelectionModifier 10 times; heap snapshots S1/S2. Pass: the snapshot no longer holds ~1M `{isSelected}` Object instances after attach, and heapPerActionMb is within noise. Also measure.md#fps 'stream' scenario: appendRange of 1,000 points per frame into a fifo series with the modifier attached, 10 s, 5 runs per side. Pass: 'Minor GC' time per second goes down in trace-summary and frameP99Ms wins or is neutral.

## Other locations

- `esm/Charting/ChartModifiers/DataPointSelectionModifier.js:173` — O(n) getMetadataAt scan per attached series
- `esm/Charting/ChartModifiers/DataPointSelectionModifier.js:185` — onDetachSeries leaves the metadata generator installed
- `esm/Charting/Model/BaseDataSeries.js:790` — Array(n).fill(1).map(getSingleMetadata), one object per existing point
- `esm/Charting/Model/BaseDataSeries.js:1272` — appendMetadataRange allocates one object per appended point
- `esm/Charting/Model/IPointMetadata.js:8` — Object.assign({}, template) per point
- `esm/Charting/Model/Filters/XyCustomFilter.js:76` — filters copy the metadata per point once it exists
- `esm/Charting/ChartModifiers/Polar/PolarDataPointSelectionModifier.js:1` — inherits the same onAttachSeries

## Review notes

- Found by reviewer slice `s10-modifiers-input`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

