# 010 · Date labels and cursor/tooltip values call toLocaleDateString(locale, options), which builds a new ICU formatter on every call, on every pointer move

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/utils/date.js:6` |
| Severity | **high** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time during hover/rollover (pointer-move handler script time) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
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

Runs per pointermove, with no rAF coalescing: RolloverModifier.modifierMouseMove calls update() at esm/Charting/ChartModifiers/RolloverModifier.js:273 → calcTooltipProps at RolloverModifier.js:586 (once per hit series) → getTooltipSize at RolloverModifier.js:683 → esm/Charting/Visuals/RenderableSeries/RolloverModifier/RolloverModifierRenderableSeriesProps.js:127 dataTemplate → esm/Charting/Visuals/Annotations/rolloverTooltipSvgAnnotationHelpers.js:3 getValuesWithLabels → esm/Charting/Model/ChartData/XySeriesInfo.js:8 formattedXValue → esm/Charting/Model/ChartData/SeriesInfo.js:55 xAxis.labelProvider.formatCursorLabel → esm/Charting/Visuals/Axis/LabelProvider/SmartDateLabelProvider.js:136-139 (cursorNumericFormat defaults to Date_DDMMYYYY, line 108) → esm/utils/number.js:30 → esm/utils/date.js:6. The same chain runs again on every render through RolloverModifier.onParentSurfaceLayoutComplete (RolloverModifier.js:295). Other callers: SeriesInfo.equals (SeriesInfo.js:64-65) from RolloverLegendSvgAnnotation.js:37 adds 2 more calls per series; CursorModifier.js:658 runs per tooltip update; drawLabel.js:363 getLabelValue runs per render for every line or axis-marker annotation label on a date axis. CategoryAxis uses DateLabelProvider by default (CategoryAxis.js:29), which also formats axis labels this way, on tickToText cache misses only.

## Why it costs

V8 caches the ICU formatter behind Date.prototype.toLocaleDateString only when no options object is passed. Every call here passes options, so each call resolves the locale and builds a new ICU DateTimeFormat before it formats one date. A Node sanity check showed roughly a 20x gap per call against a reused formatter (mechanism check only, not app timing). This sits on the pointer-move path and multiplies by the series count.

**Scale where it matters:** DateTimeNumericAxis, DiscontinuousDateAxis (SmartDate) or CategoryAxis (DateLabelProvider) with RolloverModifier or CursorModifier: at least one formatter per hit series per pointer move, and 3 per series with the rollover legend. With 10 series that is 10–30 new ICU DateTimeFormat objects per pointer move, plus one per render.

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

**Trade-off:** A few Intl.DateTimeFormat objects stay alive for the page lifetime: one per locale and option set. Output is identical for valid dates, and invalid dates still return "" through the explicit check. A formatter without a timeZone option captures the default time zone when it is created. V8 already caches the default zone, so an OS time-zone change during the session needs a reload in both versions.

## App-side workaround

Override the cursor formatter with one cached formatter, for example const fmt = new Intl.DateTimeFormat("en-US", { month: "numeric", day: "numeric", year: "numeric" }); xAxis.labelProvider.formatCursorLabel = v => fmt.format(new Date(v * 1000)). For SmartDate, convert v using datePrecision and dateOffset. Alternatively, set cursorLabelFormat to ENumericFormat.Date_HHMMSS or Date_HHMM, which use getUTC* and no Intl.

## Verify

measure.md#fps with a hover scenario: scripted pointer moves across a DateTimeNumericAxis chart with RolloverModifier and 10 XyDataSeries, 5 s, 5 runs per side. Pass: compare-runs reports "win" on frameP95Ms. In __wpProbe.loaf.read() topScripts, formatUnixDateToHumanString and toLocaleDateString no longer appear. A dev counter around new Intl.DateTimeFormat stays at the number of distinct locales after warm-up.

## Other locations

- `esm/utils/date.js:17` — formatUnixDateToHumanStringDDMMYY: same per-call ICU construction (en-GB, UTC)
- `esm/utils/date.js:34` — formatUnixDateToHumanStringDDMM, which Date_DDMMHHMM also uses
- `esm/Charting/Visuals/Axis/LabelProvider/SmartDateLabelProvider.js:108` — cursorLabelFormat defaults to Date_DDMMYYYY, so every cursor value goes through date.js:6
- `esm/Charting/Visuals/Axis/LabelProvider/DateLabelProvider.js:19` — Default label and cursor format is Date_DDMMYYYY; CategoryAxis.js:29 uses this provider by default
- `esm/Charting/Model/ChartData/SeriesInfo.js:64` — equals() formats the X and Y values for both objects on every rollover update
- `esm/Charting/Visuals/Helpers/drawLabel.js:363` — getLabelValue → formatCursorLabel runs per render for each line or axis-marker annotation label without an explicit value

## Review notes

- Found by reviewer slice `s06-axis-text`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

