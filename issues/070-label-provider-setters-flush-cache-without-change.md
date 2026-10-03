# 070 · LabelProvider setters (precision, numericFormat, prefix, postfix, formatLabel...) flush the label caches even when the value is unchanged

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Axis/LabelProvider/LabelProvider.js:48` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time during pan, zoom or streaming |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | none (web-performance skill) |
| Effort to fix | small |

## Code

```js
    set numericFormat(value) {
        this.numericFormatProperty = value;
        this.invalidateParent();
    }
    /**
     * Gets or sets the precision to use when formatting
     */
    get precision() {
        return this.precisionProperty;
    }
    set precision(value) {
        this.precisionProperty = value;
        this.invalidateParent();
    }
```

## Call path and frequency

An app handler such as axis.visibleRangeChanged.subscribe(() => lp.precision = p), which runs per visibleRange change, i.e. per pointer move during pan or per frame with autorange → LabelProvider.js:49 → LabelProviderBase2D.invalidateParent (LabelProviderBase2D.js:548) → clearCache (:538-547) → labelCache.freeStyle (LabelCache.js:25-34) → clearCacheByStyle when the style has no other users (LabelCache.js:75-90: Array.from over every cache key, two substrings per key, texture deletes), and tickToText.clear(). On the next render, getLabels (LabelProviderBase2D.js:109) does a linear getStyleId scan (LabelCache.js:8), re-formats every label, and re-creates every label texture (canvas text, through the full-canvas clear) or re-measures every label natively.

## Why it costs

Only rotation, the SmartDateLabelProvider properties and useNativeText check for equality. The other setters always call invalidateParent, which discards the tick-to-text map and, if no other axis shares the style, every cached label of that style. Assigning the same value therefore turns a fully cached frame into a frame that re-creates every label.

**Scale where it matters:** Applies to apps that write any LabelProvider property from visibleRangeChanged, a data handler or a render callback: that is one full flush of the axis's label caches per write. The library itself never calls these setters per frame (checked with a grep), so the rate depends on the app.

## Fix (library side)

```diff
--- esm/Charting/Visuals/Axis/LabelProvider/LabelProvider.js
     set numericFormat(value) {
+        if (this.numericFormatProperty === value)
+            return;
         this.numericFormatProperty = value;
         this.invalidateParent();
     }
@@
     set precision(value) {
+        if (this.precisionProperty === value)
+            return;
         this.precisionProperty = value;
         this.invalidateParent();
     }
 (same guard for cursorNumericFormat, cursorPrecision, prefix, postfix, formatLabel, formatCursorLabel, and NumericLabelProvider.engineeringPrefix)
```

**Trade-off:** Code that re-assigned the same value to force a refresh (for example after changing state read by a custom formatLabel) no longer flushes, and must call labelProvider.invalidateParent() explicitly. Leave TextLabelProvider.labels without the guard, because apps mutate that array in place and re-assign it.

## App-side workaround

Compare before writing: if (lp.precision !== p) lp.precision = p; (same for numericFormat, prefix and the others).

## Verify

measure.md#fps, pan scenario with a visibleRangeChanged handler that writes the same precision on every event, with a dev counter around getLabelTexture and getLabelSizesNative, 5 runs per side. Pass: the counter stays flat during the pan once labels are cached, and compare-runs shows "win" on frameP95Ms.

## Other locations

- `esm/Charting/Visuals/Axis/LabelProvider/LabelProvider.js:101` — The formatLabel setter flushes even for the same function
- `esm/Charting/Visuals/Axis/LabelProvider/NumericLabelProvider.js:37` — engineeringPrefix setter, same pattern
- `esm/Charting/Visuals/Axis/LabelProvider/LabelProviderBase2D.js:538` — clearCache frees the style and clears tickToText
- `esm/Charting/Visuals/Axis/LabelProvider/LabelCache.js:75` — clearCacheByStyle scans the whole global cache with substring parsing per key

## Review notes

- Found by reviewer slice `s06-axis-text`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

