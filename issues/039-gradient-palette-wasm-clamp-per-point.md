# 039 · PaletteFactory gradient palettes do an integer clamp through wasm (NumberUtil.Constrain) plus a wasm count() for every point on every frame

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Model/PaletteFactory.js:25` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/b12b7b62ea39b4131b117f8705e32adb/): reproduced on WebGL and WebGPU ([source](../demos/039-gradient-palette-wasm-clamp-per-point/)) |
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

**Trade-off:** For finite values the result is unchanged. Edge cases now have a defined result: a NaN lerpFactor (count === 1, or a NaN y) maps to index 0, and +Infinity (createYGradient with yRange.diff 0 and y above min) maps to the last color. Before, the result depended on how the wasm Constrain converts its arguments, which the package does not show. The per-point count() call remains in this diff. It can be hoisted: both paletting paths call the provider hook before their loops (BaseSeriesDrawingProvider.js:136 -> :393-395 for stroke, :234 for stroke+fill, which PointMarkerDrawingProvider.js:97 also uses), so a shouldUpdatePalette() that caches renderSeries.getDataSeriesValuesCount() and returns true removes it without changing when colors update.

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
- Adversarial verification (corrected): Quote matches PaletteFactory.js:25-29 verbatim (primary moved from :28, the Constrain line, to :25 where the quote starts); createYGradient has the same Constrain at :74. Confirmed NumberUtil.Constrain is the embind static on the wasm context (types/types/TSciChart.d.ts:237-245, registered via __embind_register_class_class_function in _glue-pretty/scichart.js:4694) while a JS NumberUtil.constrain exists at esm/Core/NumberUtil.js:11. getDataSeriesValuesCount (BaseRenderableSeries.js:818-819) -> BaseDataSeries.count() (:549-551) -> xValues.size(), a second embind call per point. Caller chain: LineSeriesDrawingProvider.draw (:85) -> applyStrokePaletting (:143) -> BaseSeriesDrawingProvider.js loop :148 -> overrideStrokeArgb :156 -> doFunc; applyStrokeFillPaletting loop :254 -> overridePaletteProviderColors :262 (stroke + fill); PointMarkerDrawingProvider.overridePaletteProviderColors :129 -> overridePointMarkerArgb -> doFunc twice. No guard: the palette object has no shouldUpdatePalette, so BaseSeriesDrawingProvider.js:393-395 sets requiresUpdate every frame. The loop runs over the point series (resampled count when resampling is on, all visible points when off). TASK-13 Avoid does not excuse a per-item call. Severity medium kept: per frame and per point, but a constant-factor overhead (2 cheap crossings per point) that only applies to PaletteFactory gradient users, with the point count bounded by resampling in the default case. Evidence S: the crossings happen on every repaint. Fix diff checked: identical for finite values; edge cases noted in the trade-off. The glue's integer toWireType passes values through unchanged (scichart.js:5261-5290), so the old NaN/Infinity result depended on the wasm parameter type, which the package does not show. Re-applied to correct the trade-off: the point-marker path does call the shouldUpdatePalette hook (PointMarkerDrawingProvider.js:97 -> applyStrokeFillPaletting -> :234), so caching count there is safe.

