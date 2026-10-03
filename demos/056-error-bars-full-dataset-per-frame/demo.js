const META = {
  id: "056",
  title: "Error bars process every data point on each redraw, ignoring the visible range",
  issue: "issues/056-error-bars-process-full-dataset-every-frame.md",
  severity: "medium",
  claim: "ErrorSeriesDrawingProvider.draw() uses startIndex 0 and the full series size, although the renderer has already computed the visible index range. The JS cap loop and the native DrawLinesVec calls therefore cover every point on every redraw, and on a logarithmic Y axis it builds every point's geometry with about 20 embind calls.",
  method: "<p>Left: a FastErrorBarsRenderableSeries with 100,000 points on linear axes, zoomed so that 1% of the points (about 1,000) are visible, panned for 60 frames. The demo counts, per frame: points handled by the JS cap loop (prepareTempCapVectors), elements handed to the native SCRTLineSegmentDrawingProvider.DrawLinesVec (connector + caps), and the visible index range of the series.</p><p>A/B: draw() replaced by the same code clipped to the visible index range with getStartAndCount, as in the issue's fix (vertical error bars, linear Y axis; other cases fall through to the shipped code).</p><p>Right: 10,000 points on a logarithmic Y axis, 1% visible, panned for 20 frames, as shipped. The demo counts the embind calls made inside draw(): coordinate conversions (getCoordinate), vertex updates (SCRTColorVertex.SetPosition and the m_uiColor setter) and VectorColorVertex.push_back.</p>",
};

async function demo(P) {
  const S = P.SciChart;
  const { NumericAxis, LogarithmicAxis, NumberRange, HlcDataSeries, FastErrorBarsRenderableSeries, ErrorSeriesDrawingProvider, EErrorDirection, EErrorMode,
    EAxisType, getScrtPenFromCache, vectorToArrayViewF64, LogarithmicCoordinateCalculator } = S;
  const N = 100000, NLOG = 10000, VISIBLE = 0.01, FRAMES = 60, LOG_FRAMES = 20;

  const makeSeries = (wasm, n) => {
    const xs = Array.from({ length: n }, (_, i) => i);
    const ys = xs.map((x) => 10 + 4 * Math.sin(x / 40));
    return new FastErrorBarsRenderableSeries(wasm, {
      dataSeries: new HlcDataSeries(wasm, { xValues: xs, yValues: ys, highValues: ys.map((y) => y + 2), lowValues: ys.map((y) => y - 2), isSorted: true, containsNaN: false }),
      stroke: "#4e79a7", strokeThickness: 1, dataPointWidth: 0.5,
    });
  };
  const lin = await P.createSurface("chart");
  const wasm = lin.wasmContext;
  const linX = new NumericAxis(wasm, { visibleRange: new NumberRange(0, N * VISIBLE) });
  lin.sciChartSurface.xAxes.add(linX);
  lin.sciChartSurface.yAxes.add(new NumericAxis(wasm, { visibleRange: new NumberRange(0, 20) }));
  const linSeries = makeSeries(wasm, N);
  lin.sciChartSurface.renderableSeries.add(linSeries);

  const log = await P.createSurface("chart2");
  const logX = new NumericAxis(log.wasmContext, { visibleRange: new NumberRange(0, NLOG * VISIBLE) });
  log.sciChartSurface.xAxes.add(logX);
  log.sciChartSurface.yAxes.add(new LogarithmicAxis(log.wasmContext, { logBase: 10, visibleRange: new NumberRange(1, 100) }));
  const logSeries = makeSeries(log.wasmContext, NLOG);
  log.sciChartSurface.renderableSeries.add(logSeries);
  await P.sleep(800);

  // Attribution: flag while ErrorSeriesDrawingProvider.draw runs; `impl` is what the A/B swaps.
  const proto = ErrorSeriesDrawingProvider.prototype;
  const shippedDraw = proto.draw;
  let impl = shippedDraw, inDraw = false;
  proto.draw = function () {
    inDraw = true;
    try { return impl.apply(this, arguments); } finally { inDraw = false; }
  };
  P.hookMethod(proto, "draw", { name: "error bars draw()", time: true });
  P.hookMethod(proto, "prepareTempCapVectors", { name: "cap loop", onCall: (a) => P.count("cap loop points", a[1]) });
  P.hookMethod(wasm.SCRTLineSegmentDrawingProvider.prototype, "DrawLinesVec", { name: "DrawLinesVec", onCall: (a) => P.count("DrawLinesVec elements", a[0].count) });
  // Embind calls made by the log-axis path.
  const calcProto = Object.getPrototypeOf(LogarithmicCoordinateCalculator.prototype);
  let calcOwner = calcProto;
  while (calcOwner && !Object.prototype.hasOwnProperty.call(calcOwner, "getCoordinate")) calcOwner = Object.getPrototypeOf(calcOwner);
  P.hookMethod(calcOwner, "getCoordinate", { name: "getCoordinate (all)", onCall: () => { if (inDraw) P.count("embind: getCoordinate"); } });
  P.hookMethod(wasm.SCRTColorVertex.prototype, "SetPosition", { name: "SetPosition (all)", onCall: () => { if (inDraw) P.count("embind: SCRTColorVertex.SetPosition"); } });
  P.hookAccessor(wasm.SCRTColorVertex.prototype, "m_uiColor", { name: "m_uiColor", set: true, get: false, onSet: () => { if (inDraw) P.count("embind: m_uiColor setter"); } });
  P.hookMethod(wasm.VectorColorVertex.prototype, "push_back", { name: "push_back (all)", onCall: () => { if (inDraw) P.count("embind: VectorColorVertex.push_back"); } });

  // The issue's fix for vertical error bars on a linear Y axis: clip to the visible index range.
  function capsFrom(startIndex, count, dataPointWidth, xValues, lowValues, highValues, hasHighCap, hasLowCap) {
    const s = (hasHighCap ? 2 : 0) + (hasLowCap ? 2 : 0);
    this.tempXVec.resizeFast(count * s);
    this.tempYVec.resizeFast(count * s);
    P.count("cap loop points", count);
    const half = dataPointWidth / 2, ctx = this.webAssemblyContext;
    const xView = vectorToArrayViewF64(xValues, ctx), tx = vectorToArrayViewF64(this.tempXVec, ctx), ty = vectorToArrayViewF64(this.tempYVec, ctx);
    if (hasHighCap && hasLowCap) {
      const minView = vectorToArrayViewF64(lowValues, ctx), maxView = vectorToArrayViewF64(highValues, ctx);
      for (let i = startIndex; i < startIndex + count; i++) {
        const x = xView[i], min = minView[i], max = maxView[i], o = (i - startIndex) * 4; // temp vectors hold count * s values
        tx[o] = x - half; ty[o] = max; tx[o + 1] = x + half; ty[o + 1] = max;
        tx[o + 2] = x - half; ty[o + 2] = min; tx[o + 3] = x + half; ty[o + 3] = min;
      }
    } else {
      const maxView = vectorToArrayViewF64(hasHighCap ? highValues : lowValues, ctx);
      for (let i = startIndex; i < startIndex + count; i++) {
        const x = xView[i], max = maxView[i], o = (i - startIndex) * 2;
        tx[o] = x - half; ty[o] = max; tx[o + 1] = x + half; ty[o + 1] = max;
      }
    }
    return count * s;
  }
  function drawWithFix(renderContext, renderPassData) {
    const rs = this.parentSeries;
    if (rs.errorDirection !== EErrorDirection.Vertical || rs.yAxis.type === EAxisType.LogarithmicAxis) return shippedDraw.apply(this, arguments);
    const linesPen = getScrtPenFromCache(this.linesPenCache);
    if (!linesPen || linesPen.GetThickness() === 0.0) return;
    const ps = renderPassData.pointSeries;
    const xDrawValues = renderPassData.xCoordinateCalculator.isCategoryCoordinateCalculator ? ps.indexes : ps.xValues;
    const widthCalc = renderPassData.xCoordinateCalculator;
    const dataPointWidth = widthCalc.getDataWidth(rs.getDataPointWidth(widthCalc, rs.dataPointWidth, rs.dataPointWidthMode));
    const hasHighCap = rs.errorMode !== EErrorMode.Low, hasLowCap = rs.errorMode !== EErrorMode.High;
    const { startIndex, count } = this.getStartAndCount(renderPassData, xDrawValues); // the fix
    this.args.Reset();
    this.args.SetLinesPen(linesPen);
    this.args.forceShaderMethod = true;
    this.args.verticalChart = renderPassData.isVerticalChart;
    this.args.startIndex = startIndex;
    this.args.count = count;
    if (rs.drawConnector) {
      this.args.fourVectorsMode = true;
      this.args.SetXValues(xDrawValues);
      this.args.SetYValues(hasHighCap ? ps.highValues : ps.yValues);
      this.args.SetZValues(xDrawValues);
      this.args.SetWValues(hasLowCap ? ps.lowValues : ps.yValues);
      this.args.SetNativeContext(renderContext.getNativeContext());
      this.args.SetXCoordinateCalculator(renderPassData.xCoordinateCalculator.nativeCalculator);
      this.args.SetYCoordinateCalculator(renderPassData.yCoordinateCalculator.nativeCalculator);
      this.nativeDrawingProvider.DrawLinesVec(this.args);
    }
    const capCount = capsFrom.call(this, startIndex, count, dataPointWidth, xDrawValues, ps.lowValues, ps.highValues, hasHighCap, hasLowCap);
    this.drawCaps(renderContext, renderPassData, linesPen, capCount);
  }

  const tri = (i) => { const k = (i % 40) / 40; return k < 0.5 ? k * 2 : 2 - k * 2; };
  async function pan(label, surface, axis, n, frames) {
    surface.invalidateElement();
    await P.idleFrames(3);
    const span = n * VISIBLE;
    const r = await P.frames(frames, (i) => { const o = n * 0.3 + span * 2 * tri(i); axis.visibleRange = new NumberRange(o, o + span); });
    const draws = r.total("error bars draw()");
    const rpd = (surface === lin.sciChartSurface ? linSeries : logSeries).getCurrentRenderPassData();
    const per = (name) => (draws ? r.total(name) / draws : 0);
    const res = {
      draws,
      visible: rpd && rpd.indexRange ? rpd.indexRange.diff + 1 : 0,
      capLoop: per("cap loop points"),
      drawLinesElements: per("DrawLinesVec elements"),
      getCoordinate: per("embind: getCoordinate"),
      vertexCalls: per("embind: SCRTColorVertex.SetPosition") + per("embind: m_uiColor setter"),
      pushBack: per("embind: VectorColorVertex.push_back"),
      msPerDraw: draws ? r.total("error bars draw()", "t") / draws : 0,
      p95: r.frameP95,
    };
    res.embindPerDraw = res.getCoordinate + res.vertexCalls + res.pushBack;
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Panning 100,000 error bars (1% visible), as shipped…");
  const shipped = await pan("linear, as shipped", lin.sciChartSurface, linX, N, FRAMES);
  P.status("Panning 100,000 error bars, clipped to the visible range (fix)…");
  impl = drawWithFix;
  const fixed = await pan("linear, clipped to the visible range", lin.sciChartSurface, linX, N, FRAMES);
  impl = shippedDraw;
  P.status("Panning 10,000 error bars on a log Y axis, as shipped…");
  const logRun = await pan("log Y, as shipped", log.sciChartSurface, logX, NLOG, LOG_FRAMES);
  proto.draw = shippedDraw;

  const full = shipped.draws >= FRAMES * 0.8 && shipped.capLoop >= 0.99 * N && shipped.visible <= 0.05 * N;
  const fixClips = fixed.draws >= FRAMES * 0.8 && fixed.capLoop <= 3 * fixed.visible + 10;
  const logFull = logRun.draws >= LOG_FRAMES * 0.8 && logRun.getCoordinate >= 3.9 * NLOG;
  const reproduced = full && fixClips;
  const fmt = (v) => Math.round(v).toLocaleString("en-US");
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `With ${fmt(shipped.visible)} of ${fmt(N)} error bars visible, each redraw runs the JS cap loop over ${fmt(shipped.capLoop)} points and hands ${fmt(shipped.drawLinesElements)} elements to DrawLinesVec. Clipped to the visible range: ${fmt(fixed.capLoop)} and ${fmt(fixed.drawLinesElements)}.` +
        (logFull ? ` On a log Y axis each redraw makes ${fmt(logRun.embindPerDraw)} embind calls for ${fmt(NLOG)} points (${(logRun.embindPerDraw / NLOG).toFixed(1)} per point, ${fmt(logRun.visible)} visible).` : "")
      : `Expected per-redraw work over all ${fmt(N)} points; measured a cap loop over ${fmt(shipped.capLoop)} points with ${fmt(shipped.visible)} visible (clipped: ${fmt(fixed.capLoop)}).`,
    columns: ["Linear Y, as shipped", "Linear Y, clipped (fix)", "Log Y, as shipped"],
    rows: [
      ["Points in the series", N, N, NLOG],
      ["Visible points (index range)", shipped.visible, fixed.visible, logRun.visible],
      ["Redraws in the phase", shipped.draws, fixed.draws, logRun.draws],
      ["Points in the JS cap loop per redraw", shipped.capLoop, fixed.capLoop, logRun.capLoop],
      ["Elements handed to native DrawLinesVec per redraw", shipped.drawLinesElements, fixed.drawLinesElements, logRun.drawLinesElements],
      ["Embind getCoordinate calls per redraw", shipped.getCoordinate, fixed.getCoordinate, logRun.getCoordinate],
      ["Embind vertex updates + push_back per redraw", shipped.vertexCalls + shipped.pushBack, fixed.vertexCalls + fixed.pushBack, logRun.vertexCalls + logRun.pushBack],
      ["Time in error bars draw() per redraw, ms", shipped.msPerDraw, fixed.msPerDraw, logRun.msPerDraw],
      ["Frame interval p95, ms", shipped.p95, fixed.p95, logRun.p95],
    ],
    notes: [
      "DrawLinesVec elements = connector points + 4 cap points per error bar. Whether the engine culls off-screen segments is not visible from JS; the JS loops are certain. Counts do not depend on hardware; times do.",
      "The fix clips vertical error bars only: a horizontal error bar can reach into view from a centre outside the X range. The log-axis column has no A/B because the issue's log-path rewrite is a follow-up; clipping alone would cut its per-redraw calls in proportion to the visible share.",
    ],
    metrics: { N, NLOG, visibleShare: VISIBLE, shipped, fixed, log: logRun },
  });
}
