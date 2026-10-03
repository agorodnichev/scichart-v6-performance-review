# 010 · Date labels and cursor/tooltip values call toLocaleDateString(locale, options), which builds a new ICU formatter on every call, on every pointer move

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/utils/date.js:5` |
| Severity | **high** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time during hover/rollover (pointer-move handler script time) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Rule | V8-09 (web-performance skill) |
| Effort to fix | small |

## Code

```js
export const formatUnixDateToHumanString = (unixTimestamp, locale = "en-US") => {
    const res = new Date(unixTimestamp * 1000).toLocaleDateString(locale, {
        month: "numeric",
        year: "numeric",
        day: "numeric"
    });
    if (res === "Invalid Date") {
        return "";
    }
    return res;
```

## Call path and frequency

Runs per pointermove, with no rAF coalescing: MouseManager.js:70/107-114 calls RolloverModifier.modifierMouseMove, which calls update() at esm/Charting/ChartModifiers/RolloverModifier.js:273 -> updateSeriesAnnotations -> calcTooltipProps at RolloverModifier.js:586. With the default hitTestRadius 0 (:65) this runs for every included series whose hit Y is in view. -> rs.getSeriesInfo -> getTooltipSize at RolloverModifier.js:683 -> esm/Charting/Visuals/RenderableSeries/RolloverModifier/RolloverModifierRenderableSeriesProps.js:127 dataTemplate -> esm/Charting/Visuals/Annotations/rolloverTooltipSvgAnnotationHelpers.js:3 getValuesWithLabels -> esm/Charting/Model/ChartData/XySeriesInfo.js:8 formattedXValue -> esm/Charting/Model/ChartData/SeriesInfo.js:55 xAxis.labelProvider.formatCursorLabel -> esm/Charting/Visuals/Axis/LabelProvider/SmartDateLabelProvider.js:136-139 (cursorNumericFormat defaults to Date_DDMMYYYY, line 108; DateLabelProvider.js:19/24-26 is the same) -> esm/utils/number.js:30 -> esm/utils/date.js:6. The same chain runs again on the render that follows: SciChartRenderer.js:174/181 -> RolloverModifier.onParentSurfaceLayoutComplete (:295) -> update(). The tooltip SVG reuses the cached lines (RolloverTooltipSvgAnnotation.js:159-160). Default CursorModifier (isSvgOnly:true, showAxisLabels:true, CursorModifier.js:129-130): per render, SciChartRenderer.js:396 -> SvgLineAnnotation.update -> drawSvgAxisLabel -> SvgLineAnnotation.js:300 getLabelValue -> drawLabel.js:363 formatCursorLabel, once for the X-axis label. Opt-in callers: CursorModifier.js:658 when showTooltip:true (default false, :78) formats once per hit series per tooltip update. RolloverModifier with tooltipLegendTemplate (:467-468) builds the legend infos -> RolloverLegendSvgAnnotation.js:37 SeriesInfo.equals. Its && chain reaches formattedXValue (SeriesInfo.js:65) for both infos only when the series, isHit, hit point and formatted Y are unchanged. drawLabel.js:22/49 -> :363 runs per render for each render-context line or axis-marker annotation label with no explicit value. CategoryAxis uses DateLabelProvider by default (CategoryAxis.js:29), which formats axis labels the same way, but only on tickToText cache misses (LabelProviderBase2D.js:132-155).

## Why it costs

V8 caches the ICU formatter behind Date.prototype.toLocaleDateString only when the call passes no options object (JSDateTimeFormat::ToLocaleDateTime). Every call here passes options, so each call resolves the locale and builds a new ICU DateTimeFormat before it formats one date, then discards it. This is on the pointer-move and hover-render path and multiplies by the number of series in view. Not measured. The verify recipe below would measure it.

**Scale where it matters:** DateTimeNumericAxis or DiscontinuousDateAxis (SmartDate), or a CategoryAxis (DateLabelProvider), with RolloverModifier: one new ICU DateTimeFormat per series in view on each pointermove, and as many again on the render that follows. That is about 2N per hovered frame, so 10 series give about 20 per frame, plus the legend comparisons when a tooltipLegendTemplate is set. A default CursorModifier adds one per render for its X-axis label, plus one per hit series when showTooltip is enabled.

## Fix (library side)

```diff
--- esm/utils/date.js
+const dateFormatters = new Map();
+// toLocaleDateString(locale, options) builds a new ICU formatter per call; keep one per locale+options
+const formatDate = (unixTimestamp, key, locale, options) => {
+    const date = new Date(unixTimestamp * 1000);
+    if (isNaN(date.getTime())) {
+        return ""; // format() throws where toLocaleDateString returned "Invalid Date"
+    }
+    let f = dateFormatters.get(key);
+    if (!f) {
+        f = new Intl.DateTimeFormat(locale, options);
+        dateFormatters.set(key, f);
+    }
+    return f.format(date);
+};
 export const formatUnixDateToHumanString = (unixTimestamp, locale = "en-US") => {
-    const res = new Date(unixTimestamp * 1000).toLocaleDateString(locale, {
-        month: "numeric",
-        year: "numeric",
-        day: "numeric"
-    });
-    if (res === "Invalid Date") {
-        return "";
-    }
-    return res;
+    return formatDate(unixTimestamp, "dmy|" + locale, locale, { month: "numeric", year: "numeric", day: "numeric" });
 };
 export const formatUnixDateToHumanStringDDMMYY = (unixTimestamp) => {
-    const res = new Date(unixTimestamp * 1000).toLocaleDateString("en-GB", { timeZone: "utc", year: "2-digit", month: "2-digit", day: "2-digit" });
-    ...
+    return formatDate(unixTimestamp, "ddmmyy", "en-GB", { timeZone: "utc", year: "2-digit", month: "2-digit", day: "2-digit" });
 };
 (same change for formatUnixDateToHumanStringDDMM, key "ddmm")
```

**Trade-off:** A few Intl.DateTimeFormat objects stay alive for the page lifetime: one per locale and option set. Output is identical for valid dates (checked in Node for the DDMMYYYY, DDMMYY and DDMM option sets), and invalid dates still return "" through the explicit isNaN check. A cached formatter without a timeZone option (Date_DDMMYYYY) keeps the default time zone it resolved when it was created. If the OS time zone changes mid-session, toLocaleDateString can pick up the new zone once the browser notifies V8, but the cached formatter keeps the old zone until reload or a cache clear. The DDMMYY and DDMM formatters pin timeZone "utc" and are unaffected.

## App-side workaround

Override the cursor formatter with one cached formatter, for example const fmt = new Intl.DateTimeFormat("en-US", { month: "numeric", day: "numeric", year: "numeric" }); xAxis.labelProvider.formatCursorLabel = v => fmt.format(new Date(v * 1000)). For SmartDate, convert v using datePrecision and dateOffset. Alternatively, set cursorLabelFormat to ENumericFormat.Date_HHMMSS or Date_HHMM, which use getUTC* and no Intl.

## Verify

measure.md#fps with a hover scenario: scripted pointer moves across a DateTimeNumericAxis chart with RolloverModifier and 10 XyDataSeries, 5 s, 5 runs per side. Pass: compare-runs reports "win" on frameP95Ms. In __wpProbe.loaf.read() topScripts, formatUnixDateToHumanString and toLocaleDateString no longer appear. A dev counter around new Intl.DateTimeFormat stays at the number of distinct locales after warm-up.

## Other locations

- `esm/utils/date.js:17` — formatUnixDateToHumanStringDDMMYY: same per-call ICU construction (en-GB, UTC)
- `esm/utils/date.js:34` — formatUnixDateToHumanStringDDMM, which Date_DDMMHHMM also uses
- `esm/Charting/Visuals/Axis/LabelProvider/SmartDateLabelProvider.js:108` — cursorLabelFormat defaults to Date_DDMMYYYY, so every cursor value goes through date.js:6
- `esm/Charting/Visuals/Axis/LabelProvider/DateLabelProvider.js:19` — Default label and cursor format is Date_DDMMYYYY; CategoryAxis.js:29 uses this provider by default
- `esm/Charting/Visuals/Annotations/SvgLineAnnotation.js:300` — Default CursorModifier (isSvgOnly, showAxisLabels) formats its X-axis label through getLabelValue -> formatCursorLabel on every render
- `esm/Charting/Model/ChartData/SeriesInfo.js:64` — equals() formats X and Y for both infos, only with a RolloverModifier tooltipLegendTemplate, and only when the earlier && terms match
- `esm/Charting/Visuals/Helpers/drawLabel.js:363` — getLabelValue -> formatCursorLabel runs per render for each line or axis-marker annotation label without an explicit value
- `esm/Charting/ChartModifiers/CursorModifier.js:658` — Cursor tooltip data template: one format per hit series per update, only with showTooltip:true (default false)

## Review notes

- Found by reviewer slice `s06-axis-text`.
- Adversarial verification (corrected): Re-read esm/utils/date.js:1-79. The code_quote matches verbatim but starts at line 5 (the export line), not 6, so primary.line is now 5. date.js:17 (DDMMYY) and :34 (DDMM) make the same call with an options object. The HH/MM/SS helpers (:44-79) use getUTC* and no Intl. Caller chain re-established: MouseManager.js:70 adds a pointermove listener. onPointerMove (:107-114) calls modifierMouseMove synchronously, with no rAF coalescing. RolloverModifier.modifierMouseMove calls update() at :273, because getIsActionAllowed returns true in the base class (ChartModifierBase.js:258). update (:464) -> updateSeriesAnnotations. With the default hitTestRadius 0 (:65), calcTooltipProps (:586) runs for every included series whose hit Y is in view, not only hit series. Then rs.getSeriesInfo -> getTooltipSize (:683) -> RolloverModifierRenderableSeriesProps.js:127 dataTemplate -> rolloverTooltipSvgAnnotationHelpers.js:3 -> XySeriesInfo.js:8 formattedXValue -> SeriesInfo.js:48-55 xAxis.labelProvider.formatCursorLabel. The label providers: LabelProvider.js:112 returns formatCursorLabelProperty. SmartDateLabelProvider.js:136-139 and DateLabelProvider.js:24-26 both call formatNumber with cursorNumericFormat. That defaults to Date_DDMMYYYY (SmartDate :108, Date :19, set in LabelProvider.js:13). number.js:30 -> date.js:6. DateTimeNumericAxis.js:20 and DiscontinuousDateAxis.js:21 create a SmartDateLabelProvider by default, and CategoryAxis.js:29 creates a DateLabelProvider. The render path repeats the chain: SciChartRenderer.js:174/181 -> onParentSurfaceLayoutComplete (RolloverModifier.js:294-295) -> update(). The tooltip SVG reuses the cached lines (RolloverTooltipSvgAnnotation.js:159-160), so it does not format a third time. No cache, memo or dirty flag guards formatCursorLabel. Found a default caller the original missed. CursorModifier defaults to isSvgOnly:true and showAxisLabels:true (CursorModifier.js:129-130). Per render, SciChartRenderer.js:396 runs annotation.update -> SvgLineAnnotation.js:218-242 drawSvgAxisLabel -> :300 getLabelValue -> drawLabel.js:363 formatCursorLabel. Corrected two callers. CursorModifier.js:658 runs only with showTooltip:true, which defaults to false (CursorModifier.js:78). SeriesInfo.equals runs only when tooltipLegendTemplate is set (RolloverModifier.js:467-468 -> RolloverLegendSvgAnnotation.js:37). Its && chain also reaches formattedXValue (:65) only when the series, isHit, hit point and formatted Y all match the previous info. SmartDate axis labels (formatSmartLabel/formatDatePrecise) use the getUTC helpers, and only the unreachable default branch (:415) uses DDMMYY. DateLabelProvider axis labels use the tickToText cache (LabelProviderBase2D.js:132-155/184-199). Mechanism: V8 JSDateTimeFormat::ToLocaleDateTime caches the ICU formatter only when options is undefined. The rule V8-09 Avoid clause does not excuse this case. Node check in agent-scratch/v-intl.js: cached Intl.DateTimeFormat output equals toLocaleDateString for the DDMMYYYY, DDMMYY and DDMM option sets. format() on an invalid Date throws RangeError where toLocaleDateString returns "Invalid Date", so the fix needs its isNaN guard, which it has. The fix diff is correct and minimal. Severity high and evidence S are kept: the code runs per pointermove and per render while hovering. CORRECTED: primary.line 6 -> 5. why_it_costs drops the micro-benchmark timing ratio (review.md section B allows no timing numbers on S findings). call_path, scale and other_locations now include the default CursorModifier SVG axis-label path, give the real per-frame multiplier (about 2N per hovered frame) and mark the opt-in callers as opt-in. trade_off on time-zone change is corrected.

