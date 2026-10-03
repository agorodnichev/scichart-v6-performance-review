# 036 · Band and mountain paletting builds a native SCRTPalette from all paletted colours on every palette update, but nothing reads it any more

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/DrawingProviders/BaseSeriesDrawingProvider.js:282` |
| Severity | **medium** |
| Pipeline stage | GPU upload (`gpu-upload`) |
| Metric | frame time (also wasm heap churn) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | GPU-05 (web-performance skill) |
| Effort to fix | small |

## Code

```js
            // Palette is used only for band and mountain series
            if (usePalette) {
                if (this.palettingState.palettedColorsHashCode !== hashCode) {
                    this.palettingState.paletteTextureCache.reset();
                }
                this.palettingState.paletteTextureCache.create(this.palettingState.palettedColors);
                this.palettingState.palettedColorsHashCode = hashCode;
            }
```

## Call path and frequency

SciChartRenderer.js:354 -> BaseRenderableSeries.js:628 -> MountainSeriesDrawingProvider.draw (:70) or BandSeriesDrawingProvider.draw (:123) with usePalette = true -> BaseSeriesDrawingProvider.applyStrokeFillPaletting -> paletteTextureCache.reset() (:238), which deletes the previous native palette -> paletteTextureCache.create(palettedColors) (:282 -> PaletteCache.js:17-24, `new SCRTCreatePalette(fillColors)`). Rate: every palette update. That is every redraw for mountain series with a palette provider (forced dirty), and for band and stacked-mountain series whose provider has no cacheable shouldUpdatePalette. Running rg over esm finds no reader of paletteTextureCache.value: the draw paths use SetPalettedColors (MountainSeriesDrawingProvider.js:71-77, BandSeriesDrawingProvider.js:124-130).

## Why it costs

The comments say the per-point colour arrays replaced the SCRTPalette/SetPalette path, but the palette creation was left in place. reset() at :238 runs before the hash compare at :279, so the hash check never skips a rebuild. The native allocation and copy are certain. What SCRTCreatePalette does in the engine (a texture create and upload, going by the 'paletteTextureCache' name) is not visible from JS, so the GPU part is a hypothesis.

**Scale where it matters:** One native palette per update per series, built from 2 colours per visible point. 100k points means 200k colours copied into a new native object that is freed on the next update.

## Fix (library side)

```diff
--- a/esm/Charting/Drawing/PaletteCache.js
+++ b/esm/Charting/Drawing/PaletteCache.js
@@ export class PaletteCache extends BaseCache {
+    /** Store the colours only; the native SCRTPalette is built on the first read of `value` */
+    setColorsLazy(fillColors) {
+        this.invalidateCache();
+        this.fillColors = fillColors;
+    }
--- a/esm/Charting/Visuals/RenderableSeries/DrawingProviders/BaseSeriesDrawingProvider.js
+++ b/esm/Charting/Visuals/RenderableSeries/DrawingProviders/BaseSeriesDrawingProvider.js
             // Palette is used only for band and mountain series
             if (usePalette) {
-                if (this.palettingState.palettedColorsHashCode !== hashCode) {
-                    this.palettingState.paletteTextureCache.reset();
-                }
-                this.palettingState.paletteTextureCache.create(this.palettingState.palettedColors);
+                // draw paths use SetPalettedColors; build the SCRTPalette only if something reads paletteTextureCache.value
+                this.palettingState.paletteTextureCache.setColorsLazy(this.palettingState.palettedColors);
                 this.palettingState.palettedColorsHashCode = hashCode;
             }
```

**Trade-off:** A custom drawing-provider subclass that reads palettingState.paletteTextureCache.value still gets the palette, built on first read: the PaletteCache.value getter already builds lazily from fillColors. If palettedColorsHashCode has no external readers, the per-point numericHashCode work can be dropped too.

## App-side workaround

For band series, make the palette provider cacheable (SC-23) so updates are rare. Mountain series cannot avoid it (see the mountain finding).

## Verify

measure.md#fps, `pan` on a FastBandRenderableSeries and a FastMountainRenderableSeries (100k points each) with a fill palette provider, plus a dev counter on wasmContext.SCRTCreatePalette. Pass: the counter reads 0 during the scenario; compare-runs reports 'win' or 'neutral' on frameP95Ms (neutral is acceptable because the change only removes work); measure.md#mem shows a flat wasm heap.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/BaseSeriesDrawingProvider.js:238` — an unconditional reset() before the hash check makes the hash comparison useless
- `esm/Charting/Drawing/PaletteCache.js:24` — new SCRTCreatePalette(fillColors)

## Review notes

- Found by reviewer slice `s04-drawing-providers`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

