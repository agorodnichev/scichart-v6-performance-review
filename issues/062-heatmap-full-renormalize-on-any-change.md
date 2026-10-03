# 062 · Heatmap data series re-normalizes every cell in a JS double loop after any change, including one setZValue or an xStart/xStep change that leaves z untouched

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Model/BaseHeatmapDataSeries.js:355` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/4cdd9a657ddecb049c8213cee8b5485d/): reproduced on WebGL and WebGPU ([source](../demos/062-heatmap-full-renormalize-on-any-change/)) |
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
--- a/esm/Charting/Model/BaseHeatmapDataSeries.js
+++ b/esm/Charting/Model/BaseHeatmapDataSeries.js
 import { memCopyFloat32 } from "../../utils/ccall/appendDoubleVectorFromJsArray";
+import { vectorToArrayViewF32 } from "../../utils/vectorToArray";
@@ module scope
+// The per-cell body of recreateNormalizedVector, shared so the full and the sparse paths stay identical.
+const normalizeZ = (zValueRaw, zMin, zMax, newZMin, factor, fill) => {
+    let zValue = zValueRaw - newZMin;
+    if (zValueRaw !== zValueRaw) zValue = 0;
+    else if (zValue < zMin - newZMin) zValue = fill ? zMin - newZMin : 0;
+    else if (zValue > zMax - newZMin) zValue = fill ? zMax - newZMin : 0;
+    return zValue * factor;
+};
@@ constructor
         this.hasDataChangesProperty = false;
+        /** Flat indexes (y * arrayWidth + x) written by setZValue since the last normalization. */
+        this.dirtyCells = [];
+        /** One-shot: the next notifyDataChanged leaves the normalized z values valid. */
+        this.zUnchangedNotify = false;
@@ setZValue(yIndex, xIndex, zValue, metadata) {
         this.zValuesProperty[yIndex][xIndex] = zValue;
         this.setMetadataAt(yIndex, xIndex, metadata);
+        if (!this.hasDataChangesProperty && this.dirtyCells.length < (this.arrayWidth * this.arrayHeight) / 8) {
+            this.dirtyCells.push(yIndex * this.arrayWidth + xIndex);
+            this.zUnchangedNotify = true; // tracked cell: no full pass
+        }
         this.notifyDataChanged(EDataChangeType.Update, xIndex, yIndex);
     }
@@ notifyDataChanged(changeType, xIndex, yIndex, name) {
         this.changeCountProperty++;
-        this.hasDataChangesProperty = true;
+        if (this.zUnchangedNotify) {
+            this.zUnchangedNotify = false; // consumed before the event, so a re-entrant notify is a full change
+        } else {
+            this.hasDataChangesProperty = true;
+            this.dirtyCells.length = 0; // the full pass covers them
+        }
         this.dataChanged.raiseEvent({ changeType, index: xIndex, yIndex, name });
     }
@@ getNormalizedVector(colorMap, fillValuesOutOfRange) {
             this.hasDataChangesProperty = false;
-        }
+        } else if (this.dirtyCells.length > 0) {
+            this.updateNormalizedCells(colorMap.minimum, colorMap.maximum, fillValuesOutOfRange);
+        }
+        this.dirtyCells.length = 0;
         return this.normalizedVector;
     }
+    /** Re-normalizes only the cells setZValue changed; colorMap, fill and size equal the last full pass here. */
+    updateNormalizedCells(zMin, zMax, fillValuesOutOfRange) {
+        const newZMin = this.hasNaNs ? zMin - (zMax - zMin) / 128 : zMin;
+        const factor = 1.0 / (zMax - newZMin);
+        const view = vectorToArrayViewF32(this.normalizedVector, this.webAssemblyContext); // no wasm allocation below
+        const w = this.arrayWidth;
+        for (const cell of this.dirtyCells) {
+            const y = (cell / w) | 0;
+            view[cell] = normalizeZ(this.zValuesProperty[y][cell - y * w], zMin, zMax, newZMin, factor, fillValuesOutOfRange);
+        }
+    }
@@ recreateNormalizedVector inner loop
-                const zValueRaw = this.zValuesProperty[y][x];
-                let zValue = zValueRaw - newZMin;
-                ... (NaN and out-of-range branches)
-                const normalizedZValue = zValue * normalizationFactor;
-                rowArray[x] = normalizedZValue;
+                rowArray[x] = normalizeZ(this.zValuesProperty[y][x], zMin, zMax, newZMin, normalizationFactor, fillValuesOutOfRange);
--- a/esm/Charting/Model/UniformHeatmapDataSeries.js
+++ b/esm/Charting/Model/UniformHeatmapDataSeries.js
     set xStart(value) {
         this.xStartProperty = value;
+        this.zUnchangedNotify = true; // geometry only: same Update event, x/yRange still recomputed, z stays normalized
         this.notifyDataChanged(EDataChangeType.Update);
     }
 (same for xStep, yStart, yStep)
```

**Trade-off:** Adds a dirty-cell list (at most 1/8 of the cells, then it falls back to the full pass) and a one-shot flag. The public hasDataChanges getter no longer turns true for geometry-only changes or tracked single-cell writes. Geometry changes still bump changeCount, so the O(W x H) zRange cache (BaseHeatmapDataSeries.js:242-247) is still invalidated; giving zRange its own z counter fixes that. Apps that mutate zValues in place and call notifyDataChanged() still get the full pass, which they need. The drawing provider still re-uploads the whole texture on every draw (UniformHeatmapDrawingProvider.js:80); that is a separate issue in the drawing-provider slice.

## App-side workaround

Scroll with the X axis visibleRange instead of xStart, and keep colorMap minimum/maximum fixed while streaming. There is no workaround for sparse cell updates: any change triggers the full pass.

## Verify

measure.md#fps, scenario "stream": a 1000x1000 UniformHeatmapDataSeries with 100 setZValue calls per frame for 10 s, then a second scenario that changes xStart every frame. 5 runs per side. Pass: "win" on frameP95Ms, and recreateNormalizedVector self time drops in the trace-summary window.

## Other locations

- `esm/Charting/Model/BaseHeatmapDataSeries.js:342` — notifyDataChanged sets hasDataChangesProperty for every change type, including Property
- `esm/Charting/Model/BaseHeatmapDataSeries.js:172` — setZValue changes one cell but marks the whole grid dirty
- `esm/Charting/Model/BaseHeatmapDataSeries.js:373` — recreateNormalizedVector: W x H nested loop over number[][] plus one memCopyFloat32 per row
- `esm/Charting/Model/UniformHeatmapDataSeries.js:47` — The xStart setter (and xStep :60, yStart :73, yStep :86) changes only geometry but triggers the same full pass, and also invalidates the O(W x H) zRange cache keyed on changeCount

## Review notes

- Found by reviewer slice `s08-data-series`.
- Adversarial verification (corrected): Quote matches BaseHeatmapDataSeries.js:355-360 verbatim. Confirmed the single dirty flag: notifyDataChanged :340-344 sets hasDataChangesProperty for every change type; setZValue :172-176, the hasNaNs setter :271-273 (Property) and dataSeriesName :260 (Property) all go through it; UniformHeatmapDataSeries xStart/xStep/yStart/yStep setters :45-87 call notifyDataChanged(Update) through the override at :107-111. Consumer: UniformHeatmapDrawingProvider.draw (:62) -> getNormalizedVector (:79) every draw, then recreateNormalizedVector :373-408 (W x H loop over number[][] plus one memCopyFloat32 per row) whenever the flag is set; PolarHeatmapDrawingProvider.js:16 and UniformContoursDrawingProvider.js:66 do the same. The redraw path (BaseRenderableSeries.dataSeriesDataChanged :1353-1358) invalidates on any change type. zRange (:242-247) is keyed on changeCount, so geometry changes invalidate it too. Rate: one full pass per frame that follows any change; sparse setZValue and geometry-only setters need none. Severity medium kept: a streaming per-frame cost, but the documented in-place update (mutate zValues, notifyDataChanged) needs the full pass anyway, and the texture re-upload each draw is a separate O(W x H) cost. Evidence S. Corrected the fix diff, which had a bug: UniformHeatmapDataSeries.notifyDataChanged(updateType, data) (:107-111) forwards only two arguments, so the proposed name === "hasNaNs" test in the base would never see the name and a hasNaNs change would stop re-normalizing. It also changed the event type seen by dataChanged subscribers to Property and used ??=, which the ES2017-style build does not emit. The new diff keeps the Update event, uses a one-shot flag consumed before the event is raised, bounds the dirty-cell list at 1/8 of the cells (clearing it when a full pass is pending, so NonUniform series that never call getNormalizedVector stay bounded), and shares one per-cell normalize function between both paths. other_locations: recreateNormalizedVector moved from :389 to :373.

