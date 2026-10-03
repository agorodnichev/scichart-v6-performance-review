# 069 · labelCache.pruneCache evicts labels that are on screen whenever the visible label set exceeds maxSize (200), every 200 ms, and they are re-created on the next frame

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Axis/LabelProvider/LabelCache.js:103` |
| Severity | **medium** |
| Pipeline stage | GPU upload (`gpu-upload`) |
| Metric | frame time (periodic long frames; also wasm/GPU texture churn) |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/cbff574fda8a34470c805355fdc81c68/): reproduced on WebGL and WebGPU ([source](../demos/069-label-cache-prune-evicts-visible-labels/)) |
| Rule | SC-20, LIFE-05, GPU-24 (web-performance skill) |
| Effort to fix | small |

## Code

```js
const pruneCache = () => {
    if (Date.now() > lastPrune + minAge && labelCacheByTextAndStyle.size > maxSize) {
        try {
            // remove more than we need so we do this less.
            const toRemove = Math.min(Math.floor(labelCacheByTextAndStyle.size / 2), (labelCacheByTextAndStyle.size - maxSize) * 2);
            // Sort the items by LastUsed ascending
            const labels = Array.from(labelCacheByTextAndStyle.entries());
            labels.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
            // remove earliest
            for (let index = 0; index < toRemove; index++) {
                const [key, label] = labels[index];
                label.bitmapTexture = deleteSafe(label.bitmapTexture);
                labelCacheByTextAndStyle.delete(key);
            }
```

## Call path and frequency

Runs after every surface draw: SciChartSurface.onRenderSurfaceDraw (esm/Charting/Visuals/SciChartSurface.js:1331) → labelCache.pruneCache() (SciChartSurface.js:1376) → LabelCache.js:102-119, effective at most every minAge (200 ms). On the next frame, AxisBase2D.measure → getTicks(true) (AxisBase2D.js:582/1368) → LabelProviderBase2D.getLabels re-creates each evicted label: in canvas-text mode with getLabelTexture → TextureManager.createTextTexture + upload (LabelProviderBase2D.js:162-167); in native mode with getLabelSizesNative (LabelProviderBase2D.js:226: CalculateStringBounds, a GetLineBounds wasm object per label, a new LabelInfo).

## Why it costs

Labels on screen get lastUsed refreshed every frame, but the prune removes min(size/2, (size-maxSize)*2) entries no matter how recently they were used. Once the visible set exceeds maxSize, it evicts labels that will be drawn on the very next frame, which re-rasterizes and re-uploads them (canvas text) or re-measures them natively. The labelCacheTooSmall warning fires only when toRemove > maxSize (cache above about 2x maxSize), so churn between 200 and 400 entries goes unreported.

**Scale where it matters:** Applies when the distinct label text-and-style entries drawn by surfaces that redraw exceed maxSize (default 200), e.g. 16 or more charts x 2 axes x ~8 labels with different ranges. In canvas-text mode (useNativeText: false), each SciChartSurface.createSingle surface has its own wasm canvas id in the style key (LabelProviderBase2D.js:535), so even identical label texts count once per chart. With 260 visible labels, each prune removes min(130, 120) = 120 of them, all still on screen, about 5 times per second. Because the prune removes up to twice the excess, a working set above about 2/3 of maxSize also loses some visible labels when enough history has built up, but only once per build-up, not continuously.

## Fix (library side)

```diff
--- esm/Charting/Visuals/Axis/LabelProvider/LabelCache.js
 const pruneCache = () => {
-    if (Date.now() > lastPrune + minAge && labelCacheByTextAndStyle.size > maxSize) {
+    const now = Date.now();
+    if (now > lastPrune + minAge && labelCacheByTextAndStyle.size > maxSize) {
         try {
-            // remove more than we need so we do this less.
-            const toRemove = Math.min(Math.floor(labelCacheByTextAndStyle.size / 2), (labelCacheByTextAndStyle.size - maxSize) * 2);
             const labels = Array.from(labelCacheByTextAndStyle.entries());
             labels.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
+            // remove more than we need so we do this less, but never a label drawn within minAge:
+            // that is the visible working set and would be re-created on the next frame
+            const wanted = Math.min(Math.floor(labels.length / 2), (labels.length - maxSize) * 2);
+            let toRemove = 0;
+            while (toRemove < wanted && labels[toRemove][1].lastUsed < now - minAge) {
+                toRemove++;
+            }
             for (let index = 0; index < toRemove; index++) {
@@
-            if (toRemove > maxSize) {
+            if (labels.length - toRemove > maxSize) {
                 performanceWarnings.labelCacheTooSmall.warn();
             }
-            lastPrune = Date.now();
+            lastPrune = now;
```

**Trade-off:** The cache can stay above maxSize while more than maxSize labels are actually visible, so label memory (small textures or LabelInfo objects) follows the visible working set plus minAge of history instead of a hard cap. The warning now fires as soon as the visible set alone exceeds maxSize, which is when the app should call setMaxSize.

## App-side workaround

Call labelCache.setMaxSize(n) (exported from the package index) with n above the number of distinct labels visible across all charts, as the SC-20 Avoid note suggests.

## Verify

measure.md#fps, stream scenario with fixed axis ranges on a 16-chart dashboard with about 300 distinct visible labels (run once with useNativeText: false), with a dev counter around getLabelTexture and getLabelSizesNative, 5 runs per side. Pass: the counter stays flat in the steady state instead of jumping about every 200 ms, and compare-runs shows "win" on longFramesPer10s or frameP99Ms.

## Other locations

- `esm/Charting/Visuals/SciChartSurface.js:1376` — pruneCache runs after every surface draw
- `esm/Charting/Visuals/Axis/LabelProvider/LabelCache.js:116` — The warning threshold only triggers above about 2x maxSize
- `esm/Charting/Visuals/Axis/LabelProvider/LabelProviderBase2D.js:163` — Canvas-text path re-rasterizes each evicted label

## Review notes

- Found by reviewer slice `s06-axis-text`.
- Adversarial verification (corrected): Re-read esm/Charting/Visuals/Axis/LabelProvider/LabelCache.js:1-194. The code_quote matches :102-114 verbatim, with the condition at the primary line :103. Caller chain confirmed: the only caller is SciChartSurface.onRenderSurfaceDraw (:1331), which calls labelCache.pruneCache() at :1376 after every surface draw; minAge (200 ms, :92) only throttles it. The cache is one module-level Map (:5) shared by every surface, keyed text|:|styleId (:35-37). With the default useSharedCache = true (SciChartDefaults.js:10), getCachedStyle (LabelProviderBase2D.js:528-536) uses providerId "native" in native mode and the wasm canvas id (SciChartSurface.js:1201-1203) in canvas-text mode. Re-creation path confirmed: AxisBase2D.measure calls getTicks(true) on every layout (:582), which calls getLabels (:1368). getLabels does labelCache.getLabel per tick (LabelProviderBase2D.js:136-153 canvas, :185-208 native); a miss calls getLabelTexture (:163) and setLabel, or collects the label for getLabelSizesNative (:226, :462-511: one CalculateStringBounds for all simple labels plus one GetLineBounds wasm object and one new LabelInfo per label). Eviction math checked: getLabel refreshes lastUsed (:48), LabelInfo starts with lastUsed = Date.now() (LabelProviderBase2D.js:18), the prune sorts by lastUsed and removes min(size/2, 2*(size-maxSize)) entries (:106) whatever their age. When the labels of surfaces that redraw exceed maxSize, every removed entry is still in use, so it is re-created on the next frame, about every 200 ms. The prune also sets label.bitmapTexture to undefined on the shared LabelInfo (:113). The warning needs toRemove > maxSize, i.e. size > 2*maxSize (:116). The library's own doc for minAge (:182-189) says it 'prevents recently used labels from being pruned', which the code does not do and the fix implements. The fix is correct: it walks the sorted array from the oldest entry and stops at the first one used within minAge. other_locations checked (SciChartSurface.js:1376, LabelCache.js:116, LabelProviderBase2D.js:163). The SC-20 Avoid note only recommends setMaxSize as tuning, which matches app_workaround and does not refute the library defect. Severity medium and evidence H are kept: the mechanism is certain once the label set exceeds 200, but whether an app reaches 200 labels depends on its chart count and ranges. Corrected scale: added that in canvas-text mode, surfaces from SciChartSurface.createSingle each have their own wasm canvas id, so identical label texts on different charts are separate cache entries and the threshold is reached sooner. Also added that a working set above about 2/3 of maxSize can lose some visible labels once the cache holds history, because of the x2 overshoot, but only once per history build-up, not continuously.

