# 028 · The non-uniform heatmap rebuilds a colour texture the size of its on-screen area in JS and re-uploads it on every pan/zoom frame

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/DrawingProviders/HeatmapHelpers.js:313` |
| Severity | **high** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (pan/zoom) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | GPU-08, GPU-36, GPU-05 (web-performance skill) |
| Effort to fix | large |

## Code

```js
export const calculateHeatmapTexture = (colorDataParams, intVector, heatTextureCache, precision) => {
    var _a;
    const { textureWidth, textureHeight, webAssemblyContext, useInterpolation } = colorDataParams;
    // calculate colors from zValues
    // per pixel colors
    const colorArray = getColorDataForTexture(colorDataParams, intVector, precision);
    // create and fill texture
    const texture = heatTextureCache.create(textureWidth, textureHeight, webAssemblyContext.eTSRTextureFormat.TSR_TEXTUREFORMAT_A8R8G8B8);
    webAssemblyContext.SCRTSetTextureLinearSamplerEnabled(texture, useInterpolation && ((_a = colorDataParams.linearTextureFilteringIntensity) !== null && _a !== void 0 ? _a : 1) > 0);
    webAssemblyContext.SCRTFillTextureAbgr(texture, textureWidth, textureHeight, colorArray);
    return texture;
```

## Call path and frequency

SciChartRenderer.js:354 -> BaseRenderableSeries.js:628 -> NonUniformHeatmapDrawingProvider.draw (:57) -> drawHeatmapInTypescript (:102 -> :156) -> calculateOffsets in screen pixels (:178, HeatmapHelpers.js:263) -> memoized calculateHeatmapTexture (:179, :219-233). The memo key includes the pixel offsets, so every pan or zoom misses. -> getColorDataForTexture (HeatmapHelpers.js:86-148) writes every texel of visibleTextureWidth x visibleTextureHeight; the interpolation path (:31-85) also allocates an Array.from row per cell row (:47) -> heatTextureCache.create, a new texture whenever the pixel size changes, so on every zoom frame -> SCRTFillTextureAbgr full upload (:317). Rate: every redraw in which the visible range or plot size changed.

## Why it costs

Cell colours change only with zValues, the colour map or opacity. The texture, however, is rasterised on the CPU at screen resolution, so the work and the upload scale with pixels and repeat on every viewport change. Zoom also changes the texture size, which recreates the GPU texture (GPU-05). The memo compare itself allocates two Object.values arrays and walks both offset arrays on every frame (NonUniformHeatmapDrawingProvider.js:223-226).

**Scale where it matters:** Texels = the heatmap's visible area in device pixels. A 1600 x 1000 plot area means 1.6M texels written in JS and 6.4 MB uploaded per pan frame, whatever the cell count.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/DrawingProviders/NonUniformHeatmapDrawingProvider.js
+++ b/esm/Charting/Visuals/RenderableSeries/DrawingProviders/NonUniformHeatmapDrawingProvider.js
@@ drawHeatmapInTypescript(...) {
-        const texture = this.calculateHeatmapTexture({ ...textureWidth: visibleTextureWidth, textureHeight: visibleTextureHeight, horCellOffsets, vertCellOffsets, ... });
-        renderContext.drawTexture(texture, xMinCoordinate, yMaxCoordinate, visibleTextureWidth, visibleTextureHeight);
+        // (1) Once per data / colorMap / opacity change (set cellTextureDirty in seriesHasDataChanges and on
+        //     COLOR_MAP/OPACITY): one texel per CELL (arrayWidth x arrayHeight), written through a HEAPU32 view
+        //     and uploaded with one SCRTFillTextureAbgr.
+        if (this.cellTextureDirty) {
+            this.cellTexture = this.buildCellColorTexture(zValues, colorGradientScale, colorMin, colorMax, opacity);
+            this.cellTextureDirty = false;
+        }
+        // (2) Per frame, geometry only: upload the visible cell boundaries (horCellOffsets / vertCellOffsets,
+        //     W + H values) as two small 1D textures and draw one quad whose shader maps each fragment to its
+        //     cell (texelFetch, GPU-36). This needs a new engine effect next to SCRTPrimitivesEffect.Heatmap.
+        this.drawCellLookupQuad(renderContext, this.cellTexture, horCellOffsets, vertCellOffsets);
```

**Trade-off:** This is engine and shader work: a heatmap effect that samples a cell-resolution texture through 1D cell-boundary lookups, so per-frame uploads shrink from W x H to W + H texels. A stopgap that fits the current engine: rasterise once, at a capped resolution, over the full heatmap extent, and let the GPU translate and scale it. That costs blurrier cell edges when zoomed far in.

## App-side workaround

Use UniformHeatmapRenderableSeries when cells are equal (SC-09), or resample the data to a uniform grid. Otherwise keep the non-uniform heatmap's plot area small.

## Verify

measure.md#fps, `pan` and `zoom` on a NonUniformHeatmapRenderableSeries with 500 x 500 cells in a 1600 x 1000 plot, desktop profile, 5 runs per side. Pass: compare-runs reports 'win' on frameP95Ms and longFramesPer10s, and getColorDataForTexture self time in the pan window drops to 0 (it then runs only on data changes).

## Other locations

- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/NonUniformHeatmapDrawingProvider.js:179` — called on every draw with pixel-space offsets as part of the memo key
- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/HeatmapHelpers.js:106` — per-texel write loop
- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/NonUniformHeatmapDrawingProvider.js:223` — the memo compare allocates Object.values arrays on every frame

## Review notes

- Found by reviewer slice `s04-drawing-providers`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

