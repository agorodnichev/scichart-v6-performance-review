const META = {
  id: "005",
  title: "Mountain series rerun their palette provider for every point on every redraw",
  issue: "issues/005-mountain-palette-cache-forced-dirty-every-frame.md",
  severity: "high",
  claim: "MountainSeriesDrawingProvider.createBrush() runs on every draw and sets palettingState.requiresUpdate = true, so a palette provider whose shouldUpdatePalette() returns false is still called once per drawn point on every redraw. The polar band path (PolarMountain, PolarBand) has no palette cache check at all.",
  method: "<p>Left: a FastMountainRenderableSeries and a FastBandRenderableSeries (y1 = 0, the issue's suggested alternative), 100,000 points each, default resampling. Right: a PolarMountainRenderableSeries with 100,000 points. Each series has its own fill palette provider that follows the documented cache pattern: shouldUpdatePalette() returns true once and then false, isRangeIndependant is true, and the colours depend only on the data.</p><p>Each phase forces 60 redraws with no data or viewport change (invalidateElement() once per frame, as when another series or a modifier redraws the surface) and counts overrideFillArgb calls per redraw for each series, next to the number of points the series draws.</p><p>A/B: MountainSeriesDrawingProvider.prototype.createBrush is wrapped so that it marks the palette dirty only when the brush cache really built a new brush (the library fix from the issue), and the same 60 redraws run again. The issue lists no workaround for the polar path, so it runs as shipped only.</p>",
};

async function demo(P) {
  const S = P.SciChart;
  const { NumericAxis, NumberRange, XyDataSeries, XyyDataSeries, FastMountainRenderableSeries, FastBandRenderableSeries, SciChartPolarSurface,
    PolarNumericAxis, EPolarAxisMode, PolarMountainRenderableSeries, EFillPaletteMode, EResamplingMode, MountainSeriesDrawingProvider } = S;
  const N = 100000, FRAMES = 60;
  const HIGHLIGHT = 0xffe15759; // ARGB

  // Fill palette provider using the documented cache (SC-23): recompute only when told to.
  class CachedFillPalette {
    constructor(label) { this.label = label; this.calls = 0; this.dirty = true; this.fillPaletteMode = EFillPaletteMode.SOLID; }
    onAttached() {}
    onDetached() {}
    get isRangeIndependant() { return true; }
    shouldUpdatePalette() { const d = this.dirty; this.dirty = false; return d; }
    overrideFillArgb(x, y) { this.calls++; return y > 0.6 ? HIGHLIGHT : undefined; }
  }

  const xs = Array.from({ length: N }, (_, i) => i);
  const ys = xs.map((x) => Math.sin(x / 2000) * 0.8 + Math.sin(x / 97) * 0.2);

  const cart = await P.createSurface("chart");
  const wasm = cart.wasmContext, cs = cart.sciChartSurface;
  cs.xAxes.add(new NumericAxis(wasm));
  cs.yAxes.add(new NumericAxis(wasm, { visibleRange: new NumberRange(-2.2, 1.2) }));
  const mountainPP = new CachedFillPalette("mountain"), bandPP = new CachedFillPalette("band"), polarPP = new CachedFillPalette("polar");
  const mountain = new FastMountainRenderableSeries(wasm, {
    dataSeries: new XyDataSeries(wasm, { xValues: xs, yValues: ys, isSorted: true, containsNaN: false }),
    fill: "#4e79a7", stroke: "#2b4c7e", paletteProvider: mountainPP,
  });
  const band = new FastBandRenderableSeries(wasm, {
    dataSeries: new XyyDataSeries(wasm, { xValues: xs, yValues: ys.map((y) => y - 1.2), y1Values: xs.map(() => -1.2), isSorted: true, containsNaN: false }),
    fill: "#59a14f", fillY1: "#59a14f", stroke: "#3b6e34", strokeY1: "#3b6e34", paletteProvider: bandPP,
  });
  cs.renderableSeries.add(mountain, band);

  const polar = await SciChartPolarSurface.create("chart2");
  const ps = polar.sciChartSurface;
  ps.xAxes.add(new PolarNumericAxis(polar.wasmContext, { polarAxisMode: EPolarAxisMode.Angular, visibleRange: new NumberRange(0, N) }));
  ps.yAxes.add(new PolarNumericAxis(polar.wasmContext, { polarAxisMode: EPolarAxisMode.Radial, visibleRange: new NumberRange(0, 2) }));
  const polarMountain = new PolarMountainRenderableSeries(polar.wasmContext, {
    dataSeries: new XyDataSeries(polar.wasmContext, { xValues: xs, yValues: ys.map((y) => y + 1), isSorted: true, containsNaN: false }),
    fill: "#b07aa1", stroke: "#7d4f71", paletteProvider: polarPP,
  });
  ps.renderableSeries.add(polarMountain);
  await P.sleep(800);

  // Time in the cartesian palette loop (BaseSeriesDrawingProvider is not exported: take it from the prototype chain).
  const baseProto = Object.getPrototypeOf(MountainSeriesDrawingProvider.prototype);
  P.hookMethod(baseProto, "applyStrokeFillPaletting", { name: "applyStrokeFillPaletting", time: true });
  const series = { mountain: [mountain, mountainPP], band: [band, bandPP], polar: [polarMountain, polarPP] };
  P.hookMethod(MountainSeriesDrawingProvider.prototype, "draw", { name: "draw mountain" });
  P.hookMethod(S.BandSeriesDrawingProvider.prototype, "draw", { name: "draw band" });
  P.hookMethod(S.PolarBandSeriesDrawingProvider.prototype, "draw", { name: "draw polar" });

  // Points the series draws in a redraw: the resampled count, or the visible index range (BaseSeriesDrawingProvider.getStartAndCount).
  function drawnPoints(rs) {
    const rpd = rs.getCurrentRenderPassData();
    if (!rpd || !rpd.pointSeries) return 0;
    const n = rpd.pointSeries.xValues.size();
    return rpd.pointSeries.resampled || !rpd.indexRange ? n : Math.min(n, rpd.indexRange.diff + 1);
  }

  async function redraws(label, surface, names, frames = FRAMES) {
    surface.invalidateElement();
    await P.idleFrames(5);
    const before = names.map((n) => series[n][1].calls);
    const r = await P.frames(frames, () => surface.invalidateElement());
    const out = {};
    names.forEach((n, i) => {
      const draws = r.total("draw " + n);
      out[n] = { draws, callsPerDraw: draws ? (series[n][1].calls - before[i]) / draws : 0, points: drawnPoints(series[n][0]) };
    });
    out.paletteMs = r.perFrame("applyStrokeFillPaletting", "t");
    out.p95 = r.frameP95;
    P.log(`${label}: ${JSON.stringify(out)}`);
    return out;
  }

  // Library fix: only a real brush rebuild marks the palette dirty.
  const proto = MountainSeriesDrawingProvider.prototype;
  const shippedCreateBrush = proto.createBrush;
  function createBrushWithFix() {
    const before = this.palettingState.requiresUpdate;
    const previous = this.fillBrushCache.cachedEntity;
    const brush = shippedCreateBrush.apply(this, arguments);
    if (this.fillBrushCache.cachedEntity === previous) this.palettingState.requiresUpdate = before;
    return brush;
  }

  P.status("Redrawing the cartesian chart, library as shipped…");
  const shipped = await redraws("cartesian, as shipped", cs, ["mountain", "band"]);
  P.status("Redrawing the cartesian chart, createBrush fix…");
  proto.createBrush = createBrushWithFix;
  const fixed = await redraws("cartesian, createBrush fix", cs, ["mountain", "band"]);
  proto.createBrush = shippedCreateBrush;

  // Same redraws with resampling off: every visible point is drawn, and so goes through the palette loop.
  mountain.resamplingMode = EResamplingMode.None;
  band.resamplingMode = EResamplingMode.None;
  P.status("Resampling off, as shipped…");
  const shippedAll = await redraws("cartesian, resampling off, as shipped", cs, ["mountain", "band"], FRAMES / 2);
  P.status("Resampling off, createBrush fix…");
  proto.createBrush = createBrushWithFix;
  const fixedAll = await redraws("cartesian, resampling off, createBrush fix", cs, ["mountain", "band"], FRAMES / 2);
  proto.createBrush = shippedCreateBrush;
  mountain.resamplingMode = EResamplingMode.Auto;
  band.resamplingMode = EResamplingMode.Auto;

  P.status("Redrawing the polar chart, as shipped…");
  const polarRun = await redraws("polar, as shipped", ps, ["polar"]);

  const m0 = shipped.mountain, m1 = fixed.mountain, b0 = shipped.band, p0 = polarRun.polar;
  const forced = m0.draws >= FRAMES * 0.8 && m0.points > 0 && m0.callsPerDraw >= 0.9 * m0.points &&
    shippedAll.mountain.callsPerDraw >= 0.9 * shippedAll.mountain.points;
  const fixWorks = m1.draws >= FRAMES * 0.8 && m1.callsPerDraw <= 0.01 * Math.max(1, m1.points) &&
    fixedAll.mountain.callsPerDraw <= 0.01 * Math.max(1, fixedAll.mountain.points);
  const bandCached = b0.draws >= FRAMES * 0.8 && b0.callsPerDraw <= 0.01 * Math.max(1, b0.points);
  const polarUngated = p0.draws >= FRAMES * 0.8 && p0.points > 0 && p0.callsPerDraw >= 0.9 * p0.points;
  const reproduced = forced && fixWorks;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `With a palette provider that says "no update", the mountain series still calls it ${Math.round(m0.callsPerDraw).toLocaleString("en-US")} times per redraw (once per drawn point; ${Math.round(shippedAll.mountain.callsPerDraw).toLocaleString("en-US")} with resampling off); the band series with the same provider: ${Math.round(b0.callsPerDraw)}. With the createBrush fix: ${Math.round(m1.callsPerDraw)}.` +
        (polarUngated ? ` The polar mountain also calls it ${Math.round(p0.callsPerDraw).toLocaleString("en-US")} times per redraw.` : "")
      : `Expected the mountain series to call the palette provider once per drawn point per redraw; measured ${m0.callsPerDraw.toFixed(1)} calls per redraw for ${m0.points} drawn points (fix: ${m1.callsPerDraw.toFixed(1)}).`,
    columns: ["Mountain, as shipped", "Mountain, createBrush fix", "Band (control)", "Polar mountain, as shipped"],
    rows: [
      ["Redraws in the phase", m0.draws, m1.draws, b0.draws, p0.draws],
      ["Points drawn per redraw (resampled)", m0.points, m1.points, b0.points, p0.points],
      ["overrideFillArgb calls per redraw", m0.callsPerDraw, m1.callsPerDraw, b0.callsPerDraw, p0.callsPerDraw],
      ["Time in applyStrokeFillPaletting per frame (mountain + band), ms", shipped.paletteMs, fixed.paletteMs, null, null],
      ["Frame interval p95, ms", shipped.p95, fixed.p95, shipped.p95, polarRun.p95],
      ["Resampling off: points drawn per redraw", shippedAll.mountain.points, fixedAll.mountain.points, shippedAll.band.points, null],
      ["Resampling off: overrideFillArgb calls per redraw", shippedAll.mountain.callsPerDraw, fixedAll.mountain.callsPerDraw, shippedAll.band.callsPerDraw, null],
      ["Resampling off: time in applyStrokeFillPaletting per frame, ms", shippedAll.paletteMs, fixedAll.paletteMs, null, null],
    ],
    notes: [
      "The band column comes from the same redraws as the first column: it goes through the same applyStrokeFillPaletting code, and only the mountain provider forces the update. Counts do not depend on hardware; times do.",
      "The first rows use the library default, where each series draws its resampled points. The resampling-off rows (30 redraws each) show the case the issue sizes: one callback per visible point, here all 100,000.",
      polarUngated ? "Polar: PolarBandSeriesDrawingProvider.applyFillFillPaletting has no requiresUpdate or shouldUpdatePalette check, so PolarMountain, PolarBand and PolarStackedMountain recompute on every redraw. The issue lists no app-side workaround for them." : "Polar: the per-redraw recompute did not show in this run.",
    ],
    metrics: { N, frames: FRAMES, shipped, fixed, shippedAll, fixedAll, polar: polarRun, bandCached, polarUngated },
  });
}
