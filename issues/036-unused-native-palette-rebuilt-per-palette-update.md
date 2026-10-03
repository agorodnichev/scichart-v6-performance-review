# 036 · Band and mountain paletting builds a native SCRTPalette from all paletted colours on every palette update, but nothing reads it any more

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/DrawingProviders/BaseSeriesDrawingProvider.js:282` |
| Severity | **medium** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | frame time (also wasm heap churn) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Rule | V8-06 (web-performance skill) |
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

The comments in the Mountain and Band providers say the per-point colour arrays (SetPalettedColors) replaced the old SCRTPalette/SetPalette path, but the palette creation and its hash were left in place. reset() at :238 runs before the hash compare at :279, so the hash check never skips a rebuild. A node probe of the core wasm (pal.cjs) shows SCRTCreatePalette allocates 4 bytes per colour, so it copies the whole colour array. A probe that logs the stubbed GL context (pal2.cjs) shows no WebGL call during creation, so no texture is created or uploaded when the palette is built. The waste is wasm-heap malloc, copy and free per update, plus the per-point hash. Neither result is read.

**Scale where it matters:** One native palette per palette update per series, holding 2 colours per visible point at 4 bytes each: 100k visible points means an 800 KB wasm-heap allocation and copy per update, freed on the next update. There are also 2 numericHashCode calls per point that feed only the dead hash compare. For paletted mountain series this happens every redraw.

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
- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/BaseSeriesDrawingProvider.js:273` — 2 numericHashCode calls per point whose only consumer is the dead compare at :279
- `esm/Charting/Drawing/PaletteCache.js:24` — new SCRTCreatePalette(fillColors): native allocation and copy of 4 bytes per colour
- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/MountainSeriesDrawingProvider.js:154` — createBrush(), called from every draw (:60), forces requiresUpdate, so the palette is rebuilt every redraw

## Review notes

- Found by reviewer slice `s04-drawing-providers`.
- Adversarial verification (corrected): Re-read DrawingProviders/BaseSeriesDrawingProvider.js:176-320 and Drawing/PaletteCache.js:1-30. The code_quote matches :277-284 verbatim, with create() at :282. Mechanism: when requiresUpdate is set, :238 calls paletteTextureCache.reset(), which deletes cachedEntity and clears fillColors (PaletteCache.js:26-29, BaseCache.js:31-33). create(palettedColors) at :282 therefore never takes the cached branch (PaletteCache.js:18-20) and always runs `new SCRTCreatePalette(fillColors)` (:24). The hash compare at :279 never skips a rebuild. Callers with usePalette = true: MountainSeriesDrawingProvider.js:70 (BaseMountainRenderableSeries.js:26) and BandSeriesDrawingProvider.js:123 (BaseBandRenderableSeries.js:38, and BaseStackedMountainRenderableSeries.js:262 also uses the band provider). Both draw paths use SetPalettedColors plus paletteStart (Mountain :73-76, Band :128-131). rg over esm and types finds no reader of paletteTextureCache.value, SCRTPalette or SetPalette; the only other references are reset() calls (PolarBand :153/:190, Base :288) and delete (:320). palettedColorsHashCode is read only at :279. Rate: Mountain draw calls createBrush() (:60), which sets requiresUpdate = true (:154), so this runs on every redraw. Band series run it whenever shouldUpdatePalette forces an update (Base :394-396; DefaultPaletteProvider returns true). New evidence: a node probe of the core wasm (agent-scratch/s04v/pal.cjs) shows that SCRTCreatePalette allocates 4 bytes per colour plus 8 on the wasm heap (n=1000 -> 4008 B, n=100000 -> 400008 B, n=400000 -> 1600008 B), so it copies all colours. A second probe (pal2.cjs) logs every call on the stubbed GL context and records no WebGL call during SCRTCreatePalette. The texture/GPU-upload hypothesis is refuted for creation: the cost is a native malloc, a copy of 8 bytes per visible point, a free on the next update, and 2 numericHashCode calls per point (:272-275, utils/number.js:9-13), all for an object nothing reads. Corrected: stage gpu-upload -> memory; rule GPU-05 -> V8-06 (no GPU object is created); why_it_costs, scale and other_locations updated. The fix is semantics-preserving: PaletteCache.value (:7-12) still builds lazily from fillColors, which is the same palettedColors vector updated in place, for any custom reader. Severity stays medium: it runs per frame for paletted mountain series, but it is a linear memcpy plus a cheap hash on top of the per-point palette callback loop. Evidence S.

