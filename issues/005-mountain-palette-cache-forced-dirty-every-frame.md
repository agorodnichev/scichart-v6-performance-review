# 005 · The mountain drawing provider marks the palette dirty on every draw, so palette providers run per point per frame and shouldUpdatePalette/isRangeIndependant are ignored. PolarBand never checks them at all.

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/DrawingProviders/MountainSeriesDrawingProvider.js:154` |
| Severity | **high** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (also INP during pan/zoom) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | SC-23 (web-performance skill) |
| Effort to fix | small |

## Code

```js
    createBrush() {
        this.palettingState.requiresUpdate = true;
        const { fill, opacity, fillLinearGradient, parentSurface, customTextureOptions } = this.parentSeries;
```

## Call path and frequency

SciChartRenderer.js:354 -> BaseRenderableSeries.js:628 -> MountainSeriesDrawingProvider.draw (:39) -> this.createBrush() (:61) -> palettingState.requiresUpdate = true (:154) -> applyStrokeFillPaletting (:70 -> BaseSeriesDrawingProvider.js:176) -> shouldUpdatePalette (:234), which can only set the flag to true, so the early return at :235 never fires -> per-point loop (BaseSeriesDrawingProvider.js:254-276) calling overrideStrokeArgb and overrideFillArgb. Rate: every redraw x every visible point, for FastMountain and SplineMountain series (BaseMountainRenderableSeries.js:26) that have any palette provider. Polar series take a different path with the same result: PolarBandSeriesDrawingProvider.draw (:111) -> applyFillFillPaletting (:128-188), which has no requiresUpdate gate at all. That covers PolarBand, PolarMountain and PolarStackedMountain.

## Why it costs

createBrush() runs on every draw to pick up the master-canvas size ratios, and as a side effect it sets requiresUpdate = true. The cache gate in applyStrokeFillPaletting therefore never closes. The documented SC-23 cache (shouldUpdatePalette() returning false, isRangeIndependant) has no effect for mountain series, so the palette is recomputed, and with usePalette a native palette is rebuilt, on every redraw. PolarBand's applyFillFillPaletting skips the gate entirely.

**Scale where it matters:** Visible points per paletted mountain series. For example, 100k points means 100k JS palette callbacks per redraw, on pure pan and zoom frames and on redraws triggered by other series. Each callback also carries the per-point overhead described in the getMetadataAt finding.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/DrawingProviders/MountainSeriesDrawingProvider.js
+++ b/esm/Charting/Visuals/RenderableSeries/DrawingProviders/MountainSeriesDrawingProvider.js
@@ onSeriesPropertyChange(propertyName) {
         super.onSeriesPropertyChange(propertyName);
+        if (propertyName === PROPERTY.PALETTE_PROVIDER) {
+            this.palettingState.requiresUpdate = true;
+        }
@@ createBrush() {
-        this.palettingState.requiresUpdate = true;
         const { fill, opacity, fillLinearGradient, parentSurface, customTextureOptions } = this.parentSeries;
@@
-        this.fillBrushCache.create(fill, opacity, textureHeightRatio, textureWidthRatio, fillLinearGradient, customTextureOptions);
-        return getScrtBrushFromCache(this.fillBrushCache);
+        const previous = this.fillBrushCache.cachedEntity;
+        const brush = this.fillBrushCache.create(fill, opacity, textureHeightRatio, textureWidthRatio, fillLinearGradient, customTextureOptions);
+        if (brush !== previous) {
+            this.palettingState.requiresUpdate = true; // only when the brush really changed
+        }
+        return brush === null || brush === void 0 ? void 0 : brush.scrtBrush;
     }
--- a/esm/Charting/Visuals/RenderableSeries/Polar/DrawingProviders/PolarBandSeriesDrawingProvider.js
+++ b/esm/Charting/Visuals/RenderableSeries/Polar/DrawingProviders/PolarBandSeriesDrawingProvider.js
@@ applyFillFillPaletting(...) {
             if (!this.palettingState.palettedColors) {
                 this.palettingState.palettedColors = new this.webAssemblyContext.UIntVector();
             }
+            this.shouldUpdatePalette(this.parentSeries.getCurrentRenderPassData(), fillPaletteProvider, startIndex, drawCount, true);
+            if (!this.palettingState.requiresUpdate) {
+                this.palettingState.gradientPaletting = this.isGradientFillPaletting(this.parentSeries);
+                return;
+            }
             this.palettingState.paletteTextureCache.reset();
@@
                 hashCode = numericHashCode(hashCode, overrideFillColor);
             }
+            this.palettingState.requiresUpdate = false;
         }
```

**Trade-off:** The palette is then recomputed only when the brush really changed, the data or range changed, or the provider asks. A provider that changes colours without signalling (shouldUpdatePalette returning false while its inputs changed) would show stale colours on mountain series, as it already does on line and column series. For PolarBand to honour isRangeIndependant it must also pass paletteStartIndex to the native args. Until then, keep the range-dependent behaviour.

## App-side workaround

For mountain series, nothing short of subclassing MountainSeriesDrawingProvider and overriding createBrush. Alternatively, draw the area as a FastBandRenderableSeries with y1 at the baseline, where the palette cache works. For polar band and mountain series: none.

## Verify

measure.md#fps, `pan` and `zoom` on a FastMountainRenderableSeries with 100k points and a palette provider whose shouldUpdatePalette() returns false after the first call, 5 runs per side. Pass: a dev counter of overrideFillArgb calls stays at 0 during the scenario (the SC-23 Verify line), and compare-runs reports 'win' on frameP95Ms.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/MountainSeriesDrawingProvider.js:61` — createBrush() is called on every draw
- `esm/Charting/Visuals/RenderableSeries/Polar/DrawingProviders/PolarBandSeriesDrawingProvider.js:128` — applyFillFillPaletting has no requiresUpdate/shouldUpdatePalette gate. It also computes a hashCode that nothing uses (line 186).
- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/SmearSeriesDrawingProvider.js:124` — the palette gate is commented out (TODO). This provider is exported for custom series only.

## Review notes

- Found by reviewer slice `s04-drawing-providers`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

