const META = {
  id: "094",
  title: "delete() on a grouped chart re-lays out the chart it is destroying, once per group",
  issue: "issues/094-group-removesurface-relayouts-deleted-chart.md",
  severity: "low",
  claim: "SciChartSurface.delete() takes a grouped chart out of its SciChartVerticalGroup and SciChartHorizontalGroup, and each removeSurface() runs a full layoutChart() on that chart (every axis re-measured, ticks and labels regenerated) a few lines before delete() drops the layout manager and deletes the axes.",
  method: "<p>Eight charts, each with a bottom X axis, a right Y axis and one line series, all added to one SciChartVerticalGroup and one SciChartHorizontalGroup. After they have rendered, all eight are deleted in one task (as a view unmount would). Counted inside that task: <code>removeSurface</code> calls on each group, <code>layoutChart</code> calls (LayoutManager and SynchronizedLayoutManager), axis <code>measure()</code> calls (AxisBase2D, reached through NumericAxis's prototype chain), layout managers assigned to the surface, time inside the layouts and time inside <code>delete()</code>.</p><p>The same eight charts are then built again and deleted with the fix from the issue emulated: both groups' <code>removeSurface</code> skips the <code>layoutChart</code> call when <code>sciChartSurface.isDeleted</code> is set (group bookkeeping still runs). A third build without groups shows what <code>delete()</code> costs a chart that is not grouped.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, SciChartHorizontalGroup, SciChartVerticalGroup, SynchronizedLayoutManager, LayoutManager, SciChartSurface } = P.SciChart;
  const CHARTS = 8, POINTS = 300, AXES = 2;
  const ownerOf = (proto, method) => { while (proto && !Object.prototype.hasOwnProperty.call(proto, method)) proto = Object.getPrototypeOf(proto); return proto; };
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7"];

  async function build(grouped) {
    const vGroup = new SciChartVerticalGroup(), hGroup = new SciChartHorizontalGroup();
    const surfaces = [];
    for (let c = 0; c < CHARTS; c++) {
      const { sciChartSurface, wasmContext } = await P.createSurface(`g${c}`);
      sciChartSurface.xAxes.add(new NumericAxis(wasmContext));
      sciChartSurface.yAxes.add(new NumericAxis(wasmContext));
      const xs = Array.from({ length: POINTS }, (_, i) => i);
      sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, {
        dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => (c + 1) * 10 * Math.sin(x / 30 + c)), isSorted: true, containsNaN: false }),
        stroke: COLORS[c], strokeThickness: 2,
      }));
      if (grouped) { vGroup.addSurfaceToGroup(sciChartSurface); hGroup.addSurfaceToGroup(sciChartSurface); }
      surfaces.push(sciChartSurface);
    }
    await P.idleFrames(30);
    return surfaces;
  }

  // ---- counters
  const axisProto = ownerOf(NumericAxis.prototype, "measure");
  P.hookMethod(axisProto, "measure", { name: "axis measure()" });
  P.hookMethod(LayoutManager.prototype, "layoutChart", { name: "layout (LayoutManager.layoutChart)", time: true });
  P.hookMethod(SciChartVerticalGroup.prototype, "removeSurface", { name: "SciChartVerticalGroup.removeSurface" });
  P.hookMethod(SciChartHorizontalGroup.prototype, "removeSurface", { name: "SciChartHorizontalGroup.removeSurface" });
  P.hookAccessor(SciChartSurface.prototype, "layoutManager", { name: "layoutManager", set: true, get: false });

  async function deleteAll(label, surfaces) {
    P.status(`Deleting ${CHARTS} charts, ${label}…`);
    await P.idleFrames(5);
    let deleteMs = 0;
    const r = await P.during(async () => {
      for (const s of surfaces) { const t0 = P.now(); s.delete(); deleteMs += P.now() - t0; }
    });
    const per = (name, field) => r.total(name, field) / CHARTS;
    const res = {
      vRemove: per("SciChartVerticalGroup.removeSurface"),
      hRemove: per("SciChartHorizontalGroup.removeSurface"),
      layouts: per("layout (LayoutManager.layoutChart)"),
      measures: per("axis measure()"),
      managers: per("layoutManager.set"),
      layoutMs: per("layout (LayoutManager.layoutChart)", "t"),
      deleteMs: deleteMs / CHARTS,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    await P.idleFrames(5);
    return res;
  }

  P.status("Building eight grouped charts…");
  const shipped = await deleteAll("in both groups, as shipped", await build(true));

  // Fix from the issue: removeSurface() skips layoutChart() for a deleted surface.
  P.status("Building eight grouped charts again…");
  const surfaces2 = await build(true);
  let skipLayout = false;
  const restores = [];
  const guardRemove = (proto) => {
    const orig = proto.removeSurface;
    proto.removeSurface = function (s) {
      if (!s.isDeleted) return orig.call(this, s);
      skipLayout = true;
      try { return orig.call(this, s); } finally { skipLayout = false; }
    };
    restores.push(() => { proto.removeSurface = orig; });
  };
  const skippable = (proto) => {
    const orig = proto.layoutChart; // the layoutChart(...) call removeSurface makes goes through one of these first
    proto.layoutChart = function () { return skipLayout ? undefined : orig.apply(this, arguments); };
    restores.push(() => { proto.layoutChart = orig; });
  };
  guardRemove(SciChartVerticalGroup.prototype);
  guardRemove(SciChartHorizontalGroup.prototype);
  skippable(SynchronizedLayoutManager.prototype);
  skippable(LayoutManager.prototype);
  const fixed = await deleteAll("in both groups, with the isDeleted guard", surfaces2);
  restores.reverse().forEach((f) => f());

  P.status("Building eight charts without groups…");
  const plain = await deleteAll("not grouped", await build(false));

  const reproduced = shipped.vRemove === 1 && shipped.hRemove === 1 && shipped.layouts >= 1.6 && shipped.measures >= 0.8 * AXES * 2 && fixed.layouts === 0 && fixed.measures === 0;
  const f = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each delete() of a chart in both groups ran ${f(shipped.layouts)} full layouts and ${f(shipped.measures)} axis measure() calls on the chart being destroyed (${AXES} axes). With the isDeleted guard: ${f(fixed.layouts)} and ${f(fixed.measures)}. An ungrouped chart: ${f(plain.layouts)} and ${f(plain.measures)}.`
      : `Expected 2 layouts per deleted chart in both groups (one per removeSurface) and 0 with the guard; measured ${f(shipped.layouts)} layouts and ${f(shipped.measures)} measure() calls as shipped, ${f(fixed.layouts)} and ${f(fixed.measures)} with the guard.`,
    columns: ["Both groups (as shipped)", "Both groups + isDeleted guard (fix)", "Not grouped"],
    rows: [
      ["removeSurface() calls per delete(): vertical group", shipped.vRemove, fixed.vRemove, plain.vRemove],
      ["removeSurface() calls per delete(): horizontal group", shipped.hRemove, fixed.hRemove, plain.hRemove],
      ["Full layouts (layoutChart) per delete()", shipped.layouts, fixed.layouts, plain.layouts],
      ["Axis measure() calls per delete()", shipped.measures, fixed.measures, plain.measures],
      ["Layout managers assigned per delete()", shipped.managers, fixed.managers, plain.managers],
      ["Time in those layouts per delete(), ms", shipped.layoutMs, fixed.layoutMs, plain.layoutMs],
      ["Time in delete() per chart, ms", shipped.deleteMs, fixed.deleteMs, plain.deleteMs],
    ],
    notes: [
      `Counts do not depend on hardware; times do. With ${AXES} axes per chart a clean pair of layouts would measure ${AXES * 2} times; the vertical group's removal leaves the chart on the horizontal-only SynchronizedLayoutManager path, which measures left and right axes twice (issue 047), hence one extra measure per Y axis.`,
      "The guard only removes the layout. removeSurface() still allocates a fresh LayoutManager for the dying chart (the 'layout managers assigned' row) and still re-synchronises the remaining charts, which is the part that matters.",
      `Renderer: ${P.renderer()}. Layout runs in JavaScript, so both renderers should give the same counts. This is a one-off cost per teardown, not per frame.`,
    ],
    metrics: { shipped, fixed, plain, charts: CHARTS, axesPerChart: AXES },
  });
}
