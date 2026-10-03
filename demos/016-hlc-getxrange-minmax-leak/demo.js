const META = {
  id: "016",
  title: "Horizontal error bars leak one native SCRTDoubleRange per X auto-range (every redraw)",
  issue: "issues/016-hlc-getxrange-leaks-minmax-result.md",
  severity: "high",
  claim: "In the horizontal-error-bar branch, HlcDataSeries.getXRange stores two NumberUtil.MinMax results in one variable and deletes only the second, so the first native SCRTDoubleRange is never freed (embind attaches no GC finalizer to it). With xAxis.autoRange = Always this happens on every redraw, and zoomExtents() does it once per call with any autoRange mode.",
  method: "<p>One FastErrorBarsRenderableSeries with <code>errorDirection: Horizontal</code> over a 10,000-point HlcDataSeries (high/low are X values), X axis <code>autoRange: Always</code>. The demo streams one HLC point per frame for 120 frames, so the chart redraws every frame. It counts surface renders, <code>HlcDataSeries.getXRange</code> calls that take the horizontal branch, the wasm <code>NumberUtil::MinMax</code> results created inside each call and how many of them are still alive (not <code>delete()</code>d) when the call returns, and native <code>SCRTDoubleRange</code> handles created vs deleted on the whole page (every embind handle is counted at creation and at <code>delete()</code>). It also checks whether a MinMax result carries a smart pointer, the only case where embind registers a GC finalizer.</p><p>A/B: the same run with <code>getXRange</code> wrapped so that every MinMax result created inside it is deleted afterwards (what the issue's fix does by keeping the first result in its own variable). Then, with the original code, <code>autoRange: Once</code> (the default) and 20 <code>zoomExtents()</code> calls.</p>",
};

async function demo(P) {
  const { NumericAxis, HlcDataSeries, FastErrorBarsRenderableSeries, EErrorDirection, EErrorMode, EAutoRange } = P.SciChart;
  const POINTS = 10000, FRAMES = 120, ZOOMS = 20;

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  const xAxis = new NumericAxis(wasmContext, { autoRange: EAutoRange.Always });
  sciChartSurface.xAxes.add(xAxis);
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));

  // Horizontal error bars: high/low are X values around each point.
  let next = 0;
  const point = (i) => {
    const x = i * 0.1, err = 0.3 + 0.2 * Math.abs(Math.sin(i / 50));
    return [x, Math.sin(i / 300) * 10 + Math.cos(i / 37), x + err, x - err];
  };
  const cols = [[], [], [], []];
  for (; next < POINTS; next++) point(next).forEach((v, k) => cols[k].push(v));
  const dataSeries = new HlcDataSeries(wasmContext, { xValues: cols[0], yValues: cols[1], highValues: cols[2], lowValues: cols[3], isSorted: true, containsNaN: false });
  sciChartSurface.renderableSeries.add(new FastErrorBarsRenderableSeries(wasmContext, {
    dataSeries, errorDirection: EErrorDirection.Horizontal, errorMode: EErrorMode.Both, stroke: "#4e79a7", strokeThickness: 1,
  }));
  await P.sleep(500);

  sciChartSurface.rendered.subscribe(() => P.count("renders"));

  // Collect the MinMax results created inside a horizontal getXRange call; optionally delete the survivors (the fix).
  const NU = wasmContext.NumberUtil;
  let inside = null, smartPtrSeen = null, applyFix = false;
  P.hookMethod(NU, "MinMax", {
    name: "wasm NumberUtil::MinMax",
    onCall: (a, self, ret) => {
      if (smartPtrSeen === null && ret && ret.$$) smartPtrSeen = !!ret.$$.smartPtr;
      if (inside) inside.push(ret);
    },
  });
  const proto = HlcDataSeries.prototype;
  const getXRange = proto.getXRange;
  proto.getXRange = function (valueType, isHorizontal) {
    if (!isHorizontal) return getXRange.apply(this, arguments);
    const outer = inside;
    inside = [];
    try { return getXRange.apply(this, arguments); } finally {
      P.count("getXRange, horizontal branch");
      P.count("MinMax results created inside getXRange", inside.length);
      if (applyFix) inside.forEach((res) => { if (!res.isDeleted()) res.delete(); });
      P.count("MinMax results still alive when getXRange returns", inside.filter((res) => !res.isDeleted()).length);
      inside = outer;
    }
  };

  const ranges = () => P.native.snapshot().SCRTDoubleRange || { created: 0, deleted: 0, live: 0 };
  async function stream(label) {
    P.native.reset();
    P.native.start();
    const r = await P.frames(FRAMES, () => { const p = point(next++); dataSeries.append(p[0], p[1], p[2], p[3]); });
    P.native.stop();
    const nr = ranges(), renders = r.total("renders");
    const res = {
      renders,
      getXRange: r.total("getXRange, horizontal branch"),
      createdInside: r.total("MinMax results created inside getXRange"),
      aliveAfter: r.total("MinMax results still alive when getXRange returns"),
      created: nr.created, deleted: nr.deleted, leaked: nr.created - nr.deleted, p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Streaming with X autoRange = Always, library as shipped…");
  const shipped = await stream("as shipped");
  P.status("Streaming with X autoRange = Always, with the fix…");
  applyFix = true;
  const fixed = await stream("with fix (delete every MinMax result created in getXRange)");
  applyFix = false;

  // Default autoRange (Once): each zoom-to-fit still runs the leaking branch once.
  P.status("autoRange = Once, zoomExtents() x " + ZOOMS + "…");
  xAxis.autoRange = EAutoRange.Once;
  await P.idleFrames(5);
  P.native.reset();
  P.native.start();
  const z = await P.during(async () => { for (let i = 0; i < ZOOMS; i++) { sciChartSurface.zoomExtents(); await P.nextFrame(); } });
  P.native.stop();
  proto.getXRange = getXRange;
  const zr = ranges();
  const zoom = { calls: z.total("getXRange, horizontal branch"), aliveAfter: z.total("MinMax results still alive when getXRange returns"), created: zr.created, deleted: zr.deleted, leaked: zr.created - zr.deleted };
  P.log(`zoomExtents x ${ZOOMS}, autoRange Once: ${JSON.stringify(zoom)}`);

  const per = (res, v) => v / Math.max(1, res.renders);
  const reproduced = shipped.renders >= FRAMES * 0.5 && per(shipped, shipped.aliveAfter) >= 0.9 && per(shipped, shipped.leaked) >= 0.9
    && fixed.leaked === 0 && fixed.aliveAfter === 0 && smartPtrSeen === false;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each redraw's X auto-range creates ${per(shipped, shipped.createdInside).toFixed(1)} SCRTDoubleRange and frees ${per(shipped, shipped.createdInside - shipped.aliveAfter).toFixed(1)}: ${shipped.leaked} native objects leaked over ${shipped.renders} redraws (no GC finalizer). With both freed: ${fixed.leaked}. With autoRange Once, ${ZOOMS} zoomExtents() calls leaked ${zoom.leaked}.`
      : `Expected about 1 leaked SCRTDoubleRange per redraw; measured ${per(shipped, shipped.leaked).toFixed(2)} per redraw (${shipped.leaked} over ${shipped.renders} redraws), ${fixed.leaked} with the fix.`,
    columns: ["As shipped", "With fix"],
    rows: [
      ["Surface renders", shipped.renders, fixed.renders],
      ["getXRange calls (horizontal branch) per render", per(shipped, shipped.getXRange), per(fixed, fixed.getXRange)],
      ["MinMax results created inside getXRange per render", per(shipped, shipped.createdInside), per(fixed, fixed.createdInside)],
      ["… still alive when getXRange returns, per render", per(shipped, shipped.aliveAfter), per(fixed, fixed.aliveAfter)],
      ["SCRTDoubleRange created, whole page", shipped.created, fixed.created],
      ["SCRTDoubleRange deleted, whole page", shipped.deleted, fixed.deleted],
      ["SCRTDoubleRange never deleted, whole page", shipped.leaked, fixed.leaked],
      ["Leaked objects per minute at 60 redraws/s", per(shipped, shipped.leaked) * 3600, per(fixed, fixed.leaked) * 3600],
      ["Frame interval p95, ms (hardware-dependent)", shipped.p95, fixed.p95],
    ],
    notes: [
      `MinMax results carry a smart pointer (GC finalizer): ${smartPtrSeen === null ? "not observed" : smartPtrSeen ? "yes" : "no"}. Without one, a handle that is never delete()d keeps its native object until the wasm context is disposed.`,
      `zoomExtents() x ${ZOOMS} with autoRange = Once (the default): ${zoom.calls} horizontal getXRange calls, ${zoom.created} SCRTDoubleRange created on the page, ${zoom.deleted} deleted, ${zoom.leaked} leaked.`,
      "The default errorDirection is Vertical, which takes a different branch and does not leak. Counts do not depend on hardware. Each leaked object is small (two doubles plus allocator overhead), so wasm memory does not visibly grow in a 2-second run; the count grows without bound while the chart redraws.",
    ],
    metrics: { shipped, fixed, zoom, smartPtrSeen, points: POINTS },
  });
}
