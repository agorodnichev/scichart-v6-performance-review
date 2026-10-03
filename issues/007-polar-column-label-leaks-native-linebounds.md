# 007 · Radial (vertical) PolarColumn data labels leak one native TSRTextLineBounds per label on every render

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/Polar/DataLabels/PolarColumnSeriesDataLabelProvider.js:199` |
| Severity | **high** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory (wasm heap growth per render) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | none (wasm-heap object lifetime; closest SC-29 / LIFE-10) (web-performance skill) |
| Effort to fix | small |

## Code

```js
            const lineBounds = textBounds.GetLineBounds(0);
            const yOffset = textBounds.m_fHeight - textBounds.GetLineBounds(0).m_fHeight;
            lineBounds.delete();
```

## Call path and frequency

Charting/Services/SciChartRenderer.js:354 (or :670) rs.draw -> Charting/Visuals/RenderableSeries/BaseRenderableSeries.js:645 dataLabelProvider.generateDataLabels (PolarColumnRenderableSeries extends FastRectangleRenderableSeries extends BaseRenderableSeries; the provider is created by default at Polar/PolarColumnRenderableSeries.js:53) -> DataLabels/DataLabelProvider.js:394 per-visible-point loop -> :409 this.getPosition -> Polar/DataLabels/PolarColumnSeriesDataLabelProvider.js:72 getPosition -> else branch taken when state.isVerticalChart (radial X axis, Charting/Visuals/Axis/Polar/PolarAxisBase.js:376-377 isXAxis && !isAngular) -> :199 leaked GetLineBounds(0). Runs once per generated label (before shouldSkipLabel) per render of each labelled radial polar column series.

## Why it costs

TSRTextBounds.GetLineBounds returns TSRTextLineBounds by value: embind copies it into a new native heap allocation and gives JS an owning raw-pointer handle. Every other call site in the package calls delete() on the result, which is only valid for an owned copy. Line 199 makes a second call inline and drops the handle. The glue's FinalizationRegistry only registers smart-pointer handles (_glue-pretty/scichart.js:3747-3753 attachFinalizer), so this raw handle is never released on GC either. Result: one native allocation (16 bytes of fields plus malloc overhead) leaks per label per frame, plus a short-lived JS handle object, for as long as the chart renders.

**Scale where it matters:** Leak count = generated labels per render x renders. Example: 24 labelled radial bars through a 3 s start-up animation at 60 Hz = about 4,300 leaked objects, then 24 more on every zoom, pan, data update or other redraw. Nothing ever frees them, and the wasm heap never shrinks.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/Polar/DataLabels/PolarColumnSeriesDataLabelProvider.js
+++ b/esm/Charting/Visuals/RenderableSeries/Polar/DataLabels/PolarColumnSeriesDataLabelProvider.js
@@ getPosition(state, textBounds) { ... else { // vertical chart
             x -= textBounds.m_fWidth / 2;
             const lineBounds = textBounds.GetLineBounds(0);
-            const yOffset = textBounds.m_fHeight - textBounds.GetLineBounds(0).m_fHeight;
+            const yOffset = textBounds.m_fHeight - lineBounds.m_fHeight;
             lineBounds.delete();
```

**Trade-off:** None. The value used is identical; the fix also removes one native round trip per label.

## App-side workaround

Use the horizontal polar layout (angular X axis) for labelled polar columns, or pass a dataLabelProvider subclass of PolarColumnSeriesDataLabelProvider whose getPosition re-implements the vertical branch with a single GetLineBounds(0) followed by delete(). Turning off data labels on radial column charts also avoids the leak.

## Verify

measure.md#mem: radial polar column chart (X on the radial axis) with 24 bars and dataLabels.style.fontSize set; one action = 60 forced renders (for example one zoom step per frame). Add a dev-only counter that wraps wasmContext.TSRTextBounds.prototype.GetLineBounds and counts returned handles minus delete() calls. Run 10 actions, then S1 -> S2. Pass: created minus deleted stays 0 after each action and the wasm heap size (HEAPU8.byteLength) slope is within noise. Before the fix the counter grows by labels x renders.

## Other locations

- `_glue-pretty/scichart.js:3747` — attachFinalizer registers only handles with a smartPtr, so an undeleted by-value handle is never auto-released
- `esm/Charting/Visuals/RenderableSeries/Polar/DataLabels/PolarColumnSeriesDataLabelProvider.js:132` — the horizontal branch reads the line bounds once and deletes them correctly, for comparison
- `esm/Charting/Visuals/RenderableSeries/Polar/PolarColumnRenderableSeries.js:53` — default provider wiring: every PolarColumnRenderableSeries uses this provider

## Review notes

- Found by reviewer slice `s05-labels-hittest-anim`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

