# 034 · StackedXyCollection.draw sets strokeY1DashArray on every child each frame, forcing a full palette recompute on paletted stacked mountains

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/StackedXyCollection.js:200` |
| Severity | **medium** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | frame time (pan, zoom, cursor-driven redraws) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Rule | SC-23, V8-07 (web-performance skill) |
| Effort to fix | small |

## Code

```js
                if ("strokeY1" in series) {
                    // @ts-ignore
                    series.strokeY1 = index === 0 ? "transparent" : collection[index - 1].stroke;
                    // @ts-ignore
                    series.strokeY1DashArray = index === 0 ? [] : collection[index - 1].strokeDashArray;
                }
```

## Call path and frequency

SciChartRenderer series draw (esm/Charting/Services/SciChartRenderer.js:354 / :670) -> StackedXyCollection.draw (StackedXyCollection.js:155-212), for each visible child every frame -> strokeY1DashArray setter (BaseStackedMountainRenderableSeries.js:204-208, unguarded) -> BandSeriesDrawingProvider.onSeriesPropertyChange(STROKE_Y1_DASH_ARRAY) (DrawingProviders/BandSeriesDrawingProvider.js:173-180) sets palettingState.requiresUpdate = true and calls createPenInCache again -> series.draw (StackedXyCollection.js:202) -> BandSeriesDrawingProvider.draw -> applyStrokeFillPaletting (BandSeriesDrawingProvider.js:123) -> BaseSeriesDrawingProvider.js:234-282: overridePaletteProviderColors and getMetadataAt per visible point (:262), then paletteTextureCache reset and a new SCRTCreatePalette (:282). Rate: every frame, every child layer.

## Why it costs

The documented way to skip per-vertex palette work on frames without new data is shouldUpdatePalette() returning false, with isRangeIndependant (SC-23). The collection's own per-frame property write sets requiresUpdate before the provider is asked, so the cache never hits, and every redraw (pan, zoom, cursor move) recomputes and re-creates the palette for every layer.

**Scale where it matters:** Only stacked mountains whose palette provider opts into caching are affected: shouldUpdatePalette() returns false, and for pan or zoom also isRangeIndependant is true (a range-dependent provider recomputes anyway when the start or count changes, BaseSeriesDrawingProvider.js:367-376; a provider without shouldUpdatePalette, or DefaultPaletteProvider, recomputes on every render by design, :394-396). For those, the lost saving is visible points x layers per render, for example 5 layers x 20k points: 100k palette callbacks plus 5 native palette objects created per render, on pan, zoom and cursor-driven redraws. Without a palette provider, what remains is a pen-cache lookup (Pen2DCache.create reuses the pen, since it compares dash arrays with areArraysEqual) and a DpiHelper.adjustStrokeSize allocation per layer per render.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/StackedXyCollection.js
+++ b/esm/Charting/Visuals/RenderableSeries/StackedXyCollection.js
+const EMPTY_DASH_ARRAY = [];
@@ draw() (:191 and :200)
-                    series.strokeY1DashArray = index === 0 ? [] : collection[index - 1].strokeDashArray;
+                    series.strokeY1DashArray = index === 0 ? EMPTY_DASH_ARRAY : collection[index - 1].strokeDashArray;
--- a/esm/Charting/Visuals/RenderableSeries/BaseStackedMountainRenderableSeries.js
+++ b/esm/Charting/Visuals/RenderableSeries/BaseStackedMountainRenderableSeries.js
+import { areArraysEqual } from "../../../utils/array";
@@
     set strokeY1DashArray(strokeY1DashArray) {
+        if (areArraysEqual(this.strokeY1DashArrayProperty, strokeY1DashArray)) {
+            return;
+        }
         this.strokeY1DashArrayProperty = strokeY1DashArray;
```

**Trade-off:** If an app mutates a layer's strokeDashArray array in place, keeping the same reference and not calling the setter, the change no longer reaches strokeY1 of the next layer; assigning a new array still works.

## App-side workaround

None inside the stacked collection. Alternatively, draw the layers as FastBandRenderableSeries with sums computed in the app, where the palette cache works.

## Verify

measure.md#fps, `pan` scenario and a cursor-move redraw scenario on a 5-layer StackedMountainCollection whose palette provider returns false from shouldUpdatePalette() and true from isRangeIndependant, with a dev counter inside overrideFillArgb, 5 runs per side. Pass: the counter stays at 0 during the scenario (SC-23) and frameP95Ms wins or is neutral. Not measured.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/StackedXyCollection.js:191` — same write on the renderDataTransform path
- `esm/Charting/Visuals/RenderableSeries/BaseStackedMountainRenderableSeries.js:204` — setter without equality check
- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/BandSeriesDrawingProvider.js:178` — palettingState.requiresUpdate = true on STROKE_Y1_DASH_ARRAY

## Review notes

- Found by reviewer slice `s03-renderable-series`.
- Adversarial verification (corrected): Re-read StackedXyCollection.js:155-212 (quote matches :196-201; same write at :191 on the transform path), BaseStackedMountainRenderableSeries.js:204-208 (setter has no equality check, unlike strokeY1 at :140-146) and BandSeriesDrawingProvider.js:170-180 (STROKE_Y1_DASH_ARRAY sets palettingState.requiresUpdate = true at :178). Chain confirmed: SciChartRenderer.js:354/:670 rs.draw -> StackedXyCollection.draw (StackedMountainCollection extends StackedXyCollection, StackedMountainCollection.js:32) -> setter on every visible child each render -> BaseRenderableSeries.draw (:593) -> BandSeriesDrawingProvider.draw -> applyStrokeFillPaletting (:123) -> BaseSeriesDrawingProvider.shouldUpdatePalette (:360-397) can only set requiresUpdate, never clear it, so the check at :235-237 never skips and the per-point loop (:256-275) plus PaletteCache.create (:282, new SCRTCreatePalette at Drawing/PaletteCache.js:24) run every render. Pen2DCache.create (Drawing/Pen2DCache.js) compares dash arrays with areArraysEqual, so the pen itself is reused, as the scale says. The advanced applyPaletting path returns before the check (:229-233) and is unaffected. Fix checked: the setter guard alone suffices (areArraysEqual([], []) is true), the import path ../../../utils/array resolves to esm/utils/array.js:12, and no other per-render write resets requiresUpdate for stacked mountains. Corrected scale: the extra cost exists only for providers that opt into caching (shouldUpdatePalette returning false); a provider without shouldUpdatePalette, or DefaultPaletteProvider, recomputes every render by design, and a range-dependent provider recomputes anyway when pan or zoom changes start/count. Severity medium kept (SC-23 impact medium; affects only cached paletted stacked mountains).

