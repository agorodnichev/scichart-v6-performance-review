# 069 · labelCache.pruneCache evicts labels that are on screen whenever the visible label set exceeds maxSize (200), every 200 ms, and they are re-created on the next frame

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Axis/LabelProvider/LabelCache.js:103` |
| Severity | **medium** |
| Pipeline stage | GPU upload (`gpu-upload`) |
| Metric | frame time (periodic long frames; also wasm/GPU texture churn) |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
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

**Scale where it matters:** Applies when the distinct label texts and styles visible across all surfaces exceed maxSize (default 200), e.g. 16 or more charts x 2 axes x ~8 labels with different ranges. With 260 visible labels, each prune removes min(130, 120) = 120 of them, all still on screen, about 5 times per second.

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
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

