# 039 · PaletteFactory gradient palettes do an integer clamp through wasm (NumberUtil.Constrain) plus a wasm count() for every point on every frame

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Model/PaletteFactory.js:28` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | TASK-13 (web-performance skill) |
| Effort to fix | small |

## Code

```js
        const doFunc = (xValue, yValue, index, opacity = 1) => {
            const count = renderSeries.getDataSeriesValuesCount();
            const lerpFactor = index / (count - 1);
            const mapIndex = webAssemblyContext.NumberUtil.Constrain(Math.round(lerpFactor * (colorData.length - 1)), 0, colorData.length - 1);
            const result = colorData[mapIndex];
```

## Call path and frequency

BaseSeriesDrawingProvider.applyStrokePaletting (esm/Charting/Visuals/RenderableSeries/DrawingProviders/BaseSeriesDrawingProvider.js:148-156) -> palette.overrideStrokeArgb (PaletteFactory.js:45) -> doFunc (:25) -> renderSeries.getDataSeriesValuesCount() [embind size()] + webAssemblyContext.NumberUtil.Constrain [embind]. applyStrokeFillPaletting (:254-262) adds the fill call. PointMarkerDrawingProvider.js:129 -> overridePointMarkerArgb calls doFunc twice per marker. Rate: per visible point, per frame. The palette object defines no shouldUpdatePalette, so BaseSeriesDrawingProvider.js:393-394 recomputes every frame.

## Why it costs

Clamping an integer to [0, n] is two compare-and-select operations that V8 inlines. Routing it through an embind static call adds a boundary crossing per point, and the count lookup adds another, inside a loop that already reads typed-array views for x and y.

**Scale where it matters:** Any series using PaletteFactory.createGradient or createYGradient. Per frame: visible points x (1 for stroke + 1 for fill + 2 for markers) doFunc calls, each with 1-2 JS->wasm crossings.

## Fix (library side)

```diff
--- a/esm/Charting/Model/PaletteFactory.js
+++ b/esm/Charting/Model/PaletteFactory.js
@@ createGradient doFunc
-            const mapIndex = webAssemblyContext.NumberUtil.Constrain(Math.round(lerpFactor * (colorData.length - 1)), 0, colorData.length - 1);
+            const raw = Math.round(lerpFactor * (colorData.length - 1));
+            const mapIndex = raw > 0 ? Math.min(raw, colorData.length - 1) : 0; // NaN -> 0
@@ createYGradient doFunc
-            const mapIndex = webAssemblyContext.NumberUtil.Constrain(Math.round(lerpFactor * (colorData.length - 1)), 0, colorData.length - 1);
+            const raw = Math.round(lerpFactor * (colorData.length - 1));
+            const mapIndex = raw > 0 ? Math.min(raw, colorData.length - 1) : 0;
```

**Trade-off:** A NaN lerpFactor (count === 1, or a NaN y) now maps explicitly to index 0 instead of depending on the wasm int conversion. The per-point count() call remains. Hoisting it needs a per-frame hook, such as a shouldUpdatePalette() that caches the count and returns true, but the point-marker path may not call that hook.

## App-side workaround

Write your own gradient palette provider that clamps with Math.min/Math.max and caches the count in shouldUpdatePalette(). Or precompute the colors once into metadata.

## Verify

measure.md#fps, scenario "pan" on a 200k-point line series with a PaletteFactory.createGradient stroke and unsorted X or resampling off, so the loop covers every point. 5 runs per side. Pass: "win" on frameP95Ms, and doFunc self time drops in the trace-summary window.

## Other locations

- `esm/Charting/Model/PaletteFactory.js:74` — createYGradient: same wasm Constrain per point
- `esm/Charting/Model/PaletteFactory.js:26` — getDataSeriesValuesCount (BaseRenderableSeries.js:818) calls dataSeries.count(), which calls xValues.size(): another embind call per point
- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/HeatmapHelpers.js:184` — Outside this slice: the same wasm Constrain per heatmap cell in getCellColor
- `esm/Charting/Themes/IThemeProvider.js:53` — Outside this slice: the same pattern
- `esm/Core/NumberUtil.js:11` — A JS NumberUtil.constrain already exists

## Review notes

- Found by reviewer slice `s08-data-series`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

