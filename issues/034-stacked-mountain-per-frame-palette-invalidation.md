# 034 · StackedXyCollection.draw sets strokeY1DashArray on every child each frame, forcing a full palette recompute on paletted stacked mountains

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/StackedXyCollection.js:200` |
| Severity | **medium** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | frame time (pan, zoom, cursor-driven redraws) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
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

**Scale where it matters:** Only stacked mountains with a paletteProvider are affected. The cost is visible points x layers per frame, for example 5 layers x 20k points: 100k palette callbacks plus 5 native palette objects created per frame. Without a palette provider, what remains is a pen-cache lookup and a DpiHelper.adjustStrokeSize allocation per layer per frame.

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
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

