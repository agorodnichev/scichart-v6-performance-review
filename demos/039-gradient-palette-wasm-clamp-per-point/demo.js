const META = {
  id: "039",
  title: "PaletteFactory gradients call into wasm twice per point per frame (Constrain and count)",
  issue: "issues/039-gradient-palette-wasm-clamp-per-point.md",
  severity: "medium",
  claim: "The per-point callback of PaletteFactory.createGradient clamps an integer with the wasm NumberUtil.Constrain and reads the series length through dataSeries.count() (a wasm size() call), so every visible point costs two JS-to-wasm crossings on every frame, because the palette defines no shouldUpdatePalette.",
  method: "<p>A FastLineRenderableSeries of 100,000 points with <code>resamplingMode: None</code> (so the palette loop covers every point) and <code>paletteProvider: PaletteFactory.createGradient(...)</code>. The X axis pans a little every frame for 60 frames; all points stay visible and the data does not change. The demo counts wasm calls into <code>NumberUtil::Constrain</code> and <code>SCRTDoubleVector.size</code> (whole page), and calls of the palette's <code>overrideStrokeArgb</code>, and, in a second pass without the wasm call counters, times <code>applyStrokePaletting</code> (the per-point loop).</p><p>A/B, same gradient (same color map from <code>PaletteFactory.createColorMap</code>): (1) the issue's diff, a JS clamp instead of the wasm Constrain; (2) the issue's app-side workaround, JS clamp plus the series length cached in <code>shouldUpdatePalette()</code>, which the loop calls once per render. Before the runs, all 100,000 colors from the shipped palette and the replacement are compared.</p>",
};

async function demo(P) {
  const { NumericAxis, XyDataSeries, FastLineRenderableSeries, PaletteFactory, GradientParams, Point, NumberRange, EResamplingMode,
    EStrokePaletteMode, EFillPaletteMode, uintArgbColorMultiplyOpacity, LineSeriesDrawingProvider } = P.SciChart;
  const N = 100000, FRAMES = 60;

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  const xAxis = new NumericAxis(wasmContext, { visibleRange: new NumberRange(-N * 0.08, N * 1.08) });
  sciChartSurface.xAxes.add(xAxis);
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { visibleRange: new NumberRange(-2, 2) }));
  const xs = new Float64Array(N), ys = new Float64Array(N);
  for (let i = 0; i < N; i++) { xs[i] = i; ys[i] = Math.sin(i / 3000) + 0.3 * Math.sin(i / 97); }
  const dataSeries = new XyDataSeries(wasmContext, { xValues: xs, yValues: ys, isSorted: true, containsNaN: false });
  const gradient = new GradientParams(new Point(0, 0), new Point(1, 1), [
    { offset: 0, color: "#4e79a7" }, { offset: 0.5, color: "#edc948" }, { offset: 1, color: "#e15759" },
  ]);
  const shippedPalette = PaletteFactory.createGradient(wasmContext, gradient, { enableStroke: true });
  const rs = new FastLineRenderableSeries(wasmContext, { dataSeries, strokeThickness: 2, stroke: "#888888", resamplingMode: EResamplingMode.None, paletteProvider: shippedPalette });
  sciChartSurface.renderableSeries.add(rs);
  await P.sleep(500);

  // Replacement gradient provider: same color map and lerp; JS clamp; optionally the length cached per render.
  const colorData = PaletteFactory.createColorMap(wasmContext, gradient.gradientStops.slice(0));
  function jsGradient(cacheCount) {
    let series, count = 0;
    const doFunc = (index, opacity) => {
      const n = cacheCount ? count : series.getDataSeriesValuesCount();
      const raw = Math.round((index / (n - 1)) * (colorData.length - 1));
      const mapIndex = raw > 0 ? Math.min(raw, colorData.length - 1) : 0; // NaN -> 0
      return uintArgbColorMultiplyOpacity(colorData[mapIndex], opacity);
    };
    const palette = {
      strokePaletteMode: EStrokePaletteMode.GRADIENT, fillPaletteMode: EFillPaletteMode.GRADIENT,
      onAttached(s) { series = s; }, onDetached() {},
      overrideStrokeArgb(x, y, index) { return doFunc(index, 1); },
    };
    if (cacheCount) palette.shouldUpdatePalette = () => { count = series.getDataSeriesValuesCount(); return true; };
    return palette;
  }
  const jsClamp = jsGradient(false), jsClampCached = jsGradient(true);

  // Same colors? Compare every index once, outside the measured runs.
  jsClamp.onAttached(rs);
  let mismatches = 0;
  for (let i = 0; i < N; i++) if (shippedPalette.overrideStrokeArgb(xs[i], ys[i], i) !== jsClamp.overrideStrokeArgb(xs[i], ys[i], i)) mismatches++;
  P.log(`color check over ${N} indices: ${mismatches} mismatches`);

  sciChartSurface.rendered.subscribe(() => P.count("renders"));
  // wasm call counters (same as P.watchEmbind, kept removable for the timing pass)
  const undoConstrain = P.hookMethod(wasmContext.NumberUtil, "Constrain", { name: "wasm NumberUtil::Constrain" });
  const undoSize = P.hookMethod(wasmContext.SCRTDoubleVector.prototype, "size", { name: "wasm SCRTDoubleVector.size" });
  // applyStrokePaletting is inherited from BaseSeriesDrawingProvider (not exported by the UMD bundle).
  P.hookMethod(LineSeriesDrawingProvider.prototype, "applyStrokePaletting", { name: "palette loop", time: true });
  const countCalls = (palette) => { const f = palette.overrideStrokeArgb; palette.overrideStrokeArgb = function () { P.count("overrideStrokeArgb calls"); return f.apply(this, arguments); }; };
  [shippedPalette, jsClamp, jsClampCached].forEach(countCalls);

  async function pan(label, palette) {
    rs.paletteProvider = palette;
    await P.idleFrames(3);
    const r = await P.frames(FRAMES, (i) => { const d = N * 0.05 * Math.sin(i / 6); xAxis.visibleRange = new NumberRange(-N * 0.08 + d, N * 1.08 + d); });
    const renders = Math.max(1, r.total("renders"));
    const res = {
      renders: r.total("renders"),
      points: r.total("overrideStrokeArgb calls") / renders,
      constrain: r.total("wasm NumberUtil::Constrain") / renders,
      size: r.total("wasm SCRTDoubleVector.size") / renders,
      loopMs: r.total("palette loop", "t") / renders,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  // Pass 1: counts.
  P.status("Panning (counting), PaletteFactory.createGradient as shipped…");
  const shipped = await pan("counts, as shipped", shippedPalette);
  P.status("Panning (counting), JS clamp…");
  const clamp = await pan("counts, JS clamp", jsClamp);
  P.status("Panning (counting), JS clamp + cached count…");
  const cached = await pan("counts, JS clamp + cached count", jsClampCached);
  // Pass 2: timing, without the per-call wasm counters.
  undoConstrain();
  undoSize();
  const times = {};
  for (const [k, palette] of [["shipped", shippedPalette], ["clamp", jsClamp], ["cached", jsClampCached]]) {
    P.status(`Panning (timing), ${k}…`);
    times[k] = await pan(`timing, ${k}`, palette);
  }
  rs.paletteProvider = shippedPalette;

  // The loop itself also calls size() once per point (getMetadataAt -> validateIndex -> count()), whatever the palette.
  // The cached-count run makes no wasm call from the palette, so its size() count is that baseline.
  const baseline = cached.size;
  const fromPalette = (r) => (r.constrain + Math.max(0, r.size - baseline)) / Math.max(1, r.points);
  const reproduced = shipped.renders >= FRAMES * 0.5 && shipped.points >= N * 0.9 && shipped.constrain >= 0.95 * shipped.points
    && shipped.size - baseline >= 0.95 * shipped.points && clamp.constrain === 0 && cached.constrain === 0 && mismatches === 0;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each render of a ${N.toLocaleString("en-US")}-point gradient line makes ${fromPalette(shipped).toFixed(2)} wasm calls per point from the palette: ${Math.round(shipped.constrain).toLocaleString("en-US")} Constrain and ${Math.round(shipped.size - baseline).toLocaleString("en-US")} size(). JS clamp: ${fromPalette(clamp).toFixed(2)} per point; with the length cached as well: ${fromPalette(cached).toFixed(2)}. Same colors.`
      : `Expected about 2 wasm calls per point per render from the palette; measured ${shipped.constrain.toFixed(0)} Constrain and ${(shipped.size - baseline).toFixed(0)} extra size() calls for ${shipped.points.toFixed(0)} points.`,
    columns: ["As shipped", "JS clamp (issue diff)", "JS clamp + cached count"],
    rows: [
      ["Renders", shipped.renders, clamp.renders, cached.renders],
      ["overrideStrokeArgb calls per render", shipped.points, clamp.points, cached.points],
      ["wasm NumberUtil::Constrain calls per render", shipped.constrain, clamp.constrain, cached.constrain],
      ["wasm SCRTDoubleVector.size calls per render (whole page)", shipped.size, clamp.size, cached.size],
      ["… of which from the palette's count lookup (minus the right-hand column)", shipped.size - baseline, clamp.size - baseline, 0],
      ["wasm calls per point per render made by the palette", fromPalette(shipped), fromPalette(clamp), fromPalette(cached)],
      ["Time in applyStrokePaletting per render, ms (timing pass)", times.shipped.loopMs, times.clamp.loopMs, times.cached.loopMs],
      ["Frame interval p95, ms (timing pass)", times.shipped.p95, times.clamp.p95, times.cached.p95],
    ],
    notes: [
      `Color check: the replacement palette returns the same ARGB value as PaletteFactory.createGradient for all ${N.toLocaleString("en-US")} indices (${mismatches} mismatches).`,
      `The loop in applyStrokePaletting makes one more wasm size() call per point for any palette provider (${Math.round(baseline).toLocaleString("en-US")} per render here): it calls dataSeries.getMetadataAt(i), whose validateIndex reads count(). That call is not part of this issue and remains in every column.`,
      "The data does not change during the pan; the loop runs for every point on every render because the palette has no shouldUpdatePalette.",
      "Counts do not depend on hardware; times do. The timing pass runs without the wasm call counters; it keeps one counting wrapper per point, the same in every column.",
    ],
    metrics: { shipped, clamp, cached, times, points: N, mismatches },
  });
}
