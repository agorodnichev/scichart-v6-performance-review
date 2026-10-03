# 017 · parseColorToUIntArgb re-parses the same color strings for every point on every render (no cache)

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/utils/parseColor.js:31` |
| Severity | **high** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (also INP when an interaction triggers the redraw) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/802f7c181e1f4c2defa83613059e7e9e/): reproduced on WebGL and WebGPU ([source](../demos/017-parsecolor-uncached-per-point-palette/)) |
| Rule | V8-01, SC-23 (web-performance skill) |
| Effort to fix | small |

## Code

```js
export function parseColorToUIntArgb(input, opacity) {
    return parseInt(parseColorToHexStringArgb(input, opacity), 16);
}
```

## Call path and frequency

Every render, per visible point: SciChartRenderer draws each series -> PointMarkerDrawingProvider.draw (esm/Charting/Visuals/RenderableSeries/DrawingProviders/PointMarkerDrawingProvider.js:97) -> BaseSeriesDrawingProvider.applyStrokeFillPaletting (BaseSeriesDrawingProvider.js:234 shouldUpdatePalette; :394 sets requiresUpdate on every render because MetadataPaletteProvider defines no shouldUpdatePalette) -> per-point loop (BaseSeriesDrawingProvider.js:254-262) -> PointMarkerDrawingProvider.overridePaletteProviderColors (:129) -> MetadataPaletteProvider.overridePointMarkerArgb (esm/Charting/Model/MetadataPaletteProvider.js:53 and :59) -> parseColorToUIntArgb (parseColor.js:31). Two parses per point per render for markers; one per point for line/mountain strokes via applyStrokePaletting (BaseSeriesDrawingProvider.js:156) -> MetadataPaletteProvider.overrideStrokeArgb (:38). Also on pan/zoom frames with no data change.

## Why it costs

Nothing is cached. Each call runs parseColorToTArgb (a regex match array, 3-4 substr strings and parseInt calls, two array literals plus a forEach closure in validateColorValues, a result object; for named colors two failed regexes, toLowerCase and a recursive call), then four toString(16) strings, a concatenation and a second parseInt(...,16): roughly 15-20 short-lived allocations to map the same handful of strings to the same numbers. MetadataPaletteProvider has no shouldUpdatePalette, so the palette loop runs for every visible point on every render, and the built-in example at IPaletteProvider.js:19 teaches calling it per point. That is main-thread script time and young-generation GC pressure per frame proportional to the point count.

**Scale where it matters:** Any series using MetadataPaletteProvider with string colors in metadata, or an app palette provider that follows the documented pattern of calling parseColorToUIntArgb inside the per-point callback; cost is linear in visible points (10k-1M) and paid on every frame that redraws.

## Fix (library side)

```diff
--- a/esm/utils/parseColor.js
+++ b/esm/utils/parseColor.js
@@ -22,15 +22,32 @@ export function parseColorToHexStringAbgr(input, opacityOverride) {
         toHex(res.red));
 }
+// Palette providers convert the same few color strings once per point per render: parse each (input, opacity) pair once.
+// Cache numbers only: parseColorToTArgb returns an object that callers mutate (colorUtil.js:116 applyOpacityToHtmlColor).
+const UINT_COLOR_CACHE_MAX = 512;
+const uintArgbCache = new Map();
+const uintAbgrCache = new Map(); // separate map: the ABGR number for the same key differs
+function cachedUIntColor(cache, toHexString, input, opacity) {
+    const key = opacity === undefined || opacity === null ? input : input + "|" + opacity;
+    let value = cache.get(key);
+    if (value === undefined) {
+        value = parseInt(toHexString(input, opacity), 16); // invalid input still throws, and nothing is cached
+        if (cache.size >= UINT_COLOR_CACHE_MAX)
+            cache.clear();
+        cache.set(key, value);
+    }
+    return value;
+}
 /**
  * Converts HTML color to ARGB color
  * @param input HTML color string
  * @param opacity Opacity 0 to 255, where 0 fully transparent and 255 fully opaque
  * @returns
  */
 export function parseColorToUIntArgb(input, opacity) {
-    return parseInt(parseColorToHexStringArgb(input, opacity), 16);
+    return cachedUIntColor(uintArgbCache, parseColorToHexStringArgb, input, opacity);
 }
 export function parseColorToUIntAbgr(input, opacity) {
-    return parseInt(parseColorToHexStringAbgr(input, opacity), 16);
+    return cachedUIntColor(uintAbgrCache, parseColorToHexStringAbgr, input, opacity);
 }
```

**Trade-off:** A module-level Map of at most 512 entries (string keys and numbers). Apps that build a unique color string per point gain nothing and pay a Map insert per miss plus a periodic clear. Cache only at the number level: parseColorToTArgb returns an object that applyOpacityToHtmlColor (colorUtil.js:116) mutates, so caching that object would corrupt colors. The per-point palette loop itself still runs every render because MetadataPaletteProvider lacks shouldUpdatePalette (palette-provider code, outside this slice).

## App-side workaround

Store numeric ARGB colors in metadata (parse once at load with parseColorToUIntArgb); MetadataPaletteProvider passes numbers through without parsing. In custom palette providers, hoist parseColorToUIntArgb out of the per-point callback and implement shouldUpdatePalette() returning false while data and thresholds are unchanged (SC-23).

## Verify

measure.md#fps, scenarios pan then zoom with no new data, on a scatter series of 100k points whose metadata carries stroke/fill color strings and paletteProvider: new MetadataPaletteProvider(); 5 runs per side. Pass: compare-runs 'win' on frameP95Ms, 'Minor GC' time per second in the trace-summary window goes down, and parseColorToTArgb disappears from LoAF topScripts after the first frame.

## Other locations

- `esm/Charting/Model/MetadataPaletteProvider.js:25` — overrideFillArgb parses metadata.fill per point (same root cause also reported by slice s08-data-series)
- `esm/Charting/Model/MetadataPaletteProvider.js:38` — overrideStrokeArgb parses metadata.stroke per point
- `esm/Charting/Model/MetadataPaletteProvider.js:64` — overridePointMarkerArgb parses stroke and fill (:53, :59), then allocates a {stroke, fill} object per marker per render
- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/BaseSeriesDrawingProvider.js:394` — the provider defines no shouldUpdatePalette, so requiresUpdate is set on every render
- `esm/Charting/Model/IPaletteProvider.js:19` — documented example calls parseColorToUIntArgb("white") inside the per-point callback
- `esm/utils/parseColor.js:34` — parseColorToUIntAbgr, same uncached path
- `esm/utils/parseColor.js:54` — each call runs a RegExp match, 4x substr+parseInt, a validation array, a '0x..' string concat and another parseInt
- `esm/utils/colorUtil.js:73` — linearColorMapLerp parses two gradient-stop strings on every call
- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/BaseSeriesDrawingProvider.js:108` — series stroke parsed per series per render (also :201, :205)
- `esm/Charting/Drawing/WebGlRenderContext2D.js:480` — drawNativeText parses textColor per text draw
- `esm/Charting/Visuals/Axis/AxisRenderer.js:243` — label color parsed per axis per frame

## Review notes

- Found by reviewer slice `s09-filters-numerics-utils`.
- Adversarial verification (corrected): Re-read esm/utils/parseColor.js:31-33 (quote verbatim) and :49-87 (regex match, substr+parseInt x4, validateColorValues arrays+forEach closure, result object; named colors fall through two regexes, toLowerCase and recurse). Caller chain re-established: PointMarkerDrawingProvider.draw :97 -> BaseSeriesDrawingProvider.applyStrokeFillPaletting :176 -> shouldUpdatePalette :234 -> :394 sets requiresUpdate=true because MetadataPaletteProvider (esm/Charting/Model/MetadataPaletteProvider.js:3-66) defines neither shouldUpdatePalette nor isRangeIndependant (rg finds shouldUpdatePalette only on DefaultPaletteProvider IPaletteProvider.js:56) -> per-point loop :254-276 -> PointMarkerDrawingProvider.overridePaletteProviderColors :126-129 -> MetadataPaletteProvider.overridePointMarkerArgb :53/:59 -> parseColorToUIntArgb. Line/segment series: LineSeriesDrawingProvider.js:143 / LineSegmentSeriesDrawingProvider.js:120,158 -> applyStrokePaletting :98 -> :136/:394 -> loop :148-159 -> overrideStrokeArgb :156 -> MetadataPaletteProvider.js:38. No cache, dirty flag or early return defeats it; the loop count is the visible (possibly resampled) point count, every render including pan/zoom. Rule V8-01/SC-23 Avoid fields do not exempt this. Severity high (per point per frame) and evidence S kept. Corrected: (1) fix_diff did not apply (its hunk dropped the closing ' */' of the JSDoc at :30 and had wrong line counts) and left parseColorToUIntAbgr as prose; rewrote it as one helper with separate ARGB/ABGR maps. Tested in scratch (agent-scratch/s09v/t017.mjs): cached vs original identical for 10 inputs x 5 opacities (incl. null, invalid strings that throw), 0 mismatches. (2) other_locations had duplicate MetadataPaletteProvider.js:25/:38 entries from the s08 merge; deduplicated, all lines re-checked (colorUtil.js:73, WebGlRenderContext2D.js:480, AxisRenderer.js:243, BaseSeriesDrawingProvider.js:108).
- Duplicate merged from slice `s08-data-series`: MetadataPaletteProvider parses the same CSS color string for every point on every frame
