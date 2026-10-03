# 028 · The non-uniform heatmap rebuilds a colour texture the size of its on-screen area in JS and re-uploads it on every zoom frame, and on every pan frame while the heatmap is clipped by the plot area

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/DrawingProviders/HeatmapHelpers.js:313` |
| Severity | **high** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (pan/zoom) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
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

SciChartRenderer.js:354 -> BaseRenderableSeries.js:628 -> NonUniformHeatmapDrawingProvider.draw (:57) -> drawHeatmapInTypescript (:102 -> :156) -> calculateOffsets in screen pixels (:178, HeatmapHelpers.js:263) -> memoized calculateHeatmapTexture (:179, :219-233; single-slot memoize, utils/memoize.js:1-16). The memo key includes the texture size, the visible cell index range and the pixel offsets. The offsets include -heatmapRect.left/top when the heatmap is clipped (HeatmapHelpers.js:268-276), so every zoom frame misses, and every pan frame misses while the heatmap extends past the plot edge on the panned axis. A pan of a heatmap lying fully inside the plot area, or a redraw with an unchanged viewport, hits the memo. On a miss -> getColorDataForTexture (HeatmapHelpers.js:86-149) fills visibleTextureWidth x visibleTextureHeight texels. The interpolation path (:31-85) also allocates an Array.from row per cell row (:47) and a Uint32Array per interpolated row (:60). -> heatTextureCache.create, a new texture whenever the pixel size changes, so on every zoom frame -> SCRTFillTextureAbgr full upload (:317). Rate: per redraw during zoom, and during pan of a clipped (zoomed-in) heatmap.

## Why it costs

Cell colours change only with zValues, the colour map or opacity. The texture, however, is rasterised on the CPU at screen resolution, so the work and the upload scale with pixels and repeat on every viewport change. Zoom also changes the texture size, which recreates the GPU texture (GPU-05). The memo compare itself allocates two Object.values arrays and walks both offset arrays on every frame (NonUniformHeatmapDrawingProvider.js:223-226).

**Scale where it matters:** Texels = the heatmap's visible area in canvas pixels. A 1600 x 1000 plot area means 1.6M texels (6.4 MB) filled and uploaded per missed frame, whatever the cell count. Without linear filtering, the JS loop runs once per visible cell row x textureWidth, and copyWithin fills the other rows (HeatmapHelpers.js:122-125). With useLinearTextureFiltering, the JS loop touches every texel (:81-83).

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/DrawingProviders/NonUniformHeatmapDrawingProvider.js
+++ b/esm/Charting/Visuals/RenderableSeries/DrawingProviders/NonUniformHeatmapDrawingProvider.js
@@ drawHeatmapInTypescript(...) {
-        const texture = this.calculateHeatmapTexture({ ...textureWidth: visibleTextureWidth, textureHeight: visibleTextureHeight, horCellOffsets, vertCellOffsets, ... });
-        renderContext.drawTexture(texture, xMinCoordinate, yMaxCoordinate, visibleTextureWidth, visibleTextureHeight);
+        // (1) Only when cell colours can change: one texel per CELL (arrayWidth x arrayHeight), written through a
+        //     HEAPU32 view and uploaded with one SCRTFillTextureAbgr. Key it on values rather than a dirty flag set
+        //     from seriesHasDataChanges: onSeriesPropertyChange here does not call super, so the dataChanged
+        //     subscription never follows a dataSeries swap. changeCount is bumped by every notifyDataChanged.
+        const ds = this.parentSeries.dataSeries;
+        const key = [ds, ds.changeCount, colorGradientScale, colorMin, colorMax, opacity, this.parentSeries.fillValuesOutOfRange];
+        if (!this.cellTextureKey || key.some((v, i) => v !== this.cellTextureKey[i])) {
+            this.cellTexture = this.buildCellColorTexture(zValues, colorGradientScale, colorMin, colorMax, opacity);
+            this.cellTextureKey = key;
+        }
+        // (2) Per frame, geometry only: upload the visible cell boundaries (horCellOffsets / vertCellOffsets,
+        //     W + H values) as two small 1D textures and draw one quad whose shader maps each fragment to its
+        //     cell (texelFetch, GPU-36), applying linearTextureFilteringIntensity between cell centres when
+        //     useLinearTextureFiltering is set. This needs a new engine effect next to SCRTPrimitivesEffect.Heatmap.
+        this.drawCellLookupQuad(renderContext, this.cellTexture, horCellOffsets, vertCellOffsets);
```

**Trade-off:** This is engine and shader work: a heatmap effect that samples a cell-resolution texture through 1D cell-boundary lookups, so per-frame uploads shrink from W x H to W + H texels. The linear-filtering mode (linearTextureFilteringIntensity, getAxisInterpolation) has to be reimplemented in that shader to keep today's look. A stopgap that fits the current engine: rasterise once per zoom level, over the full heatmap extent at a capped resolution, and let the GPU translate it on pan. That removes the pan-frame misses, but costs blurrier cell edges when zoomed far in, and it is bounded by the maximum texture size.

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
- Adversarial verification (corrected): Re-read HeatmapHelpers.js:308-319: code_quote matches verbatim (primary :313). Caller chain: SciChartRenderer.js:354 -> BaseRenderableSeries.draw :593 -> dp.draw :628 -> NonUniformHeatmapDrawingProvider.draw :57 -> drawHeatmapInTypescript (:102 -> :156) -> calculateOffsets (:178, HeatmapHelpers.js:263-278) -> this.calculateHeatmapTexture (:179) -> memoize (utils/memoize.js:1-16, a single slot) with customCompare (:223-227). customCompare allocates Object.values plus two rest objects and walks both offset arrays on every draw. On a miss: getColorDataForTexture (:86-149) -> heatTextureCache.create (:315, TextureCache.create makes a new texture when width or height changes) -> SCRTFillTextureAbgr full upload (:317). CORRECTED the miss condition. The key holds textureWidth/Height, start indices, cell counts and the pixel offsets. horCellOffsets/vertCellOffsets depend only on the integer heatmapRect width/height, the cell sizes and offsetX/offsetY = -heatmapRect.left/top when the heatmap starts above or left of the plot (HeatmapHelpers.js:268-276). So every zoom frame misses (sizes and offsets change). A pan frame misses while the heatmap is clipped by the plot edge on the panned axis or its visible cell index range changes. A pan of a heatmap that lies fully inside the plot area hits the memo, as does any redraw with an unchanged viewport. Panning a zoomed-in heatmap, the usual case, still misses every frame, so the per-frame claim holds during interaction: severity high is kept (rule impacts GPU-08 high, GPU-05 high, GPU-36 medium; the call rate is per frame while panning or zooming). Evidence S is kept for that path. CORRECTED scale: the non-interpolated path computes one texel row per visible cell row in JS and fills the other rows with copyWithin (:122-125). Only the interpolated path (useLinearTextureFiltering) loops in JS over every texel (:81-83) and allocates rows (:47, :60). CORRECTED fix_diff: replaced the cellTextureDirty flag set from seriesHasDataChanges with a value key (dataSeries, changeCount, colorGradientScale, colorMin/Max, opacity, fillValuesOutOfRange). NonUniformHeatmapDrawingProvider.onSeriesPropertyChange (:42-53) does not call super, so the base dataChanged subscription (BaseSeriesDrawingProvider.js:46-48) never follows a dataSeries swap, and a flag would miss data updates and fillValuesOutOfRange changes (BaseHeatmapRenderableSeries.js:156-158). Also noted that the linear-filtering mode must move into the shader. Title and trade_off updated to match.

