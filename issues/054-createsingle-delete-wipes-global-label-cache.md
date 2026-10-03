# 054 · Deleting a createSingle chart resets the page-wide label/style cache: every live chart re-measures labels and each live context gains a new SCRTFontKey per font in use

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/createSingle.js:192` |
| Severity | **medium** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory (also frame time on the next frame of every other chart) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Rule | LIFE-05, SC-29 (web-performance skill) |
| Effort to fix | small |

## Code

```js
                    frameRenderer2D.delete();
                    wasmContext.SCRTGetGlobalRenderLoopManager().SetFrameRenderer(null);
                    wasmContext.SCRTGetGlobalRenderLoopManager().delete();
                    wasmContext.SCRTSetGlobalRenderLoopManager(null);
                    labelCache.resetCache();
                    licenseManager.clear();
```

## Call path and frequency

sciChartSurface.delete() on a createSingle chart -> SciChartSurfaceBase.delete deletables loop (esm/Charting/Visuals/SciChartSurfaceBase.js:481) -> createSingle deletable (createSingle.js:177-193) -> labelCache.resetCache (LabelCache.js:140-157). Then, on the next frame of every other live chart: WebGlRenderContext2D.getFont (Charting/Drawing/WebGlRenderContext2D.js:531) -> getFontKey (Helpers/NativeObject.js:303-306) -> getStyleId returns a new id (LabelCache.js:20-22) -> keyCache miss -> new SCRTFontKey stored, old one kept; LabelProviderBase2D.getLabels -> checkStyle false -> resetCache + new styleId (LabelProviderBase2D.js:115-117) -> all tick labels measured again. Once per createSingle delete; the font-key growth accumulates per cycle.

## Why it costs

The label cache and style registry are module-global and shared by all wasm contexts. Native-text entries hold only sizes and are context-independent, so wiping them is wasted work. Style ids are never reused, so every cache keyed by styleId (the NativeObject keyCache) grows with each reset: wasm objects that nobody frees until that context is disposed, which is unbounded growth over a long session. Whether AquireFont with a new key object also re-creates native font resources is decided in C++ and is not visible here (H for that part).

**Scale where it matters:** Pages that keep a long-lived chart (create(), or another createSingle) while createSingle charts are opened and closed repeatedly, for example modals, tabs or drill-downs. Each close adds one SCRTFontKey per distinct font (family and size, as used by axis labels, titles and data labels) in every live wasm context and triggers a full label re-measure in every live chart.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/Axis/LabelProvider/LabelCache.js
+++ b/esm/Charting/Visuals/Axis/LabelProvider/LabelCache.js
+/** Drops only the styles (and their label textures) owned by one wasm context; shared styles keep their ids */
+const resetCacheForProvider = (providerId) => {
+    for (const key in styleCache) {
+        const entry = styleCache[key];
+        if (entry && entry.style.providerId === providerId) {
+            clearCacheByStyle(key);
+            delete styleCache[key];
+        }
+    }
+};
 export const labelCache = {
@@
     resetCache,
+    resetCacheForProvider
 };
--- a/esm/Charting/Visuals/createSingle.js
+++ b/esm/Charting/Visuals/createSingle.js
-                    labelCache.resetCache();
+                    // Canvas-text labels of this context are keyed by providerId = its WebGL canvas id
+                    // (LabelProviderBase2D.getCachedStyle); native-text sizes and other contexts stay valid
+                    labelCache.resetCacheForProvider(webGlCanvasId);
```

**Trade-off:** Textures that belong to the deleted context are still released. Labels of providers with useSharedCache=false are already freed by their own label provider's delete (freeStyle). The global resetCache() stays available for context loss and full disposal.

## App-side workaround

Use create() for charts that come and go (SC-16), or keep createSingle surfaces alive and reuse them instead of deleting them.

## Verify

measure.md#mem: keep one create() chart rendering, then open and close a createSingle chart 10 + 10 times, sampling getAllFontKeys(wasmContext).length for the create() context and labelCache.getSize() after each close. Pass: the font-key count is flat after warm-up (slope within noise), and measure.md#fps over the same scenario shows no long frame on the surviving chart after each close.

## Other locations

- `esm/Charting/Visuals/Axis/LabelProvider/LabelCache.js:140` — resetCache deletes every label and every styleCache entry for all contexts. lastStyleId (:20) keeps counting, so style ids are never reused
- `esm/Charting/Visuals/Helpers/NativeObject.js:303` — getFontKey keys its per-context keyCache by styleId. A fresh id misses, so a new SCRTFontKey is created and the old one stays until deleteCache(context)
- `esm/Charting/Visuals/Axis/LabelProvider/LabelProviderBase2D.js:115` — checkStyle fails after the reset, so tickToText is cleared and labels are re-measured (native text) or re-rasterized (canvas text)
- `esm/Charting/Visuals/createMaster.js:333` — cleanupWasmContext also resets the global cache while createSingle charts may still be alive

## Review notes

- Found by reviewer slice `x2-data-and-lifecycle`.
- Adversarial verification (corrected): Re-read createSingle.js:177-193 (code_quote matches lines 188-193 verbatim; resetCache at :192), LabelCache.js:8-24 (getStyleId: lastStyleId++ at :20, ids never reused) and :140-158 (resetCache wipes all labels and all styleCache keys), NativeObject.js:18-41 (getCache keys objectCache by wasmContext.canvas.id, so one keyCache per wasm context) and :290-314 (getFontKey: getStyleId at :303, keyCache miss at :304-306 creates a new SCRTFontKey; old entries are freed only by deleteCache/freeCache, NativeObject.js:42-70). Callers: WebGlRenderContext2D.getFont (:531) is called from LabelProviderBase2D getLabelSizesNative (:474) and the native branch (:176), so every live context hits getFontKey on its next label draw. Delete chain confirmed: SciChartSurfaceBase.delete (:470) -> deletables loop (:481) -> createSingle deletable (:177-193). LabelProviderBase2D.getLabels (:111-118): checkStyle fails once the styleCache entry is gone, so tickToText is cleared and a new styleId assigned, then labels are re-measured/re-rasterized. No guard (no providerId filter, no context check) in resetCache. getWasmId (SciChartSurface.js:1201) returns webAssemblyContext2D.canvas.id, which for createSingle equals webGlCanvasId, so the fix's providerId match is correct; webGlCanvasId is in scope (createSingle.js:165); the deleted context's own keyCache is still freed by freeCache (createSingle.js:201). Font-key styles carry providerId undefined (NativeObject.js:301) and key on fontFamily + fontSize + extras only, so the growth is one SCRTFontKey per distinct font (family and size) in use, not per full text style: corrected title and scale. Kept medium: the per-cycle leak is a few small wasm key objects plus a one-time re-measure, on a once-per-close path. Evidence S stands (C++ font re-creation part already marked H in why_it_costs).

