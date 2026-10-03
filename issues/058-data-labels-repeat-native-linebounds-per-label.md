# 058 · Data-label generation makes 2-3 native GetLineBounds allocations per label per frame, and they are loop-invariant in TextDataLabelProvider

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/DataLabels/DataLabelProvider.js:411` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (pan, zoom or streaming with data labels or FastTextRenderableSeries) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | SC-21 (plus SC-06 for indexes.get per label) (web-performance skill) |
| Effort to fix | medium |

## Code

```js
            this.state.font.CalculateStringBounds(text !== null && text !== void 0 ? text : "", this.textBounds, this.getLineSpacing());
            const { position, rotationAngle, rotationCenter } = this.getPosition(this.state, this.textBounds);
            const color = this.getColor(this.state, text);
            const lineBounds = this.textBounds.GetLineBounds(0);
            const firstLineHeight = lineBounds.m_fHeight;
            lineBounds.delete();
```

## Call path and frequency

Charting/Services/SciChartRenderer.js:354/670 rs.draw -> Charting/Visuals/RenderableSeries/BaseRenderableSeries.js:645 generateDataLabels (every render, no reuse when data, ranges and style are unchanged) -> DataLabels/DataLabelProvider.js:394 loop over every visible (resampled) point -> :408 CalculateStringBounds -> :409 getPosition -> :436 getPositionForPoint -> utils/text.js:183 getNativeTextPosition (:195 GetLinesCount, :196 GetLineBounds #1) -> back at DataLabelProvider.js:411 GetLineBounds #2. LineSeriesDataLabelProvider.js:40 replaces #1, and :56 getTextHeightToBaseline -> utils/text.js:145 adds #3 when the line goes up. FastTextRenderableSeries -> TextDataLabelProvider.js:459 loop over every visible point (no resampling) -> :477 indexes.get() -> :505 getPosition (:346 GetLineBounds) -> :506 GetLineBounds. Frequency: per label per render of each labelled series.

## Why it costs

The first-line bounds of the label just measured are a property of that measurement, yet each consumer asks the engine again through a by-value accessor that allocates and frees a native object each time. In TextDataLabelProvider with calculateTextBounds false (the default, documented as 'maximum performance') the bounds are measured once before the loop and never change, so both reads per label are loop-invariant. indexes.get() adds one more embind call per label where DataLabelState already holds a view. With the default skip mode most of this per-label work belongs to labels that are dropped right afterwards; the library warns about that itself (DataLabelProvider.js:431-433, performanceWarnings.dataLabelsSkippingMany).

**Scale where it matters:** Per label: 2-3 GetLineBounds calls, each a JS->wasm call, a native malloc plus 3 JS objects for the handle, then a delete() call (wasm free + FinalizationRegistry.unregister). FastTextRenderableSeries with 5k visible labels: 10k alloc/free pairs plus 5k indexes.get per frame. A line series with labels on 2k visible resampled points: 4k-6k pairs per frame, before the default SkipIfOverlapPrevious mode discards most of those labels.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/DataLabels/BaseDataLabelProvider.js
+++ b/esm/Charting/Visuals/RenderableSeries/DataLabels/BaseDataLabelProvider.js
+    /** First-line height of textBounds; reuses the value read once per label inside generateDataLabels */
+    firstLineHeightOf(textBounds) {
+        if (this.firstLineValid && textBounds === this.textBounds) return this.firstLineHeight;
+        const lb = textBounds.GetLineBounds(0);
+        const h = lb.m_fHeight;
+        lb.delete();
+        return h;
+    }
+    readFirstLine() {
+        const lb = this.textBounds.GetLineBounds(0);
+        this.firstLineHeight = lb.m_fHeight;
+        this.firstLineOffsetY = lb.m_fOffsetY;
+        lb.delete();
+        this.firstLineValid = true;
+    }
--- a/esm/Charting/Visuals/RenderableSeries/DataLabels/DataLabelProvider.js
+++ b/esm/Charting/Visuals/RenderableSeries/DataLabels/DataLabelProvider.js
@@ generateDataLabels loop
             this.state.font.CalculateStringBounds(text !== null && text !== void 0 ? text : "", this.textBounds, this.getLineSpacing());
+            this.readFirstLine(); // the only native line-bounds read for this label
             const { position, rotationAngle, rotationCenter } = this.getPosition(this.state, this.textBounds);
             const color = this.getColor(this.state, text);
-            const lineBounds = this.textBounds.GetLineBounds(0);
-            const firstLineHeight = lineBounds.m_fHeight;
-            lineBounds.delete();
+            const firstLineHeight = this.firstLineHeight;
@@ after the loop
+        this.firstLineValid = false;
@@ getPositionForPoint
-        const pos = getNativeTextPosition(x, y, h, v, textBounds, this.getPadding());
+        const pos = getNativeTextPosition(x, y, h, v, textBounds, this.getPadding(), this.firstLineValid ? this.firstLineHeight : undefined, this.firstLineOffsetY);
--- a/esm/utils/text.js (getNativeTextPosition: optional precomputed first line)
-export const getNativeTextPosition = (x, y, horizontalAnchorPoint, verticalAnchorPoint, textBounds, padding) => {
+export const getNativeTextPosition = (x, y, horizontalAnchorPoint, verticalAnchorPoint, textBounds, padding, firstLineHeight, firstLineOffsetY) => {
-    const lineBounds = textBounds.GetLineBounds(0);
+    const lineBounds = firstLineHeight !== undefined
+        ? { m_fHeight: firstLineHeight, m_fOffsetY: firstLineOffsetY, delete() { } }
+        : textBounds.GetLineBounds(0);
--- a/esm/Charting/Visuals/RenderableSeries/DataLabels/LineSeriesDataLabelProvider.js (same in Column :63, StackedColumn :107, Bubble :20, Rectangle :25, PolarColumn :132)
-            const lineBounds = textBounds.GetLineBounds(0);
-            const yOffset = textBounds.m_fHeight - lineBounds.m_fHeight;
-            lineBounds.delete();
+            const yOffset = textBounds.m_fHeight - this.firstLineHeightOf(textBounds);
--- a/esm/Charting/Visuals/RenderableSeries/DataLabels/TextDataLabelProvider.js
@@ generateDataLabels, after the initial measure (:428-432)
+        this.readFirstLine(); // with calcBounds false the bounds stay those of the first label for the whole loop
@@ inside the loop, after each re-measure (:493 and :502)
                     this.state.font.CalculateStringBounds(text, bounds, this.getLineSpacing());
+                    this.readFirstLine();
@@
             const position = this.getPosition(this.state, bounds);
-            const lineBounds = bounds.GetLineBounds(0);
-            const firstLineHeight = lineBounds.m_fHeight;
-            lineBounds.delete();
+            const firstLineHeight = this.firstLineHeight;
@@ after the loop
+        this.firstLineValid = false;
@@ getPosition(state, textBounds)
-        const lineBounds = textBounds.GetLineBounds(0);
-        const yOffset = textBounds.m_fHeight - lineBounds.m_fHeight;
-        lineBounds.delete();
+        const yOffset = textBounds.m_fHeight - this.firstLineHeightOf(textBounds);
```

**Trade-off:** Adds three fields of per-loop state to the provider. firstLineHeightOf falls back to the native read when getPosition is called with other bounds or outside the loop, so user overrides of getPosition keep working. Label positions are unchanged: the same value is read once instead of 2-3 times. The fix does not reduce the number of labels that are generated and then dropped. Doing that inside the library (an automatic stride from pointGap and the first label's width, both already computed in shouldGenerate) would change which labels survive on steep data, so it would need an opt-in.

## App-side workaround

Bound the label count as SC-21 says: pointCountThreshold, pointGapThreshold and skipNumber on dataLabels. For text series keep calculateTextBounds false, use horizontal/vertical positions Right/Above (so no per-label measure), and set useNativeStringDraw for string columns. Removing the duplicate GetLineBounds calls themselves needs a provider subclass that overrides getPosition.

## Verify

measure.md#fps 'zoom' scenario, 5 runs per side: (a) FastTextRenderableSeries with 5k visible labels; (b) FastLineRenderableSeries with LineSeriesDataLabelProvider on 2k visible points. Pass: compare-runs 'win' on frameP95Ms; a dev counter of GetLineBounds calls per frame equals 1 per label in (b) and 1 per frame in (a); a screenshot diff shows identical label positions.

## Other locations

- `esm/utils/text.js:196` — getNativeTextPosition: GetLineBounds read #1 for default-positioned labels
- `esm/Charting/Visuals/RenderableSeries/DataLabels/LineSeriesDataLabelProvider.js:40` — read #1 for line labels; :56 getTextHeightToBaseline -> utils/text.js:145 read #3
- `esm/Charting/Visuals/RenderableSeries/DataLabels/TextDataLabelProvider.js:346` — getPosition read, loop-invariant when calcBounds is false
- `esm/Charting/Visuals/RenderableSeries/DataLabels/TextDataLabelProvider.js:506` — second loop-invariant read per label
- `esm/Charting/Visuals/RenderableSeries/DataLabels/TextDataLabelProvider.js:477` — indexes.get() embind call per label; DataLabelState already has an indexes view
- `esm/Charting/Visuals/RenderableSeries/DataLabels/ColumnSeriesDataLabelProvider.js:63` — same pattern
- `esm/Charting/Visuals/RenderableSeries/DataLabels/StackedColumnSeriesDataLabelProvider.js:107` — same pattern; plus topVector/bottomVector get() per label at :87-88
- `esm/Charting/Visuals/RenderableSeries/DataLabels/HeatMapDataLabelProvider.js:161` — same pattern per visible cell (also NonUniformHeatmapDataLabelProvider.js:106, ContoursDataLabelProvider.js:210)

## Review notes

- Found by reviewer slice `s05-labels-hittest-anim`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

