# 068 · The Builder parses definition strings with a reviver, so JSON.parse calls chartReviver for every value, including every data point in xValues/yValues

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Builder/helpers/chartReviver.js:6` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | INP (also startup) |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/71126198c5d1a455cadbf67b18fa17a9/): reproduced on WebGL and WebGPU ([source](../demos/068-builder-json-reviver-per-point/)) |
| Rule | V8-10 (web-performance skill) |
| Effort to fix | small |

## Code

```js
export function chartReviver(key, value) {
    switch (key) {
        case "visibleRange":
        case "visibleRangeLimit":
        case "visibleRangeSizeLimit":
        case "growBy":
            return new NumberRange(value.min, value.max);
        case "padding":
            const t = value;
            return new Thickness(t.top, t.right, t.bottom, t.left);
        default:
            // handle NaN serialization/deserialization since NaN is stringified as "null"
            return value === null ? NaN : value;
    }
}
```

## Call path and frequency

buildChart(divId, jsonString) (chartBuilder.js:22), build2DChart (dispatch/build2DChart.js:22), build2DPolarChart (:22), build3DChart (:22), buildPieChart (:19), buildSeries (dispatch/series.js:65, :68, :121, :124), buildDataSeries (dispatch/dataSeries.js:26, :29, :78, :81), axes.js:20, modifiers.js:20/:53, annotations.js:17, chartBuilder.js:55 -> JSON.parse(definition, chartReviver) -> chartReviver(key, value) once per JSON value, bottom-up, including every array element with its index as a string key. In build2DChart the parse finishes before SciChartSurface.create (build2DChart.js:21-33). Runs once per build call: at startup, or in an 'open saved chart' interaction.

## Why it costs

A reviver makes the parser walk the whole result and call a JS function per value, with a string key for each array index; support.md §B notes the reviver path stays several times slower than no reviver even with Chrome 143's two-parameter detection. Only five keys need reviving; everything else is null -> NaN, which a plain loop does without a call per element. The cost scales with the inline data size, which the code does not fix. Hypothesis, not measured.

**Scale where it matters:** Only definitions that carry inline data (xyData, heatmapData or sharedData from toJSON(true) or a server): two reviver calls per XY point, so 1M points means 2M JS calls in one task. Definitions without inline data have a few hundred values and the cost is negligible.

## Fix (library side)

```diff
--- esm/Builder/helpers/chartReviver.js
+/** Same result as JSON.parse(text, chartReviver), without a callback per array element. */
+export function parseDefinition(text) {
+    const root = JSON.parse(text);
+    return root !== null && typeof root === "object" ? reviveNode(root) : chartReviver("", root);
+}
+function reviveNode(node) {
+    if (Array.isArray(node)) {
+        for (let i = 0; i < node.length; i++) {
+            const v = node[i];
+            if (v === null) node[i] = NaN;
+            else if (typeof v === "object") node[i] = reviveNode(v);
+        }
+        return node;
+    }
+    for (const key of Object.keys(node)) {
+        const v = node[key];
+        node[key] = chartReviver(key, v !== null && typeof v === "object" ? reviveNode(v) : v);
+    }
+    return node;
+}
--- esm/Builder/dispatch/build2DChart.js (and the other 17 JSON.parse(..., chartReviver) sites)
-        definition = JSON.parse(definition, chartReviver);
+        definition = parseDefinition(definition);
```

**Trade-off:** A JS loop still visits every element, but with no function call and no index string per element. The freshly parsed tree, which the library owns, is mutated in place. The result is identical: array indices never match a named key, null still becomes NaN, children are revived before their parent as with a reviver, and a JSON "__proto__" key stays an own data property (JSON.parse creates it as one, so the assignment writes that property). chartReviver stays exported for apps that use it.

## App-side workaround

Keep bulk data out of the definition string: build the chart from a small definition, then call dataSeries.appendRange with Float64Array columns, or pass an already-parsed object (the builders parse only when given a string).

## Verify

measure.md#inp on a 'load saved chart' click that calls buildChart with a 1M-point definition string, 5 runs per side. Pass: the build call's time in __wpProbe.loaf.read() topScripts goes down, compare-runs gives 'win' on processingMs, and the chart shows the same NaN gaps.

## Other locations

- `esm/Builder/chartBuilder.js:22` — buildChart entry parse
- `esm/Builder/dispatch/dataSeries.js:26` — data series definition and sharedData (:29) parse
- `esm/Builder/dispatch/series.js:65` — series definition and sharedData (:68, :121, :124) parse

## Review notes

- Found by reviewer slice `s02-init-loading`.
- Adversarial verification (corrected): Quote matches chartReviver.js:6-20. rg found exactly 18 JSON.parse(..., chartReviver) sites in esm/Builder (chartBuilder 2, build2DChart, build2DPolarChart, build3DChart, buildPieChart, annotations, axes 1 each, modifiers 2, series 4, dataSeries 4); each parses only when given a string, once per build call. Checked V8-10's Do ('Parse without a reviver, then convert the few fields you need in a loop'); its Avoid does not exempt this. Checked the fix against the JSON.parse reviver algorithm (InternalizeJSONProperty): same bottom-up order, reviver never returns undefined so no deletions, root key "" handled, own "__proto__" data property is written rather than the prototype setter. Evidence lowered S -> H because the cost depends entirely on how much inline data a definition carries.

