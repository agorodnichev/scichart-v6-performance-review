# 005 · The mountain drawing provider marks the palette dirty on every draw, so palette providers run per point per frame and shouldUpdatePalette/isRangeIndependant are ignored. PolarBand never checks them at all.

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/DrawingProviders/MountainSeriesDrawingProvider.js:154` |
| Severity | **high** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (also INP during pan/zoom) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/9ef904a22f95ff06df798f2e57f1954f/): reproduced on WebGL and WebGPU ([source](../demos/005-mountain-palette-cache-forced-dirty/)) |
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
@@ draw(renderContext, renderPassData) {
-        this.applyFillFillPaletting(this.parentSeries.fill, fillBrush, this.parentSeries.fillY1, fillBrushY1, this.parentSeries.opacity, startIndex, count, pointSeries, xDrawValues, yDrawValues);
+        this.applyFillFillPaletting(this.parentSeries.fill, fillBrush, this.parentSeries.fillY1, fillBrushY1, this.parentSeries.opacity, startIndex, count, pointSeries, xDrawValues, yDrawValues, renderPassData);
@@
-    applyFillFillPaletting(fill, fillBrush, filly1, fillBrushy1, opacity, startIndex, drawCount, pointSeries, xValues, yValues) {
+    applyFillFillPaletting(fill, fillBrush, filly1, fillBrushy1, opacity, startIndex, drawCount, pointSeries, xValues, yValues, renderPassData) {
@@
             if (!this.palettingState.palettedColors) {
                 this.palettingState.palettedColors = new this.webAssemblyContext.UIntVector();
             }
+            this.shouldUpdatePalette(renderPassData, fillPaletteProvider, startIndex, drawCount, true);
+            // draw() never passes paletteStart to the native args, so a range-independent offset cannot be used here:
+            // keep the range-dependent behaviour and recompute whenever shouldUpdatePalette asks for an offset
+            if (this.palettingState.paletteStartIndex) {
+                this.palettingState.requiresUpdate = true;
+            }
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
@@ onSeriesPropertyChange(propertyName) {
         super.onSeriesPropertyChange(propertyName);
+        // the default colours (fill, fillY1), the opacity passed to overrideFillArgb and the provider itself feed the palette
+        if (propertyName === PROPERTY.FILL || propertyName === PROPERTY.FILL_Y1 || propertyName === PROPERTY.OPACITY ||
+            propertyName === PROPERTY.PALETTE_PROVIDER) {
+            this.palettingState.requiresUpdate = true;
+        }
```

**Trade-off:** The palette is then recomputed only when the brush, a palette-relevant property, the data, the resampling or the visible range changes, or when the provider asks. Data changes still arrive through seriesHasDataChanges: both providers call super.onSeriesPropertyChange, so the dataChanged subscription follows a data series swap. A provider that changes colours without signalling (shouldUpdatePalette returning false while its inputs changed) would show stale colours on mountain and polar band series, as it already does on line and column series (SC-23 Avoid). PolarBand does not pass paletteStart to its native args, so the patch keeps it range-dependent: a range-independent provider there is still recomputed whenever the visible start index is not 0. Honouring isRangeIndependant would also need args.paletteStart, as MountainSeriesDrawingProvider.js:76 does.

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
- Adversarial verification (corrected): Re-read MountainSeriesDrawingProvider.js:39-170: code_quote matches lines 153-155 verbatim (primary :154). draw() calls createBrush() at :61 on every frame, and createBrush unconditionally sets palettingState.requiresUpdate = true. applyStrokeFillPaletting (BaseSeriesDrawingProvider.js:176) then calls shouldUpdatePalette (:234, body :360-397), which only ever sets the flag to true, so the early return at :235-237 can never fire. Every redraw runs the per-point loop :254-276 (overridePaletteProviderColors plus getMetadataAt) and rebuilds the palette texture (:238, :278-283). Caller chain: SciChartRenderer.js:354 -> BaseRenderableSeries.draw :593 -> dp.draw :628 -> MountainSeriesDrawingProvider.draw. The provider is created in BaseMountainRenderableSeries.js:26, which FastMountain and SplineMountain inherit; PolarMountain overrides addDrawingProviders (PolarMountainRenderableSeries.js:128-131) and uses PolarBand instead. PolarBandSeriesDrawingProvider.draw (:111) -> applyFillFillPaletting (:128-199) has no requiresUpdate or shouldUpdatePalette check at all. It is used by PolarBand (PolarBandRenderableSeries.js:120), PolarMountain (:129) and PolarStackedMountain (PolarStackedMountainRenderableSeries.js:73). hashCode (:186) is computed and never read. Smear's gate is commented out at SmearSeriesDrawingProvider.js:124. SC-23 Avoid (stale colours when a provider is never marked dirty) does not apply: here the library defeats a provider that correctly returns false. Severity high is kept: per frame x per visible point, for apps that use the documented SC-23 cache. Evidence S is kept. Mountain fix checked: BrushCache.create returns the cached WebGlBrush when its inputs are unchanged (BrushCache.js:30-45), and getScrtBrushFromCache is cache.value.scrtBrush (:132-146), so `brush !== previous` detects a real rebuild. Stroke and opacity changes already set the flag through createPen (:167), data changes through seriesHasDataChanges (base :356), and PALETTE_PROVIDER is added to match LineSeriesDrawingProvider.js:35. With usePalette, default colours are NEUTRAL_COLOR (BaseSeriesDrawingProvider.js:194-195), so fill does not feed the palette. CORRECTED the PolarBand part of fix_diff, which had two bugs. (1) Nothing set requiresUpdate when fill, fillY1, opacity or the palette provider changed, yet fillColor and fillColorY1 are the per-point defaults (:136-143, :182-184) and opacity is passed to overrideFillArgb (:181), so colours would go stale. The patch now sets the flag in onSeriesPropertyChange. (2) It called shouldUpdatePalette, whose isRangeIndependant branch (:377-391) shrinks to a paletteStartIndex offset without recomputing, but PolarBand never passes paletteStart to its native args (draw :95-119, unlike Mountain :76), so colours would be misaligned. The patch now forces a recompute when paletteStartIndex is non-zero. renderPassData is now passed in from draw() rather than taken from getCurrentRenderPassData(), which would be the untransformed RPD when a renderDataTransform is active (BaseRenderableSeries.js:622-625). The trade_off is updated to match.

