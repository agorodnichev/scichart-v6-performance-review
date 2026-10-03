# 007 · Radial (vertical) PolarColumn data labels leak one native TSRTextLineBounds per label on every render

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/Polar/DataLabels/PolarColumnSeriesDataLabelProvider.js:199` |
| Severity | **high** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory (wasm heap growth per render) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/6c6ce13d5c960239c4cd1e12dabb597c/): reproduced on WebGL and WebGPU ([source](../demos/007-polar-column-label-leaks-linebounds/)) |
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

TSRTextBounds.GetLineBounds allocates a new TSRTextLineBounds in the wasm heap on every call. It returns an owning raw-pointer handle (ptrType 'TSRTextLineBounds*', no smartPtr), and the caller must call delete() on it. Every other call site in the package does so. Line 199 makes a second call inline and drops the handle. The glue's FinalizationRegistry registers only smart-pointer handles (_glue-pretty/scichart.js:3747-3753 attachFinalizer), so GC never releases this raw handle either. A Node probe on the package's own glue and wasm showed consecutive GetLineBounds results 24 bytes apart that are never reused unless delete() is called. Result: one 24-byte native allocation leaks per generated label per render, plus a short-lived JS handle object, for as long as the chart renders. The wasm heap only grows (SC-33: a full heap throws out-of-memory).

**Scale where it matters:** Leak count = generated labels per render x renders, at 24 bytes each in the wasm heap. Example: 24 labelled radial bars through a 3 s start-up animation at 60 Hz = about 4,300 leaked objects (about 100 KB). After that, 24 more leak on every zoom, pan, data update or other redraw. A streaming or continuously animated radial column chart with 100 labels at 60 Hz leaks about 140 KB per second (about 500 MB per hour). Nothing ever frees them, and the wasm heap never shrinks.

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
- Adversarial verification (corrected): Re-read Polar/DataLabels/PolarColumnSeriesDataLabelProvider.js:72-205. The code_quote matches lines 198-200 verbatim, and the second GetLineBounds(0) is at :199. Its handle is never deleted; the first handle (:198) is the one deleted at :200. The horizontal branch (:132-134) reads once and deletes correctly. Caller chain: SciChartRenderer.js:354 (and :670) rs.draw -> BaseRenderableSeries.draw :645 dataLabelProvider.generateDataLabels. Neither FastRectangleRenderableSeries nor PolarColumnRenderableSeries overrides draw. -> DataLabelProvider.js:379 generateDataLabels. Its guards are isEnabled plus style.fontFamily and fontSize (:382), non-empty yValues (:386) and shouldGenerate (:390: pointCountThreshold and pointGap). -> loop :394 per index in [indexStart, indexEnd] -> getText (:405, skipped when empty) -> getPosition :409, before shouldSkipLabel (:423). state.isVerticalChart is renderPassData.isVerticalChart (DataLabelState.js:136-137). That is xAxis.isVerticalChart (SciChartRenderer.js:641), and PolarAxisBase.js:376-377 returns isXAxis && !isAngular. So any polar column chart with the X axis on the radial axis takes the leaking else-branch. The default provider is wired at PolarColumnRenderableSeries.js:53. MECHANISM PROBED: in Node I loaded the package's own _glue/scichart.js and _wasm/scichart.wasm (DOM shim) and called new TSRTextBounds().GetLineBounds(0). Each call returned a fresh handle whose ptrType is 'TSRTextLineBounds*' (raw pointer, no smartPtr), and consecutive addresses stepped by 24 bytes. 200,000 calls without delete() moved the address by 4.8 MB and grew HEAPU8 from 52.7 MB to 63.2 MB. With delete() after each call, every call reused the same address. The glue's attachFinalizer (_glue-pretty/scichart.js:3739-3753) registers only handles that have a smartPtr, so GC never frees these. The leak is therefore certain. The rule (SC-29 family: delete what you allocate) has no Avoid clause that excuses this. The fix diff is correct and minimal: it reuses the already-fetched lineBounds, so the value is identical. Severity stays high: the leak grows with every render of a labelled radial polar column series (each zoom, pan, data update and animation frame). Evidence stays S: the probe confirms the native mechanism, but the end-to-end chart path was not measured. CORRECTED: why_it_costs now states that the binding returns a raw-pointer handle (not a by-value copy, per the probe) and gives the 24-byte per-call allocation. scale now gives a byte estimate.

