# 062 · Heatmap data series re-normalizes every cell in a JS double loop after any change, including one setZValue or an xStart/xStep change that leaves z untouched

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Model/BaseHeatmapDataSeries.js:355` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | SC-09, V8-01 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
        if (this.hasDataChangesProperty ||
            size !== this.normalizedVector.size() ||
            colorMap.minimum !== this.lastZMin ||
            colorMap.maximum !== this.lastZMax ||
            fillValuesOutOfRange !== this.lastFillValuesOutOfRange) {
            this.recreateNormalizedVector(colorMap.minimum, colorMap.maximum, fillValuesOutOfRange);
```

## Call path and frequency

app setZValue (esm/Charting/Model/BaseHeatmapDataSeries.js:172) or a UniformHeatmapDataSeries xStart/xStep/yStart/yStep setter (esm/Charting/Model/UniformHeatmapDataSeries.js:45-86) -> notifyDataChanged (BaseHeatmapDataSeries.js:340-342) -> next frame UniformHeatmapDrawingProvider.draw (esm/Charting/Visuals/RenderableSeries/DrawingProviders/UniformHeatmapDrawingProvider.js:79) -> getNormalizedVector (:350-364) -> recreateNormalizedVector (:373-406). Rate: once per frame after any change.

## Why it costs

The dirty state is one boolean, so a single changed cell, or a change that does not touch z at all, costs a full O(W x H) JS normalization pass and a re-copy of the float vector. Whole-array replacement needs the full pass anyway; sparse and geometry-only changes do not.

**Scale where it matters:** Heatmaps of 512x512 to 2000x2000 (0.25M-4M cells) with sparse live updates (a few setZValue calls per frame) or a heatmap scrolled by xStart. Every frame re-normalizes every cell in JS. Changing colorMap minimum/maximum each frame triggers the same full pass.

## Fix (library side)

```diff
--- a/esm/Charting/Model/UniformHeatmapDataSeries.js
+++ b/esm/Charting/Model/UniformHeatmapDataSeries.js
     set xStart(value) {
         this.xStartProperty = value;
-        this.notifyDataChanged(EDataChangeType.Update);
+        this.notifyDataChanged(EDataChangeType.Property); // geometry only: z is unchanged
     }
 (same for xStep, yStart, yStep)
--- a/esm/Charting/Model/BaseHeatmapDataSeries.js
+++ b/esm/Charting/Model/BaseHeatmapDataSeries.js
@@ notifyDataChanged(changeType, xIndex, yIndex, name) {
         this.changeCountProperty++;
-        this.hasDataChangesProperty = true;
+        if (changeType !== EDataChangeType.Property || name === "hasNaNs") {
+            this.hasDataChangesProperty = true; // hasNaNs changes the normalization offset
+        }
@@ setZValue(yIndex, xIndex, zValue, metadata) {
         this.zValuesProperty[yIndex][xIndex] = zValue;
         this.setMetadataAt(yIndex, xIndex, metadata);
+        if (!this.hasDataChangesProperty) (this.dirtyCells ??= []).push(yIndex * this.arrayWidth + xIndex);
-        this.notifyDataChanged(EDataChangeType.Update, xIndex, yIndex);
+        this.changeCountProperty++;
+        this.dataChanged.raiseEvent({ changeType: EDataChangeType.Update, index: xIndex, yIndex });
     }
@@ getNormalizedVector: when only dirtyCells are pending and size/colorMap/fill are unchanged,
+        // write just those cells through a Float32Array view of normalizedVector, then clear dirtyCells;
+        // fall back to recreateNormalizedVector when dirtyCells.length > size / 8
```

**Trade-off:** Adds a dirty-cell list and a size threshold above which the full pass runs. Property notifications that do affect normalization (hasNaNs) must still set the flag. zRange should get its own z change counter so geometry changes stop invalidating it. The drawing provider still re-uploads the texture on every draw; that is a separate issue in the drawing-provider slice.

## App-side workaround

Scroll with the X axis visibleRange instead of xStart, and keep colorMap minimum/maximum fixed while streaming. There is no workaround for sparse cell updates: any change triggers the full pass.

## Verify

measure.md#fps, scenario "stream": a 1000x1000 UniformHeatmapDataSeries with 100 setZValue calls per frame for 10 s, then a second scenario that changes xStart every frame. 5 runs per side. Pass: "win" on frameP95Ms, and recreateNormalizedVector self time drops in the trace-summary window.

## Other locations

- `esm/Charting/Model/BaseHeatmapDataSeries.js:342` — notifyDataChanged sets hasDataChangesProperty for every change type, including Property
- `esm/Charting/Model/BaseHeatmapDataSeries.js:172` — setZValue changes one cell but marks the whole grid dirty
- `esm/Charting/Model/BaseHeatmapDataSeries.js:389` — recreateNormalizedVector: W x H nested loop over number[][] plus one memCopyFloat32 per row
- `esm/Charting/Model/UniformHeatmapDataSeries.js:47` — The xStart setter (and xStep :60, yStart :73, yStep :86) changes only geometry but triggers the same full pass, and also invalidates the O(W x H) zRange cache keyed on changeCount

## Review notes

- Found by reviewer slice `s08-data-series`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

