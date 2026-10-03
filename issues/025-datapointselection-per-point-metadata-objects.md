# 025 · DataPointSelectionModifier gives every point of each series it attaches to its own metadata object, at attach and on every later append, and keeps doing so after the modifier is removed

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/ChartModifiers/DataPointSelectionModifier.js:171` |
| Severity | **high** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory (also frame time via GC on streaming series, and attach time) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/8dae0fb7ec373bb600d80e41e4bce814/): reproduced on WebGL and WebGPU ([source](../demos/025-datapointselection-metadata-objects/)) |
| Rule | V8-04, V8-07 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
        if (!baseDataSeries.hasMetadataGenerator()) {
            baseDataSeries.setMetadataGenerator(new TemplateMetadataGenerator({ isSelected: false }));
        }
```

## Call path and frequency

Attach: DataPointSelectionModifier.onAttach (DataPointSelectionModifier.js:138) -> onAttachSeries (:160) for each visible included series. Every series added later: SciChartSurface.js:1431-1432 calls cm.onAttachSeries(rs) on every modifier, and this onAttachSeries (:160-172) has no inclusion or visibility check -> setMetadataGenerator (:171) -> BaseDataSeries.js:786-793 `Array(n).fill(1).map(() => getSingleMetadata())` -> IPointMetadata.js:7-8 `Object.assign({}, template)`: one object per existing point, once per series (a later attach sees hasMetadataGenerator() true at :170 and skips it). Then the O(n) scan at :173-179 calls getMetadataAt(i) per point; each call runs validateIndex (BaseDataSeries.js:801, :1225-1232), which calls count() -> xValues.size() (:549-551), one Wasm call per point. Per data update afterwards: XyDataSeries.appendRange (XyDataSeries.js:96) -> BaseDataSeries.appendRangeN (:214) -> appendMetadataRange (:1265-1273) allocates `length` new objects plus two temporary arrays of that length on every append and stores the objects in the long-lived metadataProperty (:1283-1287, or appendRangeFifo for FIFO series, where each replaces an older one). appendN (:169) -> appendMetadata (:1254) does the same per point. onDetach (:143-149) -> onDetachSeries (:185-193) and delete() (:336-340) never remove the generator, so the per-append allocation outlives the modifier. Custom filters over such a series take the metadata branch: filterOnAppend (Filters/XyCustomFilter.js:42) -> filter (:70-77) does one getMetadataAt (validateIndex + Wasm count()) and one reference push per appended point.

## Why it costs

The selection state is one boolean per point, but it is stored as n separate JS objects: each `Object.assign({}, template)` result is about 28 bytes in Chrome (an empty-literal object with 4 in-object slots under pointer compression), plus a 4-byte element slot in metadataProperty, where n slots pointing at one shared record would do. Attaching to a 1M-point series creates 1M objects and one temporary 1M-entry array (the filled Array(n); the mapped array is kept as metadataProperty), then makes 1M getMetadataAt calls, each with a Wasm size() call, in one task; that part is one-time per series. The hot part is streaming: every appendRange allocates k objects and two temporary k-entry arrays, and the objects are stored into a long-lived array. Referenced from an old-generation array, they survive the scavenger and are promoted (V8-07); on a FIFO series each is dropped fifoCapacity points later, where only a major GC reclaims it. This continues for as long as the series lives, including after the modifier is removed, and also on series the modifier excludes when they are added after it.

**Scale where it matters:** High rests on streaming: any series that receives appendRange/append of k points per update while it carries this generator (included when the modifier attached, or added to the surface after the modifier whatever excludedSeriesIds says, and still after the modifier is removed). Cost: k objects plus two temporary k-entry arrays per update. Attach: one-time O(n) objects and O(n) Wasm size() calls per series; for a static 100k-1M point scatter that part alone is a one-time cost (medium on its own).

## Fix (library side)

```diff
--- esm/Charting/ChartModifiers/DataPointSelectionModifier.js
+// Never-selected points share one frozen record; a point gets its own record only when it is selected
+const UNSELECTED = Object.freeze({ isSelected: false });
+const unselectedMetadataGenerator = {
+    type: "Template",
+    getSingleMetadata: () => UNSELECTED,
+    getMetadata: () => undefined,
+    toJSON: () => ({ isSelected: false })
+};
+// Copy-on-write: replaces the shared record in the series before the first write to it
+const setSelected = (dataSeries, index, metadata, isSelected) => {
+    if (metadata === UNSELECTED) {
+        if (!isSelected) return metadata;
+        metadata = { isSelected };
+        dataSeries.setMetadataAt(index, metadata);
+    } else {
+        metadata.isSelected = isSelected;
+    }
+    return metadata;
+};
@@ onAttachSeries(rs) (:170-172)
         if (!baseDataSeries.hasMetadataGenerator()) {
-            baseDataSeries.setMetadataGenerator(new TemplateMetadataGenerator({ isSelected: false }));
+            baseDataSeries.setMetadataGenerator(unselectedMetadataGenerator);
         }
@@ selectManyPoints (:400-413)
-                            const metadata = baseDataSeries.getMetadataAt(i);
+                            let metadata = baseDataSeries.getMetadataAt(i);
                             if (selectionMode !== ESelectionMode.Inverse) {
-                                metadata.isSelected = true;
+                                metadata = setSelected(baseDataSeries, i, metadata, true);
                                 this.addSelectedDataPoint(rs, i, new DataPointInfo(rs, metadata, i));
                             }
                             else {
                                 if (metadata.isSelected) {
                                     metadata.isSelected = false;
                                     this.removeSelectedDataPoint(rs, i);
                                 }
                                 else {
-                                    metadata.isSelected = true;
+                                    metadata = setSelected(baseDataSeries, i, metadata, true);
                                     this.addSelectedDataPoint(rs, i, new DataPointInfo(rs, metadata, i));
                                 }
                             }
@@ selectSinglePoint (:455-469)
+                const ds = ht.associatedSeries.dataSeries;
                 if (selectionMode === ESelectionMode.Union) {
                     // Always select in union
-                    ht.metadata.isSelected = true;
+                    ht.metadata = setSelected(ds, ht.dataSeriesIndex, ht.metadata, true);
                     const newDataPointInfo = new DataPointInfo(ht.associatedSeries, ht.metadata, ht.dataSeriesIndex);
@@
                     // Toggle selection
-                    ht.metadata.isSelected = !ht.metadata.isSelected;
+                    ht.metadata = setSelected(ds, ht.dataSeriesIndex, ht.metadata, !ht.metadata.isSelected);
@@ selectPoint (:501-502)
-        const md = rs.dataSeries.getMetadataAt(index);
-        md.isSelected = true;
+        const md = setSelected(rs.dataSeries, index, rs.dataSeries.getMetadataAt(index), true);
 (deselectAllPoints :486 and the Inverse "false" write :407 only touch records whose isSelected is true, which are never UNSELECTED, so they stay as they are; the TemplateMetadataGenerator import can go.)
```

**Trade-off:** Never-selected points share one frozen record. App code that writes any field on a never-selected point's metadata (for example `getMetadataAt(i).isSelected = true`, or adding a label) now throws TypeError (ESM is strict mode), so it must use setMetadataAt or the modifier's selectPoint. App-supplied metadata and generators are not affected. For a custom-filter series (XyCustomFilter etc.) whose source also carries this generator, the filter holds the source's references (XyCustomFilter.js:76); selecting a point now creates the per-point record only in the filter series' array, so the source series no longer sees the selection and a filterAll re-run drops it, where before both shared one mutated object. The metadata array still has one 4-byte slot per point (BaseDataSeries.js:790-792 and :1271-1273 still build Array(n) plus a map); removing that needs a sparse selection Set in the data series, which changes the public metadata API. The generator still stays on the series after the modifier is removed, but then it costs only reference slots.

## App-side workaround

Pass `excludedSeriesIds` for large or streaming series AND add those series to the surface before adding the modifier: onAttach (:138) honours inclusion, but series added later get the generator whatever their inclusion (SciChartSurface.js:1431, DataPointSelectionModifier.js:160-172). Do not rely on removing the modifier: the generator and the n objects stay on the series. Do not pre-install your own generator that returns one shared non-frozen object: the modifier writes `metadata.isSelected = true` in place (:402, :457, :502), which would select every point at once. A streaming series that must stay selectable has no app-side workaround short of the library fix.

## Verify

measure.md#mem: chart with a 1M-point XyDataSeries; add and remove DataPointSelectionModifier 10 times; heap snapshots S1/S2. Pass: the snapshot no longer holds ~1M `{isSelected}` Object instances after attach, and heapPerActionMb is within noise. Also measure.md#fps 'stream' scenario: appendRange of 1,000 points per frame into a fifo series with the modifier attached, 10 s, 5 runs per side. Pass: 'Minor GC' time per second goes down in trace-summary and frameP99Ms wins or is neutral.

## Other locations

- `esm/Charting/ChartModifiers/DataPointSelectionModifier.js:173` — O(n) getMetadataAt scan per attached series; each call validates the index via a Wasm count()
- `esm/Charting/ChartModifiers/DataPointSelectionModifier.js:185` — onDetachSeries (and onDetach :143, delete :336) leave the metadata generator installed
- `esm/Charting/Visuals/SciChartSurface.js:1431` — every added series is passed to every modifier's onAttachSeries, with no inclusion check in this modifier
- `esm/Charting/Model/BaseDataSeries.js:790` — Array(n).fill(1).map(getSingleMetadata), one object per existing point
- `esm/Charting/Model/BaseDataSeries.js:1271` — appendMetadataRange allocates one object per appended point plus two temporary arrays per append
- `esm/Charting/Model/BaseDataSeries.js:1254` — appendMetadata allocates one object per single append
- `esm/Charting/Model/IPointMetadata.js:8` — Object.assign({}, template) per point
- `esm/Charting/Model/Filters/XyCustomFilter.js:76` — once the source has metadata, filters do one getMetadataAt and one reference push per appended point (filterOnAppend :42)
- `esm/Charting/ChartModifiers/Polar/PolarDataPointSelectionModifier.js:22` — extends DataPointSelectionModifier without overriding onAttachSeries, so it inherits the same behaviour

## Review notes

- Found by reviewer slice `s10-modifiers-input`.
- Adversarial verification (corrected): Re-read DataPointSelectionModifier.js:133-193 and :347-504, BaseDataSeries.js:162-229, :549-554, :779-821, :1225-1291, :1381-1386, IPointMetadata.js:3-22, SciChartSurface.js:1425-1437, ChartModifierBase2D.js:162-199, Filters/XyCustomFilter.js:36-87, utils/array.js:92-112. Code quote at DataPointSelectionModifier.js:170-172 matches verbatim. Caller chains confirmed: (1) onAttach :138 -> getIncludedRenderableSeries (visible+included, ChartModifierBase2D.js:163,188-199) -> onAttachSeries :160 -> setMetadataGenerator :171 -> BaseDataSeries.js:789-793 Array(n).fill(1).map(getSingleMetadata) -> IPointMetadata.js:8 Object.assign({}, template). (2) SciChartSurface.js:1431-1432 calls cm.onAttachSeries(rs) on every modifier for every added series; DataPointSelectionModifier.onAttachSeries has no inclusion/visibility check, so excluded series added later get the generator too. (3) Per update: XyDataSeries.appendRange :96 -> appendRangeN :214 -> appendMetadataRange :1271-1273 (k objects + two temporary k-arrays, objects stored into long-lived metadataProperty :1283-1287 or the FIFO ring via appendRangeFifo); appendN :169 -> appendMetadata :1254 likewise per point. (4) onDetach :143-149 -> onDetachSeries :185-193 and delete() :336-340 never clear the generator. Only the modifier writes metadata fields in the library (rg of `metadata.X =`), so the frozen shared record is safe for library code. Mechanism on the append path is certain once the generator is installed -> S; per data update/message is a hot path per review.md section B -> high kept; the attach part alone is one-time. Corrections: (a) slot size is 4 bytes in Chrome under pointer compression, not 8 (why_it_costs, trade_off); (b) at attach only ONE temporary n-array is created (the mapped one becomes metadataProperty), the two temporaries are per append; (c) the attach scan's per-point cost includes validateIndex -> count() -> xValues.size() Wasm call (BaseDataSeries.js:801,1230,551); (d) custom filters copy metadata REFERENCES, not objects (XyCustomFilter.js:76), and do so per appended point via filterOnAppend :42; (e) appendN path added; (f) fix_diff now lists every write site (selectManyPoints :402/:411, selectSinglePoint :457/:463 using ht.associatedSeries.dataSeries + ht.dataSeriesIndex, selectPoint :502), returns early for a false write to UNSELECTED, adds `type` for the IMetadataGenerator typing; (g) trade_off adds the custom-filter shared-reference semantic change and broadens the frozen-write breakage to any field; (h) app_workaround notes a shared non-frozen generator is not a workaround (the modifier would select every point).

