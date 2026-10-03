const META = {
  id: "045",
  title: "RolloverModifier.update() hit-tests every series twice when a tooltipLegendTemplate is set",
  issue: "issues/045-rollover-update-hit-tests-every-series-twice.md",
  severity: "medium",
  claim: "With a tooltipLegendTemplate, update() hit-tests each series in updateSeriesAnnotations and then again in getSeriesInfos for the legend, with the same mouse point and the same series list. update() runs on every pointer move and again in every full render.",
  method: "<p>50 line series of 1,000 points and a RolloverModifier with a tooltipLegendTemplate (the rollover legend pattern, showTooltip: false). The pointer sweeps the plot for 120 frames, one pointermove per frame, first over a static chart, then over a live chart (one invalidateElement() per frame stands for a data update, so every frame is a full render). The demo counts update() calls, the series hit tests made inside update() (RolloverModifier.hitTestRenderableSeries, hooked on the instance because the constructor binds it) and how many of them come from the legend pass (getSeriesInfos), wasm nearest-point searches (SCRTHitTestHelper.GetNearestXyPoint), getSeriesInfo calls, full renders and the time spent in update().</p><p>Then it applies the issue's fix at runtime: the hit tests of one update() are cached by series, so getSeriesInfos reuses the first pass (same series list, same mouse point). Both sweeps run again, and the legend content at a fixed pointer position is compared between both versions.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, RolloverModifier, SciChartRenderer } = P.SciChart;
  const SERIES = 50, POINTS = 1000, FRAMES = 120;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"];

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext));
  const xs = Array.from({ length: POINTS }, (_, i) => i);
  for (let s = 0; s < SERIES; s++) {
    sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, {
      dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 80 + s * 0.3) + s * 0.15), isSorted: true, containsNaN: false, dataSeriesName: `S${s + 1}` }),
      stroke: COLORS[s % COLORS.length], strokeThickness: 1,
    }));
  }
  // A compact legend: series count plus the first six values.
  const legend = (seriesInfos) => {
    const hit = seriesInfos.filter((si) => si.isHit);
    const lines = [`${hit.length} series`].concat(hit.slice(0, 6).map((si) => `${si.seriesName}: ${si.formattedYValue}`));
    const text = lines.map((l, i) => `<tspan x="8" dy="${i ? 14 : 0}">${l}</tspan>`).join("");
    return `<svg width="150" height="${lines.length * 14 + 12}"><rect width="100%" height="100%" rx="4" fill="#1d2330" fill-opacity="0.8"/><text x="8" y="16" font-size="11" fill="#ffffff">${text}</text></svg>`;
  };
  const rollover = new RolloverModifier({ showTooltip: false, tooltipLegendTemplate: legend });
  sciChartSurface.chartModifiers.add(rollover);
  await P.sleep(500);

  // Counters: attribute hit tests to update() and to its legend pass.
  const proto = RolloverModifier.prototype;
  let inUpdate = 0, inLegend = 0, updateMs = 0;
  const update = proto.update;
  proto.update = function () {
    inUpdate++;
    const t0 = P.now();
    try { return update.apply(this, arguments); } finally { inUpdate--; updateMs += P.now() - t0; P.count("update()"); }
  };
  const getSeriesInfos = proto.getSeriesInfos;
  proto.getSeriesInfos = function () { inLegend++; try { return getSeriesInfos.apply(this, arguments); } finally { inLegend--; } };
  // The constructor binds hitTestRenderableSeries, so the instance property is the one update() calls.
  P.hookMethod(rollover, "hitTestRenderableSeries", { name: "hitTestRenderableSeries", onCall: () => {
    if (inUpdate) P.count("hit tests inside update()");
    if (inUpdate && inLegend) P.count("hit tests in the legend pass");
  } });
  P.hookMethod(FastLineRenderableSeries.prototype, "getSeriesInfo", { name: "getSeriesInfo", onCall: () => { if (inUpdate) P.count("getSeriesInfo inside update()"); } });
  P.hookMethod(SciChartRenderer.prototype, "render", { name: "full renders" });
  P.watchEmbind(wasmContext, ["SCRTHitTestHelper::GetNearestXyPoint"]);

  const pointer = P.pointer(sciChartSurface);
  async function sweep(label, live) {
    pointer.enter(0.5, 0.5);
    await P.idleFrames(5);
    updateMs = 0;
    const r = await P.frames(FRAMES, (i) => {
      pointer.move(pointer.sweepX(i, 40), 0.5);
      if (live) sciChartSurface.invalidateElement(); // a data update on a live chart
    });
    const updates = r.total("update()");
    const res = {
      updatesPerFrame: updates / FRAMES,
      rendersPerFrame: r.perFrame("full renders"),
      hitTestsPerUpdate: r.total("hit tests inside update()") / updates,
      legendHitTestsPerUpdate: r.total("hit tests in the legend pass") / updates,
      hitTestsPerFrame: r.perFrame("hit tests inside update()"),
      wasmSearchesPerFrame: r.perFrame("wasm SCRTHitTestHelper::GetNearestXyPoint"),
      seriesInfosPerUpdate: r.total("getSeriesInfo inside update()") / updates,
      msPerFrame: updateMs / FRAMES,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    pointer.leave();
    await P.idleFrames(5);
    return res;
  }
  // Legend content at a fixed pointer position, to check that the fix keeps the output.
  async function legendAt(fx) {
    pointer.enter(fx, 0.5);
    await P.idleFrames(3);
    rollover.update();
    const s = rollover.legendAnnotation.seriesInfos.map((si) => `${si.seriesName}=${si.yValue}`).join("|");
    pointer.leave();
    await P.idleFrames(3);
    return s;
  }

  P.status("Sweeping the pointer, library as shipped…");
  const shippedStatic = await sweep("static chart, as shipped", false);
  const shippedLive = await sweep("live chart, as shipped", true);
  const legendShipped = await legendAt(0.37);

  // The fix from the issue: one hit test per series per update(), reused by the legend pass.
  const hitTest = rollover.hitTestRenderableSeries; // the counting wrapper: counts real hit tests only
  const updateCounted = proto.update;
  proto.update = function () {
    this.hitTestsThisUpdate = new Map();
    try { return updateCounted.apply(this, arguments); } finally { this.hitTestsThisUpdate = undefined; }
  };
  rollover.hitTestRenderableSeries = function (rs, mousePoint) {
    const cache = this.hitTestsThisUpdate;
    if (!cache || mousePoint !== this.mousePoint) return hitTest.call(this, rs, mousePoint);
    if (!cache.has(rs)) cache.set(rs, hitTest.call(this, rs, mousePoint));
    return cache.get(rs);
  };
  P.status("Sweeping the pointer, with hit tests reused within update()…");
  const fixedStatic = await sweep("static chart, with fix", false);
  const fixedLive = await sweep("live chart, with fix", true);
  const legendFixed = await legendAt(0.37);
  proto.update = update;
  proto.getSeriesInfos = getSeriesInfos;
  rollover.hitTestRenderableSeries = hitTest;

  const sameLegend = legendShipped === legendFixed && legendShipped.length > 0;
  const doubled = (r) => r.hitTestsPerUpdate >= 1.8 * SERIES && r.legendHitTestsPerUpdate >= 0.9 * SERIES;
  const single = (r) => r.hitTestsPerUpdate <= 1.1 * SERIES;
  const reproduced = doubled(shippedStatic) && doubled(shippedLive) && single(fixedStatic) && single(fixedLive) && sameLegend;
  const cols = [shippedStatic, fixedStatic, shippedLive, fixedLive];
  const row = (label, key) => [label].concat(cols.map((c) => c[key]));
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each update() hit-tests ${shippedStatic.hitTestsPerUpdate.toFixed(0)} times for ${SERIES} series: the legend pass repeats all ${shippedStatic.legendHitTestsPerUpdate.toFixed(0)}. On a live chart update() also runs in each full render, so a hovered frame costs ${shippedLive.hitTestsPerFrame.toFixed(0)} hit tests. Reusing the first pass: ${fixedStatic.hitTestsPerUpdate.toFixed(0)} per update(), ${fixedLive.hitTestsPerFrame.toFixed(0)} per live frame, same legend.`
      : `Expected about ${2 * SERIES} hit tests per update() with a legend template; measured ${shippedStatic.hitTestsPerUpdate.toFixed(1)} (static) and ${shippedLive.hitTestsPerUpdate.toFixed(1)} (live); with the fix ${fixedStatic.hitTestsPerUpdate.toFixed(1)} and ${fixedLive.hitTestsPerUpdate.toFixed(1)}; legend identical: ${sameLegend}.`,
    columns: ["Static chart, as shipped", "Static chart, with fix", "Live chart, as shipped", "Live chart, with fix"],
    rows: [
      row("update() calls per frame", "updatesPerFrame"),
      row("Full renders per frame", "rendersPerFrame"),
      row("Series hit tests per update()", "hitTestsPerUpdate"),
      row("  of which repeated by the legend pass (getSeriesInfos)", "legendHitTestsPerUpdate"),
      row("Series hit tests per frame", "hitTestsPerFrame"),
      row("wasm nearest-point searches per frame", "wasmSearchesPerFrame"),
      row("getSeriesInfo calls per update()", "seriesInfosPerUpdate"),
      ["Legend content at a fixed pointer position", "reference", sameLegend ? "identical" : "differs", "reference", sameLegend ? "identical" : "differs"],
      row("Time in update() per frame, ms", "msPerFrame"),
      row("Frame interval p95, ms", "p95"),
    ],
    notes: [
      "Counts do not depend on hardware; times do. Hover alone triggers only DOM-only renders (the rollover line is an SVG annotation by default, isSvgOnly: true), so update() runs once per move; on a live chart every full render runs update() again through onParentSurfaceLayoutComplete.",
      "getSeriesInfo stays at two calls per hit series with the fix, as in the issue's diff: it caches the hit tests, not the SeriesInfo objects.",
    ],
    metrics: { shippedStatic, fixedStatic, shippedLive, fixedLive, series: SERIES, sameLegend },
  });
}
