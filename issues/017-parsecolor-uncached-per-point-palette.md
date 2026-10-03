# 017 · parseColorToUIntArgb re-parses the same color strings for every point on every render (no cache)

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/utils/parseColor.js:31` |
| Severity | **high** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (also INP when an interaction triggers the redraw) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
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
@@ -28,6 +28,17 @@
  * @returns
  */
+// Palette providers convert the same few color strings once per point per render: parse each string once.
+const uintArgbCache = new Map();
+const UINT_ARGB_CACHE_MAX = 512;
 export function parseColorToUIntArgb(input, opacity) {
-    return parseInt(parseColorToHexStringArgb(input, opacity), 16);
+    const key = opacity === undefined ? input : input + "|" + opacity;
+    let value = uintArgbCache.get(key);
+    if (value === undefined) {
+        value = parseInt(parseColorToHexStringArgb(input, opacity), 16); // invalid input still throws; nothing cached
+        if (uintArgbCache.size >= UINT_ARGB_CACHE_MAX) uintArgbCache.clear();
+        uintArgbCache.set(key, value);
+    }
+    return value;
 }
 (same pattern for parseColorToUIntAbgr at :34)
```

**Trade-off:** A module-level Map of at most 512 entries (string keys and numbers). Apps that build a unique color string per point gain nothing and pay a Map insert per miss plus a periodic clear. Cache only at the number level: parseColorToTArgb returns an object that applyOpacityToHtmlColor (colorUtil.js:116) mutates, so caching that object would corrupt colors. The per-point palette loop itself still runs every render because MetadataPaletteProvider lacks shouldUpdatePalette (palette-provider code, outside this slice).

## App-side workaround

Store numeric ARGB colors in metadata (parse once at load with parseColorToUIntArgb); MetadataPaletteProvider passes numbers through without parsing. In custom palette providers, hoist parseColorToUIntArgb out of the per-point callback and implement shouldUpdatePalette() returning false while data and thresholds are unchanged (SC-23).

## Verify

measure.md#fps, scenarios pan then zoom with no new data, on a scatter series of 100k points whose metadata carries stroke/fill color strings and paletteProvider: new MetadataPaletteProvider(); 5 runs per side. Pass: compare-runs 'win' on frameP95Ms, 'Minor GC' time per second in the trace-summary window goes down, and parseColorToTArgb disappears from LoAF topScripts after the first frame.

## Other locations

- `esm/Charting/Model/MetadataPaletteProvider.js:25` — overrideFillArgb parses metadata.fill per point
- `esm/Charting/Model/MetadataPaletteProvider.js:38` — overrideStrokeArgb parses metadata.stroke per point
- `esm/Charting/Model/IPaletteProvider.js:19` — documented example calls parseColorToUIntArgb("white") inside the per-point callback
- `esm/utils/parseColor.js:34` — parseColorToUIntAbgr, same uncached path
- `esm/utils/colorUtil.js:73` — linearColorMapLerp parses two gradient-stop strings on every call
- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/BaseSeriesDrawingProvider.js:108` — series stroke parsed per series per render
- `esm/Charting/Drawing/WebGlRenderContext2D.js:480` — drawNativeText parses textColor per text draw
- `esm/Charting/Visuals/Axis/AxisRenderer.js:243` — label color parsed per axis per frame
- `esm/Charting/Model/MetadataPaletteProvider.js:25` — same root cause, also reported by slice s08-data-series: MetadataPaletteProvider parses the same CSS color string for every point on every frame
- `esm/Charting/Model/MetadataPaletteProvider.js:38` — overrideStrokeArgb: same parse
- `esm/Charting/Model/MetadataPaletteProvider.js:64` — overridePointMarkerArgb parses stroke and fill, then allocates a {stroke, fill} object per marker per frame
- `esm/utils/parseColor.js:54` — Each call runs a RegExp match, 4x substr+parseInt, a validation array, a '0x..' string concat and another parseInt
- `esm/Charting/Visuals/RenderableSeries/DrawingProviders/BaseSeriesDrawingProvider.js:394` — The provider defines no shouldUpdatePalette, so requiresUpdate is set on every frame

## Review notes

- Found by reviewer slice `s09-filters-numerics-utils`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.
- Duplicate merged from slice `s08-data-series`: MetadataPaletteProvider parses the same CSS color string for every point on every frame
