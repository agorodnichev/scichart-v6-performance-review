# 058 · Data-label generation makes 2-3 native GetLineBounds allocations per label per frame, and they are loop-invariant in TextDataLabelProvider

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/DataLabels/DataLabelProvider.js:411` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (pan, zoom or streaming with data labels or FastTextRenderableSeries) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
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
+    /** Reads line 0 of this.textBounds once per measurement; the generate loops call it right after each measure */
+    readFirstLine() {
+        const lb = this.textBounds.GetLineBounds(0);
+        this.firstLineHeight = lb.m_fHeight;
+        this.firstLineOffsetY = lb.m_fOffsetY;
+        lb.delete();
+        this.firstLineValid = true;
+    }
+    /** First-line height of textBounds: the cached value inside a generate loop, else a native read */
+    firstLineHeightOf(textBounds) {
+        if (this.firstLineValid && textBounds === this.textBounds) return this.firstLineHeight;
+        const lb = textBounds.GetLineBounds(0);
+        const h = lb.m_fHeight;
+        lb.delete();
+        return h;
+    }
--- a/esm/Charting/Visuals/RenderableSeries/DataLabels/DataLabelProvider.js
+++ b/esm/Charting/Visuals/RenderableSeries/DataLabels/DataLabelProvider.js
@@ generateDataLabels (:392-430)
         const skipNum = Math.max(0, this.skipNumberProperty);
+        try {
         for (let i = this.state.indexStart; i <= this.state.indexEnd; i += skipNum + 1) {
             ...
             this.state.font.CalculateStringBounds(text !== null && text !== void 0 ? text : "", this.textBounds, this.getLineSpacing());
+            this.readFirstLine(); // the only native line-bounds read for this label
             const { position, rotationAngle, rotationCenter } = this.getPosition(this.state, this.textBounds);
             const color = this.getColor(this.state, text);
-            const lineBounds = this.textBounds.GetLineBounds(0);
-            const firstLineHeight = lineBounds.m_fHeight;
-            lineBounds.delete();
+            const firstLineHeight = this.firstLineHeight;
             ...
         }
+        } finally {
+            this.firstLineValid = false; // getPosition called outside the loop reads natively again
+        }
@@ getPositionForPoint (:438)
-        const pos = getNativeTextPosition(x, y, h, v, textBounds, this.getPadding());
+        const firstLine = this.firstLineValid && textBounds === this.textBounds
+            ? { m_fHeight: this.firstLineHeight, m_fOffsetY: this.firstLineOffsetY }
+            : undefined;
+        const pos = getNativeTextPosition(x, y, h, v, textBounds, this.getPadding(), firstLine);
--- a/esm/utils/text.js
+++ b/esm/utils/text.js
@@ getTextHeightToBaseline (:139)
-export const getTextHeightToBaseline = (textBounds) => {
+export const getTextHeightToBaseline = (textBounds, firstLine) => {
     const cnt = textBounds.GetLinesCount();
     ...
     else if (cnt === 1) {
+        if (firstLine) return getFirstLineHeightToBaseline(firstLine);
         const lineBounds = textBounds.GetLineBounds(0);
@@ getNativeTextPosition (:183)
-export const getNativeTextPosition = (x, y, horizontalAnchorPoint, verticalAnchorPoint, textBounds, padding) => {
+export const getNativeTextPosition = (x, y, horizontalAnchorPoint, verticalAnchorPoint, textBounds, padding, firstLine) => {
@@ (:195-196)
     const isMultiline = textBounds.GetLinesCount() > 1;
-    const lineBounds = textBounds.GetLineBounds(0);
+    // A single-line label anchored at the bottom (the default 'Above' position) never uses line 0
+    const needsLine = isMultiline ||
+        verticalAnchorPoint === EVerticalAnchorPoint.Center ||
+        verticalAnchorPoint === EVerticalAnchorPoint.Top;
+    const lineBounds = firstLine !== null && firstLine !== void 0
+        ? firstLine
+        : needsLine ? textBounds.GetLineBounds(0) : undefined;
@@ (:224)
-    lineBounds.delete();
+    if (!firstLine && lineBounds) lineBounds.delete();
--- a/esm/Charting/Visuals/RenderableSeries/DataLabels/LineSeriesDataLabelProvider.js
+++ b/esm/Charting/Visuals/RenderableSeries/DataLabels/LineSeriesDataLabelProvider.js
@@ getPosition, aboveBelow branch (:40-42)
-            const lineBounds = textBounds.GetLineBounds(0);
-            // Handle multiline
-            const yOffset = textBounds.m_fHeight - lineBounds.m_fHeight;
-            lineBounds.delete();
+            // Handle multiline
+            const yOffset = textBounds.m_fHeight - this.firstLineHeightOf(textBounds);
@@ going up (:56)
-                    y += getTextHeightToBaseline(textBounds) + this.yAdj + ...;
+                    const firstLine = this.firstLineValid && textBounds === this.textBounds
+                        ? { m_fHeight: this.firstLineHeight, m_fOffsetY: this.firstLineOffsetY }
+                        : undefined;
+                    y += getTextHeightToBaseline(textBounds, firstLine) + this.yAdj + ...;
(the same firstLineHeightOf replacement in ColumnSeriesDataLabelProvider.js:63, StackedColumnSeriesDataLabelProvider.js:107,
 BubbleSeriesDataLabelProvider.js:20, RectangleSeriesDataLabelProvider.js:25 (plus the getTextHeightToBaseline call at :32 as above),
 and Polar/DataLabels/PolarColumnSeriesDataLabelProvider.js:132 and :198-200, which also removes the undeleted read of issue 007)
--- a/esm/Charting/Visuals/RenderableSeries/DataLabels/TextDataLabelProvider.js
+++ b/esm/Charting/Visuals/RenderableSeries/DataLabels/TextDataLabelProvider.js
@@ generateDataLabels, after the initial measure (:427-432)
+        this.readFirstLine(); // with calcBounds false these bounds stay unchanged for the whole loop
+        try {
@@ loop (:459)
-            const index = indexes.get(this.state.getIndexInternal());
+            // same Float64Array view over pointSeries.indexes that DataLabelState already reads in this loop
+            const index = this.state.indexes[this.state.getIndexInternal()];
@@ after each re-measure (:493 and :502)
                     this.state.font.CalculateStringBounds(text, bounds, this.getLineSpacing());
+                    this.readFirstLine();
@@ (:505-508)
             const position = this.getPosition(this.state, bounds);
-            const lineBounds = bounds.GetLineBounds(0);
-            const firstLineHeight = lineBounds.m_fHeight;
-            lineBounds.delete();
+            const firstLineHeight = this.firstLineHeight;
@@ after the loop
+        } finally {
+            this.firstLineValid = false;
+        }
         this.onAfterGenerate(this.dataLabels);
@@ getPosition(state, textBounds) (:346-348)
-        const lineBounds = textBounds.GetLineBounds(0);
-        const yOffset = textBounds.m_fHeight - lineBounds.m_fHeight;
-        lineBounds.delete();
+        const yOffset = textBounds.m_fHeight - this.firstLineHeightOf(textBounds);
```

**Trade-off:** Adds three fields of per-loop state to the provider (firstLineHeight, firstLineOffsetY, firstLineValid). firstLineHeightOf and the firstLine argument fall back to the native read when getPosition is called with other bounds or outside the loop, so user overrides of getPosition keep working; an override that re-measures into this.textBounds itself and then calls super.getPosition would get the stale cached height, so the cache must be documented. Reading indexes through the DataLabelState view relies on wasm memory not growing inside the loop, which the loop already relies on for xCoord/yCoord, and the fix removes most of the per-label mallocs that could grow it. Label positions are unchanged: the same value is read once instead of 2-3 times. The fix does not reduce the number of labels that are generated and then dropped. Doing that inside the library (an automatic stride from pointGap and the first label's width, both already computed in shouldGenerate) would change which labels survive on steep data, so it would need an opt-in.

## App-side workaround

Bound the label count as SC-21 says: pointCountThreshold, pointGapThreshold and skipNumber on dataLabels. For text series keep calculateTextBounds false, use horizontal/vertical positions Right/Above (so no per-label measure), and set useNativeStringDraw for string columns. Removing the duplicate GetLineBounds calls themselves needs a provider subclass that overrides getPosition.

## Verify

measure.md#fps 'zoom' scenario, 5 runs per side: (a) FastTextRenderableSeries with 5k visible labels; (b) FastLineRenderableSeries with LineSeriesDataLabelProvider on 2k visible points. Pass: compare-runs 'win' on frameP95Ms; a dev counter of GetLineBounds calls per frame equals 1 per label in (b) and 1 per frame in (a); a screenshot diff shows identical label positions.

## Other locations

- `esm/utils/text.js:196` — getNativeTextPosition: GetLineBounds read #1, made even for a single-line bottom-anchored label (the default Above position) where it is unused
- `esm/Charting/Visuals/RenderableSeries/DataLabels/LineSeriesDataLabelProvider.js:40` — read #1 for line labels; :56 getTextHeightToBaseline -> utils/text.js:145 read #3 on rising segments
- `esm/Charting/Visuals/RenderableSeries/DataLabels/TextDataLabelProvider.js:346` — getPosition read, loop-invariant when calcBounds is false
- `esm/Charting/Visuals/RenderableSeries/DataLabels/TextDataLabelProvider.js:506` — second loop-invariant read per label
- `esm/Charting/Visuals/RenderableSeries/DataLabels/TextDataLabelProvider.js:477` — indexes.get() embind call per label; DataLabelState.js:28 already holds an indexes view
- `esm/Charting/Visuals/RenderableSeries/DataLabels/ColumnSeriesDataLabelProvider.js:63` — same duplicate read in the getPosition override
- `esm/Charting/Visuals/RenderableSeries/DataLabels/StackedColumnSeriesDataLabelProvider.js:107` — same duplicate read; plus topVector/bottomVector get() per label at :87-88
- `esm/Charting/Visuals/RenderableSeries/DataLabels/RectangleSeriesDataLabelProvider.js:25` — same duplicate read; :32 getTextHeightToBaseline adds a third
- `esm/Charting/Visuals/RenderableSeries/Polar/DataLabels/PolarColumnSeriesDataLabelProvider.js:132` — same duplicate read; :198-199 reads twice and leaks one (issue 007)
- `esm/Charting/Visuals/RenderableSeries/DataLabels/HeatMapDataLabelProvider.js:161` — one read per visible cell, not duplicated (getPosition takes a Size); also NonUniformHeatmapDataLabelProvider.js:106 and ContoursDataLabelProvider.js:210; not changed by the fix

## Review notes

- Found by reviewer slice `s05-labels-hittest-anim`.
- Adversarial verification (corrected): Re-read DataLabelProvider.js:392-430 (code_quote matches verbatim at :408-413, GetLineBounds at :411), utils/text.js:139-150 and :183-224, LineSeriesDataLabelProvider.js:34-62, TextDataLabelProvider.js:334-360 and :405-519, the Column/StackedColumn/Bubble/Rectangle/PolarColumn getPosition overrides, and the embind glue (_glue-pretty/scichart.js:3739-3757 attachFinalizer, :4256-4268 makeClassHandle, :3803 delete -> detachFinalizer). Call chain confirmed: SciChartRenderer.js:354/670 rs.draw -> BaseRenderableSeries.js:645 dataLabelProvider.generateDataLabels on every draw, no dirty flag or reuse -> DataLabelProvider.js:393 loop -> :408 CalculateStringBounds -> :409 getPosition (:342-343) -> :436-438 getPositionForPoint -> utils/text.js:196 GetLineBounds #1 -> DataLabelProvider.js:411 #2. LineSeriesDataLabelProvider (aboveBelow default true) replaces #1 with :40, and :56 getTextHeightToBaseline -> text.js:145 adds #3 on rising segments; RectangleSeriesDataLabelProvider has the same #3 via :32. Default pointGapThreshold 0 and pointCountThreshold Infinity (DataLabelProvider.js:45-46) mean shouldGenerate does not bound the loop. TextDataLabelProvider: shouldGenerate returns true (:398-400); calcBounds is false by default (:56, :421-423), so bounds are measured once at :428/:431 and both reads (:346 and :506) are loop-invariant; :477 indexes.get per label while DataLabelState.js:28 already holds the view. FastTextRenderableSeries.needsResampling (:110-116) only resamples (mode None) for FIFO, so all visible points are labelled. Each GetLineBounds returns a by-value embind class: malloc + handle (Object.create + $$ record + count) and delete() -> free + FinalizationRegistry.unregister; no register because the handle has no smartPtr. Mechanism certain, per label per render -> S. Kept medium: the duplicated reads are a constant factor on top of per-label work the library already does (formatting, CalculateStringBounds, Rect), not the dominant data-label cost. Corrections: (1) the fix did not remove read #3 (getTextHeightToBaseline on rising line segments and in Rectangle), so its verify claim of 1 read per label in scenario (b) was false; added an optional firstLine argument to getTextHeightToBaseline. (2) getNativeTextPosition reads line 0 even for a single-line bottom-anchored label (the default Above position), where it is unused; made that read conditional, which also helps callers outside the loop (BandSeriesDataLabelProvider.js:68, WebGlRenderContext2D.js:499, NativeTextAnnotation.js:371). (3) The fix claimed SC-06 for indexes.get but did not change it; added the view read. (4) Wrapped the loops in try/finally so an exception in a user getText/getColor cannot leave the cache valid. (5) other_locations: the PolarColumn path is Polar/DataLabels/PolarColumnSeriesDataLabelProvider.js; HeatMap/NonUniformHeatmap/Contours do one read per cell (not a duplicate) and the fix leaves them alone.

