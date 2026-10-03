# 070 · LabelProvider setters (precision, numericFormat, prefix, postfix, formatLabel...) flush the label caches even when the value is unchanged

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/Axis/LabelProvider/LabelProvider.js:48` |
| Severity | **low** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time during pan, zoom or streaming |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/9ca6469f124d3627be377f43812194a0/): reproduced on WebGL and WebGPU ([source](../demos/070-label-provider-setters-flush-cache/)) |
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

Only rotation, useNativeText and the SmartDateLabelProvider properties check for equality. The other setters always call invalidateParent, which clears this provider's tick-to-text map, frees its label style and schedules a redraw. On the next frame every visible tick is formatted again. If no other axis shares the style, freeStyle also runs clearCacheByStyle: one scan of the global cache, and a new texture (canvas text) or native measurement for every label. With the default shared cache, X and Y axes with the default labelStyle share one style, so the full flush happens only for an axis with its own style, such as a coloured Y axis, rotated labels or useSharedCache: false. The label cache is keyed by text, so even a real format change does not need the flush for correctness; a same-value write gains nothing from it.

**Scale where it matters:** Applies only to apps that write a LabelProvider property from visibleRangeChanged, a data handler or a render callback. The library never calls these setters after construction (checked with rg), so the rate depends entirely on the app. Each such write re-formats every visible tick of that axis. For an axis whose label style is unique, it also discards and re-creates all of that axis's cached labels, about 5 to 20 per axis per write.

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
 (same guard for cursorNumericFormat, cursorPrecision, prefix, postfix, formatLabel, formatCursorLabel, NumericLabelProvider.engineeringPrefix, LabelProviderBase2D.lineSpacing and TextLabelProvider.maxLength)
```

**Trade-off:** Code that re-assigned the same value to force a refresh (for example after changing state read by a custom formatLabel) no longer flushes, and must call labelProvider.invalidateParent() explicitly. Leave TextLabelProvider.labels without the guard, because apps mutate that array in place and re-assign it.

## App-side workaround

Compare before writing: if (lp.precision !== p) lp.precision = p; (same for numericFormat, prefix and the others).

## Verify

measure.md#fps, pan scenario on a chart with a Y axis whose labelStyle is unique (for example a custom colour) and a visibleRangeChanged handler that writes the same precision on every event, with a dev counter around getLabelTexture and getLabelSizesNative, 5 runs per side. Pass: the counter stays flat during the pan once labels are cached, and compare-runs shows "win" or "no change" on frameP95Ms. With default shared styles the counter stays flat even without the fix; only formatLabel calls drop.

## Other locations

- `esm/Charting/Visuals/Axis/LabelProvider/LabelProvider.js:101` — The formatLabel setter flushes even for the same function
- `esm/Charting/Visuals/Axis/LabelProvider/NumericLabelProvider.js:37` — engineeringPrefix setter, same pattern
- `esm/Charting/Visuals/Axis/LabelProvider/LabelProviderBase2D.js:101` — lineSpacing setter, same pattern
- `esm/Charting/Visuals/Axis/LabelProvider/TextLabelProvider.js:57` — maxLength setter, same pattern
- `esm/Charting/Visuals/Axis/LabelProvider/LabelProviderBase2D.js:538` — clearCache frees the style and clears tickToText
- `esm/Charting/Visuals/Axis/LabelProvider/LabelCache.js:25` — freeStyle runs clearCacheByStyle (:75, a scan of the whole global cache with substring parsing per key) only when the style has no other users

## Review notes

- Found by reviewer slice `s06-axis-text`.
- Adversarial verification (corrected): Re-read esm/Charting/Visuals/Axis/LabelProvider/LabelProvider.js:1-139. The code_quote matches :38-51 verbatim, with the precision setter at the primary line :48. The chain was confirmed: every LabelProvider setter (:38-118) calls invalidateParent, LabelProviderBase2D.invalidateParent (:548-551) calls clearCache (:538-547), which calls labelCache.freeStyle(styleId) and tickToText.clear(), then super.invalidateParent calls parentAxis.invalidateParentCallback, which schedules a redraw. freeStyle (LabelCache.js:25-34) decrements uses and calls clearCacheByStyle (:75-90) only at 0. The next getLabels (LabelProviderBase2D.js:109) calls getStyleId again (LabelCache.js:8-24), re-formats every tick because tickToText is empty, and re-creates labels that are missing from the cache. Hot path: rg over esm finds no library code that writes precision, numericFormat, cursor*, prefix, postfix, formatLabel, formatCursorLabel or engineeringPrefix after construction. The only writes are the constructors of the data-label providers (HeatMapDataLabelProvider.js:21, ContoursDataLabelProvider.js:22), and SmartDateLabelProvider.numericFormat is a no-op (:280-282). The rate therefore depends entirely on app code. Refuting detail: the full re-create happens only when this provider is the last user of its style. By default every axis gets the same labelStyle (AxisBase2D.js:465-473: same font, padding and alignment Auto) and useSharedCache is true (SciChartDefaults.js:10). getCachedStyle (LabelProviderBase2D.js:528-536) then gives X and Y axes, and every chart on the same wasm context, one shared styleId with uses >= 2. In that default case, a same-value write costs only the tickToText clear, so the next frame calls formatLabel once per visible tick and hits the cache, plus one getStyleId scan. The full flush (clearCacheByStyle, then a new texture or native measurement for every label) needs an axis whose style no other axis shares: a custom labelStyle, for example a coloured Y axis in a multi-axis chart, a rotation, or useSharedCache: false (unique providerId). Also found: lineSpacing (LabelProviderBase2D.js:101-104) and TextLabelProvider.maxLength (TextLabelProvider.js:57-60) have no guard either. rotation, useNativeText and the SmartDateLabelProvider setters do have one. Corrected: severity medium -> low, because the trigger is only an app writing the same value from a hot handler, with no library caller, and the default shared-style case costs only re-formatting about 10 ticks. Also corrected why_it_costs, scale and verify (the verify must use an axis with a unique style, or the counter does not move even without the fix), and added the two unguarded setters to fix_diff and other_locations. Evidence stays H.

