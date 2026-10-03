# 073 · NativeTextAnnotation with wrapTo re-wraps and re-measures its text on every frame, allocating one wasm LineBounds per word

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Annotations/NativeTextAnnotation.js:359` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/29302f94ef6f5ebe82cffd4ae0fafc3a/): reproduced on WebGL and WebGPU ([source](../demos/073-nativetext-wrap-remeasure/)) |
| Rule | none (web-performance skill) |
| Effort to fix | medium |

## Code

```js
                if (x2 > x1Input) {
                    wrapWidth = x2 - x1Input;
                }
            }
            text = wrapNativeText(this.text, wrapWidth, immediateFont, textBounds);
```

## Call path and frequency

SciChartRenderer.getAnnotationDrawFunctions (Services/SciChartRenderer.js:365-370) -> getRenderContextAnnotationDrawFunction drawFn (:405-438, drawWithContext at :429) -> NativeTextAnnotation.drawWithContext (NativeTextAnnotation.js:311) -> wrapNativeText (:359 -> utils/text.js:6-56) -> font.CalculateStringBounds + textBounds.GetLineBounds per word. Rate: once per render per NativeTextAnnotation with wrapTo set, so every frame on a streaming chart.

## Why it costs

Text and font are usually identical from frame to frame, yet each frame splits and re-joins strings, measures all words in wasm, and creates and frees a native LineBounds per word. That is GC and JS-to-wasm crossing work for word widths that have not changed. The wrap width itself is constant only for a numeric wrapTo: with EWrapTo.Annotation it follows the X visible range, and with EWrapTo.ViewRect the anchor position, so a cache must not depend on it for the wasm part. The cost scales with annotation and word counts that the library does not bound.

**Scale where it matters:** H: annotations x words per frame. For example, 50 wrapped notes of 20 words give about 1,000 wasm object create/delete pairs and 100 string-measure calls per frame on a streaming chart.

## Fix (library side)

```diff
--- a/esm/utils/text.js
+++ b/esm/utils/text.js
@@ -57 +57,33 @@ export const wrapNativeText = ...   (public export kept unchanged)
+/** Measure every word once in wasm; the result can be wrapped to any width by wrapMeasuredText */
+export const measureTextForWrap = (text, font, textBounds) => {
+    if (!text) return [];
+    return text.split("\n").map(lineText => {
+        if (!lineText) return null;
+        const words = lineText.split(" ");
+        const first = words[0].trim();
+        font.CalculateStringBounds(first + " " + first + "\n" + words.map(w => w.trim()).join("\n"), textBounds, 0);
+        const b0 = textBounds.GetLineBounds(0), b1 = textBounds.GetLineBounds(1);
+        const spaceWidth = b0.m_fWidth - 2 * b1.m_fWidth;
+        b0.delete(); b1.delete();
+        const widths = words.map((w, i) => { const b = textBounds.GetLineBounds(i + 1); const width = b.m_fWidth; b.delete(); return width; });
+        return { words, widths, spaceWidth };
+    });
+};
+/** Same line breaking as wrapNativeText, on cached widths: no wasm calls */
+export const wrapMeasuredText = (measured, maxWidth) => measured.map(m => {
+    if (!m) return "";
+    const { words, widths, spaceWidth } = m;
+    const lines = [];
+    let line = "";
+    let lineWidth = 0;
+    for (let i = 0; i < words.length; i++) {
+        lineWidth += (line !== "" ? spaceWidth : 0) + widths[i];
+        if (lineWidth > maxWidth) {
+            if (line === "") { lines.push(words[i]); lineWidth = 0; }
+            else { lines.push(line); line = words[i]; lineWidth = widths[i]; }
+        } else {
+            line = line + (line !== "" ? " " : "") + words[i];
+        }
+    }
+    lines.push(line);
+    return lines.join("\n");
+}).join("\n");
--- a/esm/Charting/Visuals/Annotations/NativeTextAnnotation.js
+++ b/esm/Charting/Visuals/Annotations/NativeTextAnnotation.js
@@ -12 +12 @@
-import { getFirstLineHeightToBaseline, getMultilineTextHeight, getNativeTextPosition, getTextHeightToBaseline, wrapNativeText } from "../../../utils/text";
+import { getFirstLineHeightToBaseline, getMultilineTextHeight, getNativeTextPosition, getTextHeightToBaseline, measureTextForWrap, wrapMeasuredText } from "../../../utils/text";
@@ -359 +359,15 @@
-            text = wrapNativeText(this.text, wrapWidth, immediateFont, textBounds);
+            if (wrapWidth === 0) {
+                text = this.text;   // wrapNativeText returns the text unchanged for width 0
+            } else {
+                // wasm measuring only when the text or the font changed (face name: a late-loaded font re-measures)
+                const measureKey = `${this.text}\u0000${immediateFont.GetFaceName()}\u0000${style.fontSize}\u0000${this.scale}\u0000${isAdvanced}`;
+                if (measureKey !== this.wrapMeasureKey) {
+                    this.wrapMeasureKey = measureKey;
+                    this.wrapMeasured = measureTextForWrap(this.text, immediateFont, textBounds);
+                    this.wrapWidthCached = undefined;
+                }
+                if (wrapWidth !== this.wrapWidthCached) {   // JS-only line breaking when the width changed
+                    this.wrapWidthCached = wrapWidth;
+                    this.wrappedText = wrapMeasuredText(this.wrapMeasured, wrapWidth);
+                }
+                text = this.wrappedText;
+            }
```

**Trade-off:** Per annotation, one cached array of word widths and one wrapped string. While the wrap width changes (EWrapTo.Annotation during zoom or with a moving visible range, EWrapTo.ViewRect when the anchor moves), the JS line-breaking loop and its string joins still run each frame, without wasm calls or LineBounds allocations. CalculateStringBounds on the final text (:362, and again at :366 when lineSpacing < 1) still runs on every render for every NativeTextAnnotation; caching that needs the bounds copied out of textBounds and is a larger change.

## App-side workaround

Insert the line breaks ('\n') once in app code and leave wrapTo unset.

## Verify

measure.md#fps: 50 NativeTextAnnotations with wrapTo: EWrapTo.Annotation and 20-word text on a chart streaming one appendRange per frame for 10 s, once with the X axis auto-ranging (so the wrap width changes every frame) and once with a fixed visible range. Pass in both runs: LoAF script time attributed to drawWithContext/wrapNativeText drops, Minor GC time drops, and frame p95 wins or stays neutral.

## Other locations

- `esm/utils/text.js:21` — builds the measuring string, calls CalculateStringBounds, then per word GetLineBounds(i+1) + delete() (:30-34) and string joins; public export (index.js:1155)
- `esm/Charting/Visuals/Annotations/NativeTextAnnotation.js:353` — EWrapTo.Annotation width is x2 - x1 in pixels and EWrapTo.ViewRect depends on x1 (:342-351), so the width changes with the visible range or the anchor position

## Review notes

- Found by reviewer slice `s07-annotations-legend`.
- Adversarial verification (corrected): Re-read NativeTextAnnotation.drawWithContext :311-417 (quote matches :355-359) and utils/text.js wrapNativeText :6-57. Path re-established: Services/SciChartRenderer.js getAnnotationDrawFunctions :365-370 (non-DOM, isVisible) -> getRenderContextAnnotationDrawFunction :405-438 adds drawFn per render -> drawWithContext :429 -> wrapNativeText :359 whenever wrapTo is set (setter :247-252, default undefined). No cache or dirty flag: each render runs CalculateStringBounds over a string of all words plus GetLineBounds(0), (1) and one per word, each an embind object freed with delete() (text.js:22-34); getTextBounds (Helpers/NativeObject.js:193-201) is cached, LineBounds are not. getFont (Drawing/WebGlRenderContext2D.js:530-557) exposes GetFaceName, which reads SCRT_Loading until a font loads, so keying on it is valid. Corrected: the original fix keyed the whole wrap on wrapWidth, but for EWrapTo.Annotation wrapWidth is x2 - x1 in pixels (:353-357), which changes on every frame whose X visible range changes (auto-range growth, scrolling window, zoom), and for EWrapTo.ViewRect it changes whenever the anchor moves (:342-351). That is the streaming case the issue targets, so that cache would miss every frame and the verify run would show no gain. The new fix caches the wasm word measurements keyed on text, face name, font size, scale and isAdvanced, and re-runs only the JS line-breaking loop when the width changes. A local harness (agent-scratch/t073/test.mjs) checked that measureTextForWrap + wrapMeasuredText return the same string as wrapNativeText for 100 text/width cases (empty, undefined, multi-line, double spaces, over-long words, NaN/Infinity/negative widths): 0 mismatches. The public wrapNativeText export (index.js:1155) is kept. Effort raised to medium (new helpers in two files). Severity medium and evidence H kept: per-render path, but cost depends on wrapped annotation and word counts.

