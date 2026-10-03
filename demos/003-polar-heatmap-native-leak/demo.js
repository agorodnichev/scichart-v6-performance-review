const META = {
  id: "003",
  title: "Polar heatmap and contour series leak one native object on every redraw",
  issue: "issues/003-native-objects-created-per-redraw-never-deleted.md",
  severity: "high",
  claim: "PolarHeatmapDrawingProvider.draw() creates a new native SCRTHeatmapSeriesDrawingProvider on every redraw and never deletes it, and UniformContoursDrawingProvider.draw() drops the TSRVector4 that SCRTFillTextureFloat32 returns. Embind objects are freed only by .delete(), so each redraw leaves one more object in the wasm heap.",
  method: "<p>Left: a UniformContoursRenderableSeries (100 x 100 grid) on a SciChartSurface. Right: a PolarUniformHeatmapRenderableSeries (100 x 50 cells) on a SciChartPolarSurface. Both surfaces share one wasm context. Each phase forces 120 redraws of one surface (invalidateElement() once per frame, no data changes) and reads the harness's native-object ledger, which counts every embind handle created (Object.create with $$) and every .delete(), per class.</p><p>A/B: the polar phase runs again with PolarHeatmapDrawingProvider.prototype.draw replaced by the same code holding one native provider per series (the library fix from the issue). The contour phase runs again with the TSRVector4 returned to UniformContoursDrawingProvider deleted on return (the issue's one-line fix). Both patches are removed afterwards.</p><p>Also measured (other location in the issue): an error-bars series removed with remove(series, false) and re-added 30 times. ErrorSeriesDrawingProvider.onAttachSeries creates a native SCRTLineDrawingParams and SCRTLineSegmentDrawingProvider; onDetachSeries frees neither. The A/B frees them in onDetachSeries.</p>",
};

async function demo(P) {
  const S = P.SciChart;
  const {
    NumericAxis, NumberRange, SciChartPolarSurface, PolarNumericAxis, EPolarAxisMode, UniformHeatmapDataSeries, HeatmapColorMap,
    PolarUniformHeatmapRenderableSeries, UniformContoursRenderableSeries, FastErrorBarsRenderableSeries, HlcDataSeries,
    PolarHeatmapDrawingProvider, UniformContoursDrawingProvider, ErrorSeriesDrawingProvider,
  } = S;
  const FRAMES = 120, CYCLES = 30;
  const stops = [{ offset: 0, color: "#1d2b64" }, { offset: 0.5, color: "#59a14f" }, { offset: 1, color: "#e15759" }];

  // Cartesian surface: contours (and later an error-bars series). P.createSurface also installs the .delete() counter.
  const cart = await P.createSurface("chart");
  const wasm = cart.wasmContext;
  const cs = cart.sciChartSurface;
  cs.xAxes.add(new NumericAxis(wasm, { visibleRange: new NumberRange(0, 100) }));
  cs.yAxes.add(new NumericAxis(wasm, { visibleRange: new NumberRange(0, 100) }));
  const N = 100;
  const zc = Array.from({ length: N }, (_, y) => Array.from({ length: N }, (_, x) => Math.sin(x / 9) * Math.cos(y / 11) * 50 + 50));
  const contours = new UniformContoursRenderableSeries(wasm, {
    dataSeries: new UniformHeatmapDataSeries(wasm, { xStart: 0, xStep: 1, yStart: 0, yStep: 1, zValues: zc }),
    zMin: 0, zMax: 100, zStep: 10,
  });
  cs.renderableSeries.add(contours);

  // Polar surface: uniform heatmap. createMultichart shares the wasm context with the cartesian surface.
  const polar = await SciChartPolarSurface.create("chart2");
  if (polar.wasmContext !== wasm) {
    P.report({ verdict: "inconclusive", headline: "The polar surface got its own wasm context, so the native .delete() counter does not cover it." });
    return;
  }
  const ps = polar.sciChartSurface;
  ps.xAxes.add(new PolarNumericAxis(wasm, { polarAxisMode: EPolarAxisMode.Angular, visibleRange: new NumberRange(0, 100) }));
  ps.yAxes.add(new PolarNumericAxis(wasm, { polarAxisMode: EPolarAxisMode.Radial, visibleRange: new NumberRange(0, 50) }));
  const zp = Array.from({ length: 50 }, (_, y) => Array.from({ length: 100 }, (_, x) => Math.sin(x / 8) * Math.cos(y / 6)));
  ps.renderableSeries.add(new PolarUniformHeatmapRenderableSeries(wasm, {
    dataSeries: new UniformHeatmapDataSeries(wasm, { xStart: 0, xStep: 1, yStart: 0, yStep: 1, zValues: zp }),
    colorMap: new HeatmapColorMap({ minimum: -1, maximum: 1, gradientStops: stops }),
  }));
  await P.sleep(600);

  // Count draws of each provider (the wrapper delegates to `impl`, which the A/B swaps).
  const polarProto = PolarHeatmapDrawingProvider.prototype, contourProto = UniformContoursDrawingProvider.prototype;
  const shippedPolarDraw = polarProto.draw, shippedContourDraw = contourProto.draw;
  let polarImpl = shippedPolarDraw, inContour = false;
  polarProto.draw = function () { P.count("polar heatmap draw()"); return polarImpl.apply(this, arguments); };
  contourProto.draw = function () {
    P.count("contour draw()");
    inContour = true;
    try { return shippedContourDraw.apply(this, arguments); } finally { inContour = false; }
  };
  // TSRVector4 values returned to the contour provider; in the A/B they are deleted on return.
  const fillFloat = wasm.SCRTFillTextureFloat32;
  let deleteContourReturn = false;
  wasm.SCRTFillTextureFloat32 = function () {
    const ret = fillFloat.apply(this, arguments);
    if (inContour) {
      P.count("TSRVector4 returned to the contour provider");
      if (deleteContourReturn) ret.delete(); // fix: SCRTFillTextureFloat32(...).delete()
    }
    return ret;
  };

  // The library fix for the polar heatmap: same code as draw(), one native provider per series.
  const cachedProviders = new Set();
  function polarDrawWithFix(renderContext, renderPassData) {
    const heatTexture = this.heatTextureCache && this.heatTextureCache.value;
    if (!heatTexture) return;
    const dataSeries = this.parentSeries.dataSeries;
    const xStartValue = dataSeries.xStart;
    const xStartCoord = renderPassData.xCoordinateCalculator.getCoordinate(xStartValue);
    const row0 = dataSeries.getZValues()[0];
    const xEndValue = xStartValue + dataSeries.xStep * (row0 ? row0.length : 0);
    const xEndCoord = renderPassData.xCoordinateCalculator.getCoordinate(xEndValue);
    const zValuesVector = dataSeries.getNormalizedVector(this.parentSeries.colorMap, this.parentSeries.fillValuesOutOfRange);
    this.packedFloatParams = this.webAssemblyContext.SCRTFillTextureFloat32(heatTexture, dataSeries.arrayWidth, dataSeries.arrayHeight, zValuesVector);
    this.packedFloatParams.x = 0;
    this.packedFloatParams.y = 1;
    this.packedFloatParams.z = this.parentSeries.linearTextureFilteringIntensity;
    this.packedFloatParams.w = this.parentSeries.useLinearTextureFiltering ? 1 : 0;
    const yRange = dataSeries.yRange;
    const innerRadius = renderPassData.yCoordinateCalculator.getCoordinate(yRange.min);
    const outerRadius = renderPassData.yCoordinateCalculator.getCoordinate(yRange.max);
    renderContext.getNativeContext();
    const v4 = this.packedFloatParams;
    const contourParams = new this.webAssemblyContext.SCRTContourParams();
    if (!this.nativeHeatmapProvider) {
      this.nativeHeatmapProvider = new this.webAssemblyContext.SCRTHeatmapSeriesDrawingProvider();
      cachedProviders.add(this);
    }
    this.recreatePalette();
    const polarTransform = this.parentSeries.xAxis.getTransform();
    this.nativeHeatmapProvider.DrawPolarHeatmap(polarTransform, innerRadius, outerRadius, xStartCoord, this.paletteTexture.getTexture(), heatTexture, v4, contourParams, xEndCoord);
    contourParams.delete();
    v4.delete();
  }

  // One measured phase: `frames` redraws of `surface`, native ledger over the phase.
  async function redraws(label, surface, drawCounter) {
    await P.idleFrames(3);
    P.native.reset();
    P.native.start();
    const r = await P.frames(FRAMES, () => surface.invalidateElement());
    P.native.stop();
    const nat = P.native.snapshot();
    const get = (cls) => nat[cls] || { created: 0, deleted: 0, live: 0 };
    const res = { draws: r.total(drawCounter), returned: r.total("TSRVector4 returned to the contour provider"), provider: get("SCRTHeatmapSeriesDrawingProvider"), v4: get("TSRVector4"), p95: r.frameP95 };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  const heapBefore = P.memory(wasm).wasmMemoryMB;
  P.status("Redrawing the polar heatmap, library as shipped…");
  const polarShipped = await redraws("polar heatmap, as shipped", ps, "polar heatmap draw()");
  P.status("Redrawing the polar heatmap, with one native provider per series…");
  polarImpl = polarDrawWithFix;
  const polarFixed = await redraws("polar heatmap, with fix", ps, "polar heatmap draw()");
  polarImpl = shippedPolarDraw;

  P.status("Redrawing the contours, library as shipped…");
  const contShipped = await redraws("contours, as shipped", cs, "contour draw()");
  P.status("Redrawing the contours, deleting the returned TSRVector4…");
  deleteContourReturn = true;
  const contFixed = await redraws("contours, with fix", cs, "contour draw()");
  deleteContourReturn = false;
  const heapAfter = P.memory(wasm).wasmMemoryMB;

  // Restore the library and free the provider the fix cached.
  polarProto.draw = shippedPolarDraw;
  contourProto.draw = shippedContourDraw;
  wasm.SCRTFillTextureFloat32 = fillFloat;
  cachedProviders.forEach((dp) => { dp.nativeHeatmapProvider.delete(); dp.nativeHeatmapProvider = undefined; });

  // Error bars: detach and re-attach the same series.
  cs.renderableSeries.remove(contours, false);
  const xs = Array.from({ length: 50 }, (_, i) => i * 2 + 1);
  const ys = xs.map((x) => 50 + 30 * Math.sin(x / 10));
  const errorBars = new FastErrorBarsRenderableSeries(wasm, {
    dataSeries: new HlcDataSeries(wasm, { xValues: xs, yValues: ys, highValues: ys.map((y) => y + 6), lowValues: ys.map((y) => y - 6) }),
    stroke: "#4e79a7", strokeThickness: 1,
  });
  cs.renderableSeries.add(errorBars);
  await P.sleep(300);
  async function attachCycles(label) {
    P.native.reset();
    P.native.start();
    for (let i = 0; i < CYCLES; i++) {
      cs.renderableSeries.remove(errorBars, false); // detach without deleting the series
      cs.renderableSeries.add(errorBars);
      await P.nextFrame();
    }
    await P.nextFrame();
    P.native.stop();
    const nat = P.native.snapshot();
    const get = (cls) => nat[cls] || { created: 0, deleted: 0, live: 0 };
    const res = { args: get("SCRTLineDrawingParams"), provider: get("SCRTLineSegmentDrawingProvider") };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }
  P.status("Detaching and re-attaching an error-bars series, as shipped…");
  const ebShipped = await attachCycles("error bars attach/detach, as shipped");
  const ebProto = ErrorSeriesDrawingProvider.prototype;
  const shippedDetach = ebProto.onDetachSeries;
  ebProto.onDetachSeries = function () {
    shippedDetach.apply(this, arguments);
    if (this.nativeDrawingProvider) { this.nativeDrawingProvider.delete(); this.nativeDrawingProvider = undefined; }
    if (this.args) { this.args.delete(); this.args = undefined; }
  };
  P.status("Detaching and re-attaching an error-bars series, freeing them in onDetachSeries…");
  const ebFixed = await attachCycles("error bars attach/detach, with fix");
  ebProto.onDetachSeries = shippedDetach;

  // Verdict: a leak = one more live object per draw as shipped, and (about) none with the fix.
  const polarLeak = polarShipped.draws >= FRAMES * 0.5 && polarShipped.provider.created >= 0.9 * polarShipped.draws &&
    polarShipped.provider.deleted === 0 && polarFixed.provider.created <= 1;
  const contLeak = contShipped.draws >= FRAMES * 0.5 && contShipped.v4.live >= 0.9 * contShipped.draws &&
    contFixed.v4.live <= 0.1 * contFixed.draws;
  const ebLeak = ebShipped.args.live >= CYCLES * 0.9 && ebShipped.provider.live >= CYCLES * 0.9 && ebFixed.args.live <= 1 && ebFixed.provider.live <= 1;
  const reproduced = polarLeak && contLeak;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `${polarShipped.draws} polar heatmap redraws created ${polarShipped.provider.created} native SCRTHeatmapSeriesDrawingProvider objects and deleted ${polarShipped.provider.deleted}; ${contShipped.draws} contour redraws left ${contShipped.v4.live} TSRVector4 alive. With the fixes: ${polarFixed.provider.created} provider and ${contFixed.v4.live} vectors.`
      : `Expected one leaked native object per redraw. Polar: ${polarShipped.provider.created} providers created, ${polarShipped.provider.deleted} deleted in ${polarShipped.draws} draws; contours: ${contShipped.v4.live} TSRVector4 alive after ${contShipped.draws} draws.`,
    columns: ["As shipped", "With fix"],
    rows: [
      ["Polar heatmap draw() calls", polarShipped.draws, polarFixed.draws],
      ["SCRTHeatmapSeriesDrawingProvider created", polarShipped.provider.created, polarFixed.provider.created],
      ["SCRTHeatmapSeriesDrawingProvider deleted", polarShipped.provider.deleted, polarFixed.provider.deleted],
      ["SCRTHeatmapSeriesDrawingProvider still alive after the phase (the fix keeps 1 per series)", polarShipped.provider.live, polarFixed.provider.live],
      ["Contour draw() calls", contShipped.draws, contFixed.draws],
      ["TSRVector4 returned to the contour provider", contShipped.returned, contFixed.returned],
      ["TSRVector4 created minus deleted over the phase (whole page)", contShipped.v4.live, contFixed.v4.live],
      [`Error bars: native args + provider left alive after ${CYCLES} detach/attach cycles`, ebShipped.args.live + ebShipped.provider.live, ebFixed.args.live + ebFixed.provider.live],
      ["Frame interval p95 during polar redraws, ms", polarShipped.p95, polarFixed.p95],
    ],
    notes: [
      "Counts do not depend on hardware. Each live object is a wasm-heap allocation that nothing can free later: it stays until the page is closed. Its byte size is not visible from JS.",
      `Error bars (other location in the issue): ${ebLeak ? "reproduced" : "not reproduced"}: as shipped ${ebShipped.args.created} SCRTLineDrawingParams and ${ebShipped.provider.created} SCRTLineSegmentDrawingProvider were created and ${ebShipped.args.deleted + ebShipped.provider.deleted} deleted over ${CYCLES} cycles.`,
      `wasm memory: ${heapBefore} MB before the redraw phases, ${heapAfter} MB after (the heap grows in large steps, so a few hundred small objects do not show here).`,
    ],
    metrics: { frames: FRAMES, polarShipped, polarFixed, contShipped, contFixed, ebShipped, ebFixed, heapBefore, heapAfter },
  });
}
