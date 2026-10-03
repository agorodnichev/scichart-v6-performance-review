const META = {
  id: "047",
  title: "Charts in a SciChartHorizontalGroup measure their left and right axes twice per frame",
  issue: "issues/047-sync-layout-double-measures-left-right-axes.md",
  severity: "medium",
  claim: "SynchronizedLayoutManager.measureLeftOuterAxes and measureRightOuterAxes call super twice when the chart has no vertical group, which is every chart that is only in a SciChartHorizontalGroup. Each left and right axis regenerates its ticks and labels and measures its label size twice on every rendered frame; the second pass gives the same result.",
  method: "<p>Four charts, each with a bottom X axis, a left Y axis and a right Y axis (one line series on each Y axis). Every frame one point is appended to every series, so each chart re-renders and runs one layout per frame. The demo wraps the axis <code>measure()</code> method (AxisBase2D, taken from NumericAxis's prototype chain because the UMD bundle does not export it) and counts calls per axis alignment, and counts <code>LayoutManager.layoutChart</code> calls (SynchronizedLayoutManager calls it through super). 90 frames are measured in each configuration:</p><ol><li>all four charts in one SciChartHorizontalGroup (as shipped);</li><li>the same, with the fix from the issue patched into SynchronizedLayoutManager.prototype (no second super call when there is no vertical group);</li><li>charts removed from the group (default LayoutManager), as a control;</li><li>charts in a SciChartVerticalGroup and a SciChartHorizontalGroup.</li></ol><p>The series area of every chart is compared between runs 1 and 2 to check that the second measure pass changes nothing.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, EAxisAlignment, SciChartHorizontalGroup, SciChartVerticalGroup, SynchronizedLayoutManager, LayoutManager } = P.SciChart;
  const CHARTS = 4, POINTS = 500, FRAMES = 90;
  // The UMD bundle does not export AxisBase2D: take the prototype that owns measure().
  const ownerOf = (proto, method) => { while (proto && !Object.prototype.hasOwnProperty.call(proto, method)) proto = Object.getPrototypeOf(proto); return proto; };

  const charts = [];
  for (let c = 0; c < CHARTS; c++) {
    const { sciChartSurface, wasmContext } = await P.createSurface(`c${c}`);
    sciChartSurface.xAxes.add(new NumericAxis(wasmContext));
    sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { id: "yLeft", axisAlignment: EAxisAlignment.Left }));
    sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { id: "yRight", axisAlignment: EAxisAlignment.Right }));
    const series = [];
    for (const [yAxisId, stroke, k] of [["yLeft", "#4e79a7", 1], ["yRight", "#f28e2b", 40]]) {
      const xs = Array.from({ length: POINTS }, (_, i) => i);
      const ds = new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => k * Math.sin(x / 50 + c)), isSorted: true, containsNaN: false });
      sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries: ds, yAxisId, stroke, strokeThickness: 2 }));
      series.push({ ds, k });
    }
    charts.push({ surface: sciChartSurface, series });
  }
  await P.idleFrames(20);

  // ---- counters
  const axisProto = ownerOf(NumericAxis.prototype, "measure");
  P.hookMethod(axisProto, "measure", { name: "axis measure()", time: true, onCall: (a, self) => P.count(`measure() ${self.axisAlignment}`) });
  P.hookMethod(LayoutManager.prototype, "layoutChart", { name: "layoutChart" });

  let x = POINTS;
  const appendAll = () => { x++; charts.forEach((ch, c) => ch.series.forEach((s) => s.ds.append(x, s.k * Math.sin(x / 50 + c)))); };
  const rects = () => charts.map((ch) => { const r = ch.surface.seriesViewRect; return `${r.x},${r.y},${r.width},${r.height}`; }).join("|");

  async function run(label) {
    P.status(`Streaming, ${label}…`);
    await P.idleFrames(10);
    const r = await P.frames(FRAMES, appendAll);
    const layouts = r.total("layoutChart") || 1;
    const res = {
      layoutsPerFrame: r.total("layoutChart") / FRAMES / CHARTS,
      left: r.total("measure() Left") / layouts,
      right: r.total("measure() Right") / layouts,
      bottom: r.total("measure() Bottom") / layouts,
      measureMsPerFrame: r.total("axis measure()", "t") / FRAMES,
      p95: r.frameP95,
      rects: rects(),
    };
    P.log(`${label}: ${JSON.stringify({ ...res, rects: undefined })}`);
    return res;
  }

  // 1. horizontal group only
  const hGroup = new SciChartHorizontalGroup();
  charts.forEach((ch) => hGroup.addSurfaceToGroup(ch.surface));
  const shipped = await run("horizontal group, as shipped");

  // 2. same, with the fix
  const SLM = SynchronizedLayoutManager.prototype;
  const origLeft = SLM.measureLeftOuterAxes, origRight = SLM.measureRightOuterAxes;
  const baseLeft = LayoutManager.prototype.measureLeftOuterAxes, baseRight = LayoutManager.prototype.measureRightOuterAxes;
  SLM.measureLeftOuterAxes = function () { return this.verticalGroup ? origLeft.call(this) : baseLeft.call(this); };
  SLM.measureRightOuterAxes = function () { return this.verticalGroup ? origRight.call(this) : baseRight.call(this); };
  const fixed = await run("horizontal group, with the fix");
  SLM.measureLeftOuterAxes = origLeft;
  SLM.measureRightOuterAxes = origRight;

  // 3. control: default LayoutManager
  charts.forEach((ch) => hGroup.removeSurface(ch.surface));
  const plain = await run("no group (default LayoutManager)");

  // 4. both groups
  const vGroup2 = new SciChartVerticalGroup(), hGroup2 = new SciChartHorizontalGroup();
  charts.forEach((ch) => { vGroup2.addSurfaceToGroup(ch.surface); hGroup2.addSurfaceToGroup(ch.surface); });
  const both = await run("vertical + horizontal group");

  const sameLayout = shipped.rects === fixed.rects;
  const reproduced = shipped.left >= 1.8 && shipped.right >= 1.8 && fixed.left <= 1.2 && fixed.right <= 1.2 && plain.left <= 1.2 && shipped.bottom <= 1.2;
  const f = (v) => v.toFixed(2);
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `In a horizontal group each left and right axis was measured ${f(shipped.left)} and ${f(shipped.right)} times per layout (bottom axis ${f(shipped.bottom)}). With the second super call removed: ${f(fixed.left)} and ${f(fixed.right)}${sameLayout ? ", with identical series areas" : ""}. Default LayoutManager: ${f(plain.left)}.`
      : `Expected 2 measure() calls per layout for left and right axes in a horizontal-only group and 1 elsewhere; measured left ${f(shipped.left)}, right ${f(shipped.right)} (fix ${f(fixed.left)}, ${f(fixed.right)}; no group ${f(plain.left)}).`,
    columns: ["Horizontal group (as shipped)", "Horizontal group + fix", "No group", "Vertical + horizontal group"],
    rows: [
      ["Layouts per chart per frame", shipped.layoutsPerFrame, fixed.layoutsPerFrame, plain.layoutsPerFrame, both.layoutsPerFrame],
      ["Left Y axis measure() calls per layout", shipped.left, fixed.left, plain.left, both.left],
      ["Right Y axis measure() calls per layout", shipped.right, fixed.right, plain.right, both.right],
      ["Bottom X axis measure() calls per layout", shipped.bottom, fixed.bottom, plain.bottom, both.bottom],
      [`Time in axis measure() per frame, ${CHARTS} charts, ms`, shipped.measureMsPerFrame, fixed.measureMsPerFrame, plain.measureMsPerFrame, both.measureMsPerFrame],
      ["Frame interval p95, ms", shipped.p95, fixed.p95, plain.p95, both.p95],
      ["Series areas equal to the as-shipped run", "–", sameLayout ? "yes" : "no", null, null],
    ],
    notes: [
      "Counts do not depend on hardware; times do. Each measure() regenerates the axis ticks and labels (getTicks(true) bypasses the tick cache) and computes the label size; in a horizontal-only group this runs twice per frame for every left and right axis, with the same result.",
      "A chart that is also in a SciChartVerticalGroup takes the other branch and is not affected, nor are top and bottom axes.",
      `Renderer: ${P.renderer()}. The layout runs in JavaScript before any drawing, so both renderers should give the same counts.`,
    ],
    metrics: { shipped: { ...shipped, rects: undefined }, fixed: { ...fixed, rects: undefined }, plain: { ...plain, rects: undefined }, both: { ...both, rects: undefined }, sameLayout, charts: CHARTS, frames: FRAMES },
  });
}
