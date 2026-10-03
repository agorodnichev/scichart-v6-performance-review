# 073 · NativeTextAnnotation with wrapTo re-wraps and re-measures its text on every frame, allocating one wasm LineBounds per word

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Annotations/NativeTextAnnotation.js:359` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | none (web-performance skill) |
| Effort to fix | small |

## Code

```js
                if (x2 > x1Input) {
                    wrapWidth = x2 - x1Input;
                }
            }
            text = wrapNativeText(this.text, wrapWidth, immediateFont, textBounds);
```

## Call path and frequency

SciChartRenderer.render -> getRenderContextAnnotationDrawFunction drawFn (SciChartRenderer.js:429 / :438) -> NativeTextAnnotation.drawWithContext (NativeTextAnnotation.js:311) -> wrapNativeText (:359 -> utils/text.js:6-56) -> font.CalculateStringBounds + textBounds.GetLineBounds per word. Rate: once per frame per NativeTextAnnotation with wrapTo set.

## Why it costs

Text, wrap width and font are usually identical from frame to frame, yet each frame splits and re-joins strings, measures all words in wasm, and creates and frees a native LineBounds per word. That is GC and JS-to-wasm crossing work for an unchanged result. The cost scales with annotation and word counts the library does not bound.

**Scale where it matters:** H: annotations x words per frame. For example, 50 wrapped notes of 20 words give about 1,000 wasm object create/delete pairs and 100 string-measure calls per frame on a streaming chart.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/Annotations/NativeTextAnnotation.js
+++ b/esm/Charting/Visuals/Annotations/NativeTextAnnotation.js
@@ -359 +359,7 @@
-            text = wrapNativeText(this.text, wrapWidth, immediateFont, textBounds);
+            const wrapKey = `${this.text}\u0000${wrapWidth}\u0000${immediateFont.GetFaceName()}\u0000${style.fontSize}\u0000${this.scale}\u0000${isAdvanced}`;
+            if (wrapKey !== this.lastWrapKey) {          // re-wrap only when an input changed
+                this.lastWrapKey = wrapKey;
+                this.lastWrappedText = wrapNativeText(this.text, wrapWidth, immediateFont, textBounds);
+            }
+            text = this.lastWrappedText;
```

**Trade-off:** One cached string per annotation. The face name is part of the key so a late-loaded font re-wraps. With EWrapTo.ViewRect, wrapWidth depends on x1, so pans miss the cache and keep today's cost.

## App-side workaround

Insert the line breaks ('\n') once in app code and leave wrapTo unset.

## Verify

measure.md#fps: 50 NativeTextAnnotations with wrapTo: EWrapTo.Annotation and 20-word text on a chart streaming one appendRange per frame for 10 s. Pass: LoAF script time attributed to drawWithContext/wrapNativeText drops, Minor GC time drops, and frame p95 wins or stays neutral.

## Other locations

- `esm/utils/text.js:21` — builds the measuring string, calls CalculateStringBounds, then per word GetLineBounds(i+1) + delete() (:30-34) and string joins

## Review notes

- Found by reviewer slice `s07-annotations-legend`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

