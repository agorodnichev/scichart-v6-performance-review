const META = {
  id: "068",
  title: "buildChart() parses definition strings with a reviver: two JS calls per XY data point",
  issue: "issues/068-builder-json-reviver-runs-per-data-point.md",
  severity: "medium",
  claim: "buildChart(div, jsonString) and the other Builder entry points call JSON.parse(definition, chartReviver). The parser then calls chartReviver for every value in the tree, including every element of xValues and yValues, although only five keys need reviving and the rest is a null-to-NaN swap.",
  method: "<p>A definition string with one line series and 200,000 inline XY points (every 1000th y is null, a NaN gap) is built twice. As shipped: buildChart(div, string). With the fix: the issue's parseDefinition() (parse without a reviver, then walk the tree, calling chartReviver only for object keys and swapping null for NaN in arrays), then buildChart(div, object). The demo counts JSON.parse calls and reviver invocations, and checks that both results carry the same NaN gaps and NumberRange objects. It then times the two parses alone (median of 3, uncounted) next to a plain JSON.parse without a reviver.</p>",
};

async function demo(P) {
  const { buildChart, chartReviver, registerAllTypes, NumberRange } = P.SciChart;
  const POINTS = 200000, GAP_EVERY = 1000;
  registerAllTypes();

  // The issue's fix: same result as JSON.parse(text, chartReviver), without a call per array element.
  let fixReviverCalls = 0;
  const reviver = (k, v) => { fixReviverCalls++; return chartReviver(k, v); };
  function parseDefinition(text) {
    const reviveNode = (node) => {
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          const v = node[i];
          if (v === null) node[i] = NaN;
          else if (typeof v === "object") node[i] = reviveNode(v);
        }
        return node;
      }
      for (const key of Object.keys(node)) {
        const v = node[key];
        node[key] = reviver(key, v !== null && typeof v === "object" ? reviveNode(v) : v);
      }
      return node;
    };
    const root = JSON.parse(text);
    return root !== null && typeof root === "object" ? reviveNode(root) : reviver("", root);
  }

  P.status("Building a definition string with 200,000 inline points…");
  const xValues = new Array(POINTS), yValues = new Array(POINTS);
  for (let i = 0; i < POINTS; i++) {
    xValues[i] = i;
    yValues[i] = i % GAP_EVERY === GAP_EVERY - 1 ? null : +(Math.sin(i / 3000) + 0.1 * Math.sin(i / 37)).toFixed(4);
  }
  const text = JSON.stringify({
    xAxes: { type: "NumericAxis", options: { visibleRange: { min: 0, max: POINTS }, growBy: { min: 0, max: 0 } } },
    yAxes: { type: "NumericAxis", options: { growBy: { min: 0.1, max: 0.1 } } },
    series: [{ type: "LineSeries", options: { stroke: "#4e79a7", strokeThickness: 1 }, xyData: { xValues, yValues, isSorted: true, containsNaN: true } }],
  });
  P.log(`definition string: ${(text.length / 1e6).toFixed(2)} MB, ${POINTS} points`);

  // Warm-up: start the shared engine and put an empty chart in both slots, so the two measured
  // builds below do the same work apart from the parse (each replaces an existing surface).
  P.status("Starting the engine with two empty charts…");
  await buildChart("chartShipped", "{}");
  await buildChart("chartFixed", "{}");
  const renderer = P.SciChart.SciChartSurface.debugWasmWebGPU().webGpu ? "WebGPU" : "WebGL";

  P.watch.json();
  P.status("buildChart(div, string), as shipped…");
  const shipped = await P.during(() => buildChart("chartShipped", text));
  P.status("buildChart(div, parseDefinition(string)), with the fix…");
  fixReviverCalls = 0;
  const fixed = await P.during(() => buildChart("chartFixed", parseDefinition(text)));
  const fixCalls = fixReviverCalls;

  // Same result? Count NaN gaps and check the revived NumberRange in both parses (uncounted).
  const a = P.quiet(() => JSON.parse(text, chartReviver)), b = P.quiet(() => parseDefinition(text));
  const nanCount = (d) => d.series[0].xyData.yValues.reduce((n, v) => n + (Number.isNaN(v) ? 1 : 0), 0);
  const same = nanCount(a) === nanCount(b) && nanCount(a) === POINTS / GAP_EVERY &&
    a.xAxes.options.visibleRange instanceof NumberRange && b.xAxes.options.visibleRange instanceof NumberRange;
  P.log(`NaN gaps: reviver ${nanCount(a)}, parseDefinition ${nanCount(b)}; visibleRange is NumberRange in both: ${same}`);

  // Parse times alone, counters off so the harness's reviver wrapper is not in the measurement.
  await P.sleep(200);
  const median = (f) => { const t = []; for (let i = 0; i < 3; i++) { const t0 = P.now(); f(); t.push(P.now() - t0); } return t.sort((x, y) => x - y)[1]; };
  const msReviver = P.quiet(() => median(() => JSON.parse(text, chartReviver)));
  const msFix = P.quiet(() => median(() => parseDefinition(text)));
  const msPlain = P.quiet(() => median(() => JSON.parse(text)));
  // buildChart() end to end, uncounted (the parse runs synchronously inside the quiet call).
  const timedBuild = async (div, def) => { const t0 = P.now(); await P.quiet(() => buildChart(div, def())); return P.now() - t0; };
  const buildShippedMs = await timedBuild("chartShipped", () => text);
  const buildFixedMs = await timedBuild("chartFixed", () => parseDefinition(text));

  const calls = shipped.total("JSON.parse reviver calls");
  const reproduced = calls >= 2 * POINTS && fixed.total("JSON.parse reviver calls") === 0 && same;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Parsing the definition string called chartReviver ${calls.toLocaleString("en-US")} times for ${POINTS.toLocaleString("en-US")} points (${(calls / POINTS).toFixed(2)} per point). The fix's parse makes ${fixCalls} reviver calls with the same NaN gaps; parse time ${msReviver.toFixed(0)} ms -> ${msFix.toFixed(0)} ms.`
      : `Expected at least ${2 * POINTS} reviver calls (two per point); measured ${calls}. Results identical: ${same}.`,
    columns: ["As shipped (string)", "With parseDefinition()"],
    rows: [
      ["JSON.parse calls in buildChart", shipped.total("JSON.parse"), fixed.total("JSON.parse")],
      ["Reviver calls inside JSON.parse", calls, fixed.total("JSON.parse reviver calls")],
      ["chartReviver calls in the fix's tree walk (object keys only)", null, fixCalls],
      ["Reviver calls per data point", calls / POINTS, 0],
      ["NaN gaps in yValues after parsing", nanCount(a), nanCount(b)],
      ["Parse time alone, ms (median of 3)", msReviver, msFix],
      ["Plain JSON.parse(text) without a reviver, ms", msPlain, msPlain],
      ["buildChart() end to end, ms (parse + data load + chart setup)", buildShippedMs, buildFixedMs],
    ],
    notes: [
      `Renderer: ${renderer}. The call counts do not depend on hardware; the times do. The whole parse runs in one task before SciChartSurface.create(), so at 1M points it adds directly to the click or page load that builds the chart.`,
      "App-side workaround from the issue: keep bulk data out of the definition string (build from a small definition, then appendRange with typed arrays), or pass an already-parsed object, as the second column does.",
    ],
    metrics: { points: POINTS, mb: text.length / 1e6, reviverCalls: calls, fixReviverCalls: fixCalls, msReviver, msFix, msPlain, buildShippedMs, buildFixedMs, same },
  });
}
