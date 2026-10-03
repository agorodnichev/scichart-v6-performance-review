# 066 · getFontKey does a linear for-in scan of the global label-style registry (and allocates) on every getFont call: per axis, data-label series, title and native text annotation, every frame

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Helpers/NativeObject.js:295` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Rule | V8-01 (web-performance skill) |
| Effort to fix | small |

## Code

```js
    const fontFamilyNative = getFontFamily(labelStyle.fontFamily, true);
    const useSlug = useSlugText;
    const newStyle = {
        fontFamily: fontFamilyNative,
        fontSize: labelStyle.fontSize,
        extras: useSlug ? "slug" : (advanced ? "advanced" : "") + (transformed ? "transformed" : ""),
        providerId: undefined
    };
    const styleId = labelCache.getStyleId(newStyle);
```

## Call path and frequency

SciChartRenderer.render -> drawLayers (esm/Charting/Services/SciChartRenderer.js:305) -> NativeTextAnnotation.drawWithContext (esm/Charting/Visuals/Annotations/NativeTextAnnotation.js:326) / NativeAxisRenderer.onBeginDrawLabels (esm/Charting/Visuals/Axis/NativeAxisRenderer.js:12) / BaseDataLabelProvider (esm/Charting/Visuals/RenderableSeries/DataLabels/BaseDataLabelProvider.js:165) / TitleRenderer (esm/Charting/Services/TitleRenderer.js:91) / LabelProviderBase2D (:176, :474) -> WebGlRenderContext2D.getFont (esm/Charting/Drawing/WebGlRenderContext2D.js:530-560) -> getFontKey (NativeObject.js:290-314) -> labelCache.getStyleId (LabelCache.js:8-24). Once per native-text element per frame; endFonts (WebGlRenderContext2D.js:562-581) once per surface per frame.

## Why it costs

Font keys already live in a per-context Map (keyCache). The global registry is consulted only to turn {family, size, extras} into an id, and that costs an O(S) for-in walk on every getFont call. for-in over integer-like keys does not use the enum cache, so each walk builds a key list and produces string keys before hasOwnProperty and checkTextStyleEqual run; the compare short-circuits on the first differing field, so each step is cheap, but the walk length grows with S. Entries are never removed except by resetCache, so in a long-lived app S only grows between context resets.

**Scale where it matters:** Cost is getFont calls per frame x S, where S is the number of styles in the global registry. With the default useSharedCache:true, label-provider styles are shared, so S grows with the distinct label styles (family, size, color, padding, rotation) and font keys seen in the session; with useSharedCache:false every label provider adds a GUID-keyed entry. A surface with 500 NativeTextAnnotations and S = 30 does 15,000 registry iterations per frame, plus 500 style literals, 1,000 toLowerCase strings and 500 Date.now() calls.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/Helpers/NativeObject.js
+++ b/esm/Charting/Visuals/Helpers/NativeObject.js
@@ getFontKey
     const fontFamilyNative = getFontFamily(labelStyle.fontFamily, true);
     const useSlug = useSlugText;
-    const newStyle = {
-        fontFamily: fontFamilyNative,
-        fontSize: labelStyle.fontSize,
-        extras: useSlug ? "slug" : (advanced ? "advanced" : "") + (transformed ? "transformed" : ""),
-        providerId: undefined
-    };
-    const styleId = labelCache.getStyleId(newStyle);
+    const extras = useSlug ? "slug" : (advanced ? "advanced" : "") + (transformed ? "transformed" : "");
+    // O(1) lookup in this context's own key cache; a font key depends only on family, size and extras
+    const styleId = `${fontFamilyNative}|${labelStyle.fontSize}|${extras}`;
     if (!keyCache.has(styleId)) {
```

**Trade-off:** Same semantics: a font-key style could only ever match another font-key style on fontFamily, fontSize and extras, because every label-provider style passed to getStyleId carries a defined providerId ('native', the wasm id or a GUID; LabelProviderBase2D.js:529-536) and font-key styles have providerId undefined. Font keys stop adding entries to the global registry. keyCache is dropped with deleteCache, which runs alongside every labelCache.resetCache (createMaster.js:253-255, :333-341; createSingle.js:201), so the new keys never outlive their context. A template-string key still allocates one short string per call; a nested Map would avoid that if a profile shows it.

## App-side workaround

None directly, since getFontKey is internal. Keep useSharedCache at its default (true) and keep the number of distinct text styles and NativeTextAnnotations small.

## Verify

measure.md#fps, `pan` scenario on a surface with 500 NativeTextAnnotations and 4 native-text axes, after creating charts with 30 distinct label styles, 5 runs per side. Pass: getFontKey/getStyleId self time in __wpProbe.loaf.read() topScripts drops; compare-runs gives 'win' or neutral on frameP95Ms. Not measured.

## Other locations

- `esm/Charting/Visuals/Axis/LabelProvider/LabelCache.js:8` — getStyleId: for-in over styleCache + hasOwnProperty + checkTextStyleEqual (short-circuit field compare) per entry, uses++ on a hit. freeStyle (:25-34) never removes entries; only resetCache (:140-157, on context loss or wasm-context cleanup) does
- `esm/Charting/Visuals/Helpers/NativeObject.js:309` — Date.now() on every call and an embind setter (m_reload = false) on every call after nativeFontTimeout (2000 ms)
- `esm/Charting/Drawing/WebGlRenderContext2D.js:569` — endFonts per surface per frame: getAllFontKeys (NativeObject.js:315-318) Array.from + map, then AquireFont + m_isDrawing (2 wasm calls) for every font key ever created on the context
- `esm/Charting/Visuals/Annotations/NativeTextAnnotation.js:326` — getFont per NativeTextAnnotation per frame

## Review notes

- Found by reviewer slice `s01-surface-render`.
- Adversarial verification (corrected): Quote matches verbatim at NativeObject.js:295-303 (primary moved from :303 to :295). Confirmed getFont -> getFontKey on every call (WebGlRenderContext2D.js:530-531) and per-frame callers NativeTextAnnotation.js:326, NativeAxisRenderer.js:12, BaseDataLabelProvider.js:165, TitleRenderer.js:91. Read LabelCache.js fully: getStyleId is a for-in scan with uses++; freeStyle never deletes the styleCache entry; resetCache is the only removal and is called on context loss and wasm-context cleanup. Corrected: checkTextStyleEqual short-circuits, so it is not an 11-field compare per entry; with the default useSharedCache:true (SciChartDefaults.js:10) S grows with distinct styles, not with axes; with false, each provider GUID adds an entry. Checked the fix's equivalence (providerId always defined for label-provider styles, LabelProviderBase2D.js:535) and that keyCache lifetimes follow deleteCache. Kept medium/H: per-frame path with cost proportional to calls x S, magnitude depends on S.

