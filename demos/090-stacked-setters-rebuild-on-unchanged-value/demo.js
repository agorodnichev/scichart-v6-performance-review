const META = {
  id: "090",
  title: "Re-assigning an unchanged stacked-collection property rebuilds every accumulated vector",
  issue: "issues/090-stacked-setters-rebuild-on-unchanged-value.md",
  severity: "low",
  claim: "The stacked collections' isVisible, isOneHundredPercent and separatePositiveNegativeStacks setters, and the stacked column's stackedGroupId setter, notify without comparing the old and new value. A same-value assignment, as a UI framework makes when it re-applies props, marks the accumulation dirty and the next draw rebuilds every stack with per-point push_back calls.",
  method: "<p>Two charts with 5 layers of 20,000 points each: a StackedMountainCollection (left) and a StackedColumnCollection (right). Every frame both surfaces are invalidated, so they redraw in every scenario, and one property is re-assigned the value it already has. Each assignment runs for 10 frames; a frame with no assignment is the baseline and the already guarded yRangeMode setter is a control. Counted per frame: accumulated-vector rebuilds (updateAccumulatedVectors calls that found the collection dirty) and SCRTDoubleVector.push_back calls inside them. Times come from separate passes without the per-call hook.</p><p>A/B: the five setters get the issue's fix (return early when the value is unchanged), the same assignments run again, and the original setters are restored.</p>",
};

async function demo(P) {
  const { NumericAxis, StackedMountainCollection, StackedMountainRenderableSeries, StackedColumnCollection, StackedColumnRenderableSeries, XyDataSeries, EAutoRange } = P.SciChart;
  const S = 5, N = 20000, FRAMES = 10;
  const FILLS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f"];
  const xs = new Float64Array(N);
  for (let i = 0; i < N; i++) xs[i] = i;

  async function makeChart(div, Collection, Series) {
    const { sciChartSurface, wasmContext } = await P.createSurface(div);
    sciChartSurface.xAxes.add(new NumericAxis(wasmContext));
    sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
    const coll = new Collection(wasmContext);
    for (let s = 0; s < S; s++) {
      const ys = new Float64Array(N);
      for (let i = 0; i < N; i++) ys[i] = 1 + Math.abs(Math.sin(i / 900 + s * 0.8)) * (1 + 0.2 * s);
      coll.add(new Series(wasmContext, {
        dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: ys, isSorted: true, containsNaN: false }),
        fill: FILLS[s], stroke: FILLS[s], strokeThickness: 1,
      }));
    }
    sciChartSurface.renderableSeries.add(coll);
    return { sciChartSurface, wasmContext, coll };
  }
  const mountain = await makeChart("chart", StackedMountainCollection, StackedMountainRenderableSeries);
  const column = await makeChart("chart2", StackedColumnCollection, StackedColumnRenderableSeries);
  await P.sleep(600);

  // Prototypes (StackedXyCollection and BaseStackedCollection are not exported by name in the UMD bundle).
  const xyProto = Object.getPrototypeOf(StackedMountainCollection.prototype);
  const baseProto = Object.getPrototypeOf(xyProto);
  const colProto = StackedColumnCollection.prototype;

  // Rebuild counter + timer on both collection types (each has its own updateAccumulatedVectors).
  let inRebuild = false, rebuildMs = 0;
  const restoreList = [];
  [xyProto, colProto].forEach((proto) => {
    const orig = proto.updateAccumulatedVectors;
    proto.updateAccumulatedVectors = function () {
      const dirty = this.isAccumulatedVectorDirty && this.getDataSeriesValuesCount();
      inRebuild = true;
      const t0 = P.now();
      try { return orig.apply(this, arguments); } finally {
        inRebuild = false;
        if (dirty) { P.count("rebuilds"); rebuildMs += P.now() - t0; }
      }
    };
    restoreList.push(() => { proto.updateAccumulatedVectors = orig; });
  });

  const assignments = [
    ["Baseline: redraw only, no assignment", () => {}],
    ["mountainCollection.isOneHundredPercent = false (unchanged)", () => { mountain.coll.isOneHundredPercent = false; }],
    ["mountainCollection.isVisible = true (unchanged)", () => { mountain.coll.isVisible = true; }],
    ["mountainCollection.separatePositiveNegativeStacks = true (unchanged)", () => { mountain.coll.separatePositiveNegativeStacks = true; }],
    ["columnCollection.separatePositiveNegativeStacks = true (unchanged)", () => { column.coll.separatePositiveNegativeStacks = true; }],
    ["columnSeries.stackedGroupId = its current value", () => { const rs = column.coll.get(2); rs.stackedGroupId = rs.stackedGroupId; }],
    ["Control: mountainCollection.yRangeMode = unchanged (guarded setter)", () => { mountain.coll.yRangeMode = mountain.coll.yRangeMode; }],
  ];

  async function run(label, assign, countCalls) {
    const undo = countCalls ? P.hookMethod(mountain.wasmContext.SCRTDoubleVector.prototype, "push_back", {
      name: "push_back (all)", onCall: () => { if (inRebuild) P.count("push_back inside rebuilds"); },
    }) : null;
    rebuildMs = 0;
    const r = await P.frames(FRAMES, () => {
      mountain.sciChartSurface.invalidateElement();
      column.sciChartSurface.invalidateElement();
      assign();
    });
    if (undo) undo();
    const res = { rebuilds: r.perFrame("rebuilds"), pushBack: r.perFrame("push_back inside rebuilds"), msPerFrame: rebuildMs / FRAMES, p95: r.frameP95 };
    P.log(`${label}${countCalls ? "" : " (timing pass)"}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Re-assigning unchanged values, library as shipped…");
  const shipped = [];
  for (const [label, fn] of assignments) shipped.push(await run("as shipped: " + label, fn, true));
  const shippedTime = await run("as shipped: " + assignments[1][0], assignments[1][1], false);

  // The issue's fix: compare before notifying.
  const guards = [[baseProto, "isVisible"], [baseProto, "isOneHundredPercent"], [xyProto, "separatePositiveNegativeStacks"], [colProto, "separatePositiveNegativeStacks"], [StackedColumnRenderableSeries.prototype, "stackedGroupId"]];
  const saved = guards.map(([proto, prop]) => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    Object.defineProperty(proto, prop, {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set(v) { if (d.get.call(this) === v) return; d.set.call(this, v); },
    });
    return [proto, prop, d];
  });
  P.status("Re-assigning unchanged values, with the setter guards…");
  const fixed = [];
  for (const [label, fn] of assignments) fixed.push(await run("with guards: " + label, fn, true));
  const fixedTime = await run("with guards: " + assignments[1][0], assignments[1][1], false);
  saved.forEach(([proto, prop, d]) => Object.defineProperty(proto, prop, d));
  restoreList.forEach((f) => f());

  const perRebuild = N * (2 * S + 1); // separate +/- stacks (default): accumulatedValues0 + top + bottom per layer
  const setterRows = shipped.slice(1, 6);
  const reproduced = shipped[0].rebuilds <= 0.1 && setterRows.every((r) => r.rebuilds >= 0.9 && r.pushBack >= 0.9 * perRebuild);
  const fixWorks = fixed.slice(1, 6).every((r) => r.rebuilds <= 0.1);
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each of the 5 setters, re-assigned its current value once per frame, triggers 1 full rebuild per frame (${Math.round(setterRows[0].pushBack).toLocaleString("en-US")} push_back calls for ${S} x ${N.toLocaleString("en-US")} points); a redraw alone triggers none. ` +
        (fixWorks ? `With an equality guard: 0 rebuilds (${shippedTime.msPerFrame.toFixed(1)} ms -> ${fixedTime.msPerFrame.toFixed(1)} ms per frame in updateAccumulatedVectors).` : `The guards did not remove all rebuilds (see the table).`)
      : `Expected 1 rebuild per frame for each same-value assignment and none for the baseline; measured ${setterRows.map((r) => r.rebuilds.toFixed(1)).join(", ")} (baseline ${shipped[0].rebuilds.toFixed(1)}).`,
    columns: ["As shipped: rebuilds / frame", "As shipped: push_back / frame", "With guard: rebuilds / frame", "With guard: push_back / frame"],
    rows: assignments.map(([label], i) => [label, shipped[i].rebuilds, shipped[i].pushBack, fixed[i].rebuilds, fixed[i].pushBack]).concat([
      ["Time in updateAccumulatedVectors per frame, ms (isOneHundredPercent re-applied, pass without the per-call hook)", shippedTime.msPerFrame, null, fixedTime.msPerFrame, null],
      ["Frame interval p95, ms (same pass)", shippedTime.p95, null, fixedTime.p95, null],
    ]),
    notes: [
      `Both charts are invalidated every frame in every row, so the baseline row shows that redrawing alone does not rebuild. One rebuild is ${perRebuild.toLocaleString("en-US")} embind push_back calls here (issue 021 covers the rebuild's own cost). Counts do not depend on hardware; times do.`,
      "Workaround without a library change: compare before assigning these properties.",
    ],
    metrics: { S, N, perRebuild, shipped, fixed, shippedTime, fixedTime, labels: assignments.map((a) => a[0]) },
  });
}
