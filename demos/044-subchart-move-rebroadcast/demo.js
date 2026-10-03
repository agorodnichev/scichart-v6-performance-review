const META = {
  id: "044",
  title: "Each sub-chart re-broadcasts every pointer move to the other charts of its modifier group",
  issue: "issues/044-subchart-event-copies-rebroadcast-to-all-surfaces.md",
  severity: "medium",
  claim: "MouseManager hands each sub-chart a spread copy of the parent's pointermove that keeps isMaster: true, so every sub-chart, under the pointer or not, fans the move out again to all other top-level 2D surfaces for each modifier group. A grouped RolloverModifier on another chart runs once per sub-chart per move, and keeps the point mapped through the last sub-chart's rect.",
  method: "<p>A parent surface with 16 sub-charts (4 x 4), each with a line series and RolloverModifier({ modifierGroup: 'g' }), and a separate chart below with 5 line series and RolloverModifier({ modifierGroup: 'g' }). The pointer sweeps the second row of sub-charts for 120 frames, one pointermove per frame. Per move the demo counts, on the separate chart: RolloverModifier.modifierMouseMove calls, update() calls and series hit tests; and overall: ModifierMouseArgs.copy calls, otherSurfaces registry scans and the rollover updates on the sub-charts themselves (the intended group sync). It times the synchronous pointermove dispatch and checks after each move whether the separate chart's rollover point was mapped from the sub-chart under the pointer.</p><p>Then it patches MouseManager.prototype.modifierMouseMove with the issue's fix (the shipped method, with the fan-out skipped for copies that carry isActiveSubChartEvent === false, and one registry scan per event) and runs the same sweep. The original method is restored afterwards.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, RolloverModifier, SciChartSubSurface, Rect, ESubSurfacePositionCoordinateMode, MouseManager, ModifierMouseArgs, SciChartSurface, ESurfaceType } = P.SciChart;
  const ROWS = 4, COLS = 4, SUBS = ROWS * COLS, OTHER_SERIES = 5, FRAMES = 120;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7"];
  const xs = Array.from({ length: 200 }, (_, i) => i);
  const line = (wasmContext, k) => new FastLineRenderableSeries(wasmContext, {
    dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 20 + k)), isSorted: true, containsNaN: false }),
    stroke: COLORS[k % COLORS.length], strokeThickness: 1,
  });

  // Parent with 16 sub-charts, each with a grouped rollover.
  const { sciChartSurface: parent, wasmContext } = await P.createSurface("chart");
  parent.xAxes.add(new NumericAxis(wasmContext, { isVisible: false }));
  parent.yAxes.add(new NumericAxis(wasmContext, { isVisible: false }));
  const subRollovers = new Set();
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const sub = SciChartSubSurface.createSubSurface(parent, { position: new Rect(c / COLS, r / ROWS, 1 / COLS, 1 / ROWS), coordinateMode: ESubSurfacePositionCoordinateMode.Relative });
      sub.xAxes.add(new NumericAxis(wasmContext, { drawMajorBands: false, maxAutoTicks: 4 }));
      sub.yAxes.add(new NumericAxis(wasmContext, { drawMajorBands: false, maxAutoTicks: 3 }));
      sub.renderableSeries.add(line(wasmContext, r * COLS + c));
      const m = new RolloverModifier({ modifierGroup: "g", showTooltip: false });
      sub.chartModifiers.add(m);
      subRollovers.add(m);
    }
  }
  // A separate top-level chart in the same modifier group.
  const { sciChartSurface: other } = await P.createSurface("chart2");
  other.xAxes.add(new NumericAxis(wasmContext));
  other.yAxes.add(new NumericAxis(wasmContext));
  for (let k = 0; k < OTHER_SERIES; k++) other.renderableSeries.add(line(wasmContext, k));
  const otherRollover = new RolloverModifier({ modifierGroup: "g" });
  other.chartModifiers.add(otherRollover);
  await P.sleep(800);

  // ---- counters
  const RP = RolloverModifier.prototype;
  const rolloverMove = RP.modifierMouseMove;
  let inOtherMove = 0;
  RP.modifierMouseMove = function (args) {
    if (this !== otherRollover) return rolloverMove.apply(this, arguments);
    P.count("other chart: rollover modifierMouseMove");
    inOtherMove++;
    try { return rolloverMove.apply(this, arguments); } finally { inOtherMove--; }
  };
  P.hookMethod(RP, "update", { name: "rollover updates", onCall: (a, self) => {
    if (self === otherRollover && inOtherMove) P.count("other chart: rollover update() from a move");
    else if (subRollovers.has(self)) P.count("sub-charts: rollover update()");
  } });
  P.hookMethod(otherRollover, "hitTestRenderableSeries", { name: "other chart: series hit tests" }); // bound in the constructor
  P.hookMethod(ModifierMouseArgs, "copy", { name: "ModifierMouseArgs.copy" });
  P.hookAccessor(SciChartSurface.prototype, "otherSurfaces", { name: "otherSurfaces registry scans" });
  let master = null;
  P.hookMethod(ModifierMouseArgs, "fromPointerEvent", { name: "fromPointerEvent", onCall: (a, self, ret) => { master = ret; } });

  // Where the other chart's rollover point should be: the master point mapped from the sub-chart under the pointer.
  function followsActiveSubChart() {
    const active = parent.subCharts.find((s) => s.mouseManager.isOver);
    const mp = otherRollover.mousePoint;
    if (!active || !master || !mp) return false;
    const a = active.seriesViewRect, o = other.seriesViewRect;
    const ex = o.x + (master.mousePoint.x - a.x) * (o.width / a.width);
    const ey = o.y + (master.mousePoint.y - a.y) * (o.height / a.height);
    return Math.abs(mp.x - ex) < 1 && Math.abs(mp.y - ey) < 1;
  }

  const pointer = P.pointer(parent);
  async function sweep(label) {
    pointer.enter(0.5, 0.37);
    await P.idleFrames(5);
    let dispatchMs = 0, follows = 0;
    const r = await P.frames(FRAMES, (i) => {
      const t0 = P.now();
      pointer.move(pointer.sweepX(i, 40), 0.37);
      dispatchMs += P.now() - t0;
      if (followsActiveSubChart()) follows++;
    });
    const res = {
      otherMoves: r.perFrame("other chart: rollover modifierMouseMove"),
      otherUpdates: r.perFrame("other chart: rollover update() from a move"),
      otherHitTests: r.perFrame("other chart: series hit tests"),
      copies: r.perFrame("ModifierMouseArgs.copy"),
      scans: r.perFrame("otherSurfaces registry scans"),
      subUpdates: r.perFrame("sub-charts: rollover update()"),
      follows,
      dispatchMs: dispatchMs / FRAMES,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    pointer.leave();
    await P.idleFrames(5);
    return res;
  }

  P.status("Sweeping the pointer over the sub-charts, library as shipped…");
  const shipped = await sweep("as shipped");

  // The fix from the issue, applied to MouseManager.modifierMouseMove only (Up/Cancel keep their copies).
  const MMP = MouseManager.prototype, shippedMove = MMP.modifierMouseMove;
  const validSurfaceTypes = [ESurfaceType.SciChartSurfaceType, ESurfaceType.SciChartPolarSurfaceType];
  const MOVE = 0; // EMouseEventType.Move
  MMP.modifierMouseMove = function (args) {
    if (validSurfaceTypes.includes(this.sciChartSurface.surfaceType)) {
      const scs = this.sciChartSurface;
      if (scs.adornerLayer.isAnnotationSelected) {
        const a = scs.adornerLayer.selectedAnnotation;
        if (a.isDraggingStarted) a.onDragAdorner(args);
      }
    }
    this.chartModifiers.forEach((cm) => {
      if (cm.canReceiveMouseEvents && (!args.handled || cm.receiveHandledEvents)) {
        if (args.isMaster || (!args.isMaster && cm.modifierGroup === args.modifierGroup)) cm.modifierMouseMove(args, this.sciChartSurface);
      }
    });
    // Fix: a copy given to an inactive sub-chart does not re-broadcast; one registry scan per event.
    if (args.isMaster && args.isActiveSubChartEvent !== false) {
      const masterData = this.getMasterData(this.sciChartSurface, args);
      const groups = this.chartModifierGroups;
      const others = groups.length > 0 ? this.sciChartSurface.otherSurfaces : [];
      groups.forEach((g) => others.forEach((scs) => {
        scs.mouseManager.modifierMouseMove(ModifierMouseArgs.copy(args, g, this.sciChartSurface.seriesViewRect, scs.seriesViewRect, masterData));
      }));
      this.updateSubCharts(args, MOVE);
    }
  };
  P.status("Sweeping the pointer, with the fan-out limited to the active sub-chart…");
  const fixed = await sweep("with fix");
  MMP.modifierMouseMove = shippedMove;
  RP.modifierMouseMove = rolloverMove;

  const reproduced = shipped.otherMoves >= 0.8 * SUBS && shipped.otherUpdates >= 0.8 * SUBS && fixed.otherMoves <= 1.1 && fixed.otherUpdates <= 1.1 && Math.abs(shipped.subUpdates - fixed.subUpdates) < 0.5;
  const hitTestsMultiplied = shipped.otherHitTests > 1.5 * Math.max(fixed.otherHitTests, 1);
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `With ${SUBS} sub-charts, each pointer move reaches the other chart's grouped rollover ${shipped.otherMoves.toFixed(1)} times (${shipped.otherUpdates.toFixed(1)} update() calls, ${shipped.copies.toFixed(0)} event copies), and its point ends up mapped from the right sub-chart on ${shipped.follows} of ${FRAMES} moves. With the fan-out limited to the active sub-chart: ${fixed.otherMoves.toFixed(1)} call, ${fixed.follows} of ${FRAMES} moves. ${hitTestsMultiplied ? "" : "Series hit tests are not multiplied in this layout."}`
      : `Expected about ${SUBS} calls of the other chart's rollover per move; measured ${shipped.otherMoves.toFixed(2)} modifierMouseMove and ${shipped.otherUpdates.toFixed(2)} update() calls (with the fix: ${fixed.otherMoves.toFixed(2)} and ${fixed.otherUpdates.toFixed(2)}).`,
    columns: ["As shipped", "With fix"],
    rows: [
      ["Other chart: RolloverModifier.modifierMouseMove per pointer move", shipped.otherMoves, fixed.otherMoves],
      ["Other chart: rollover update() called from those moves", shipped.otherUpdates, fixed.otherUpdates],
      [`Other chart: series hit tests per pointer move (${OTHER_SERIES} series)`, shipped.otherHitTests, fixed.otherHitTests],
      ["ModifierMouseArgs.copy per pointer move", shipped.copies, fixed.copies],
      ["otherSurfaces registry scans per pointer move", shipped.scans, fixed.scans],
      ["Sub-charts: rollover update() per pointer move (intended group sync)", shipped.subUpdates, fixed.subUpdates],
      [`Moves where the other chart's rollover point is mapped from the sub-chart under the pointer (of ${FRAMES})`, shipped.follows, fixed.follows],
      ["Synchronous pointermove dispatch time, ms", shipped.dispatchMs, fixed.dispatchMs],
      ["Frame interval p95, ms", shipped.p95, fixed.p95],
    ],
    notes: [
      "Counts do not depend on hardware; times do. Each copy that keeps isMaster: true makes the sub-chart call ModifierMouseArgs.copy and modifierMouseMove for the parent and for the other chart; the other chart is a top-level surface, so the isActiveSubChartEvent guard in RolloverModifier does not stop it. The copy and scan rows also include the Leave/Enter pairs sent when the pointer crosses into another sub-chart, in both columns.",
      "Only the last of those updates is kept, and it maps the point through the rect of the last sub-chart in iteration order, so while the pointer is over any other sub-chart the other chart's rollover is hidden or misplaced.",
      `The issue expects each extra update to hit-test every series. Here it does not (${shipped.otherHitTests.toFixed(2)} vs ${fixed.otherHitTests.toFixed(2)} hit tests per move): a point mapped through the rect of a sub-chart that is not under the pointer always falls outside the other chart's series area, so those updates take the early path that hides the rollover line, markers and tooltips. The duplicated work is the dispatch, the copies, the registry scans and that hide path.`,
    ],
    metrics: { shipped, fixed, subCharts: SUBS, otherSeries: OTHER_SERIES },
  });
}
