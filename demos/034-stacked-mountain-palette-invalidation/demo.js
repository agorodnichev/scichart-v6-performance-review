const META = {
  id: "034",
  title: "Stacked mountains recompute their palette on every redraw, defeating shouldUpdatePalette()",
  issue: "issues/034-stacked-mountain-per-frame-palette-invalidation.md",
  severity: "medium",
  claim: "StackedXyCollection.draw assigns strokeY1DashArray on every layer each frame, and that setter has no equality check. Each assignment tells the band drawing provider to set palettingState.requiresUpdate, so a palette provider that opts into caching (shouldUpdatePalette() false, isRangeIndependant true) is still called for every visible point and a new native palette is created per layer on every redraw.",
  method: "<p>A StackedMountainCollection with 5 layers of 20,000 points. Each layer has a palette provider that opts into caching: shouldUpdatePalette() returns false and isRangeIndependant is true. Data never changes. Two scenarios run for 30 frames each: a plain redraw per frame (sciChartSurface.invalidateElement(), what any cursor, tooltip or annotation redraw causes) and a zoom-in step per frame. Counted per frame: STROKE_Y1_DASH_ARRAY notifications reaching BandSeriesDrawingProvider.onSeriesPropertyChange, overrideFillArgb calls, and native palettes created (new SCRTCreatePalette); timed: applyStrokeFillPaletting.</p><p>A/B: the strokeY1DashArray setter on the stacked mountain prototype gets the issue's fix (return early when areArraysEqual(old, new)), the same two scenarios run again, and the original setter is restored.</p>",
};

async function demo(P) {
  const { NumericAxis, StackedMountainCollection, StackedMountainRenderableSeries, BandSeriesDrawingProvider, XyDataSeries, EAutoRange, NumberRange, EFillPaletteMode, areArraysEqual } = P.SciChart;
  const S = 5, N = 20000, FRAMES = 30;
  const FILLS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f"];

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  const xAxis = new NumericAxis(wasmContext);
  sciChartSurface.xAxes.add(xAxis);
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));

  // A palette provider that follows the documented caching contract (SC-23).
  const makePaletteProvider = () => ({
    fillPaletteMode: EFillPaletteMode.SOLID,
    isRangeIndependant: true,
    shouldUpdatePalette() { return false; },
    onAttached() {},
    onDetached() {},
    overrideFillArgb(x, y, index) {
      P.count("overrideFillArgb calls");
      return index % 4000 < 1000 ? 0xffbab0ac : undefined; // grey bands every 4,000 points
    },
  });
  const xs = new Float64Array(N);
  for (let i = 0; i < N; i++) xs[i] = i;
  const coll = new StackedMountainCollection(wasmContext);
  for (let s = 0; s < S; s++) {
    const ys = new Float64Array(N);
    for (let i = 0; i < N; i++) ys[i] = 1 + Math.abs(Math.sin(i / 700 + s * 0.8)) * (1 + 0.2 * s);
    coll.add(new StackedMountainRenderableSeries(wasmContext, {
      dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: ys, isSorted: true, containsNaN: false }),
      fill: FILLS[s], stroke: "#2b2b2b", strokeThickness: 1, paletteProvider: makePaletteProvider(),
    }));
  }
  sciChartSurface.renderableSeries.add(coll);
  await P.sleep(600);

  // Counters
  P.hookMethod(BandSeriesDrawingProvider.prototype, "onSeriesPropertyChange", {
    name: "band onSeriesPropertyChange",
    onCall: (a) => { if (a[0] === "STROKE_Y1_DASH_ARRAY") P.count("STROKE_Y1_DASH_ARRAY notifications"); },
  });
  P.hookConstructor(wasmContext, "SCRTCreatePalette", { name: "native palettes created" });
  const baseDrawingProto = Object.getPrototypeOf(BandSeriesDrawingProvider.prototype); // BaseSeriesDrawingProvider
  P.hookMethod(baseDrawingProto, "applyStrokeFillPaletting", { name: "applyStrokeFillPaletting", time: true });

  const fullRange = () => new NumberRange(0, N - 1);
  async function scenario(label, kind) {
    xAxis.visibleRange = fullRange();
    await P.idleFrames(4);
    const r = await P.frames(FRAMES, (i) => {
      if (kind === "redraw") sciChartSurface.invalidateElement();
      else { const k = (i + 1) * 120; xAxis.visibleRange = new NumberRange(k, N - 1 - k); }
    });
    const res = {
      notifications: r.perFrame("STROKE_Y1_DASH_ARRAY notifications"),
      callbacks: r.perFrame("overrideFillArgb calls"),
      palettes: r.perFrame("native palettes created"),
      paletteMs: r.perFrame("applyStrokeFillPaletting", "t"),
      paletteCalls: r.perFrame("applyStrokeFillPaletting"),
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Redrawing and zooming, library as shipped…");
  const shippedRedraw = await scenario("as shipped, redraw per frame", "redraw");
  const shippedZoom = await scenario("as shipped, zoom step per frame", "zoom");

  // The issue's fix: an equality guard in the setter.
  const mountainProto = Object.getPrototypeOf(StackedMountainRenderableSeries.prototype); // BaseStackedMountainRenderableSeries
  const desc = Object.getOwnPropertyDescriptor(mountainProto, "strokeY1DashArray");
  Object.defineProperty(mountainProto, "strokeY1DashArray", {
    configurable: true, enumerable: desc.enumerable, get: desc.get,
    set(v) { if (areArraysEqual(this.strokeY1DashArrayProperty, v)) return; desc.set.call(this, v); },
  });
  P.status("Redrawing and zooming, with the setter guard…");
  const fixedRedraw = await scenario("with fix, redraw per frame", "redraw");
  const fixedZoom = await scenario("with fix, zoom step per frame", "zoom");
  // The cached palettes are still attached after the fixed run (colours not lost).
  const cachedLayers = coll.asArray().filter((rs) => { const ps = rs.drawingProviders[0].palettingState; return ps.palettedColors && ps.palettedColors.size() > 0; }).length;
  P.log(`layers with a cached palette after the fixed run: ${cachedLayers} of ${S}`);
  Object.defineProperty(mountainProto, "strokeY1DashArray", desc);
  xAxis.visibleRange = fullRange();

  const perRedraw = N * S;
  const reproduced = shippedRedraw.callbacks >= 0.9 * perRedraw && shippedRedraw.palettes >= 0.9 * S && shippedRedraw.notifications >= 0.9 * S;
  const fixWorks = fixedRedraw.callbacks <= 0.01 * perRedraw && fixedZoom.callbacks <= 0.01 * perRedraw && fixedRedraw.palettes < 0.1;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `With a caching palette provider and no data change, every redraw calls overrideFillArgb ${Math.round(shippedRedraw.callbacks).toLocaleString("en-US")} times (${S} layers x ${N.toLocaleString("en-US")} points) and creates ${shippedRedraw.palettes.toFixed(0)} native palettes. ` +
        (fixWorks ? `With the setter guard: ${Math.round(fixedRedraw.callbacks)} calls and ${fixedRedraw.palettes.toFixed(0)} palettes, also while zooming.` : `The setter guard did not remove them (see the table).`)
      : `Expected about ${perRedraw.toLocaleString("en-US")} palette callbacks per redraw; measured ${Math.round(shippedRedraw.callbacks).toLocaleString("en-US")}.`,
    columns: ["Redraw: shipped", "Redraw: fix", "Zoom: shipped", "Zoom: fix"],
    rows: [
      ["STROKE_Y1_DASH_ARRAY notifications to the drawing provider per frame", shippedRedraw.notifications, fixedRedraw.notifications, shippedZoom.notifications, fixedZoom.notifications],
      ["overrideFillArgb calls per frame", shippedRedraw.callbacks, fixedRedraw.callbacks, shippedZoom.callbacks, fixedZoom.callbacks],
      ["Native palettes created per frame (new SCRTCreatePalette)", shippedRedraw.palettes, fixedRedraw.palettes, shippedZoom.palettes, fixedZoom.palettes],
      ["Time in applyStrokeFillPaletting per frame, ms", shippedRedraw.paletteMs, fixedRedraw.paletteMs, shippedZoom.paletteMs, fixedZoom.paletteMs],
      ["Frame interval p95, ms", shippedRedraw.p95, fixedRedraw.p95, shippedZoom.p95, fixedZoom.p95],
    ],
    notes: [
      "The palette provider returns false from shouldUpdatePalette() and true from isRangeIndependant, so nothing should be recomputed after the first draw. Counts do not depend on hardware; times do.",
      `After the fixed run, ${cachedLayers} of ${S} layers still hold their cached palette, so the colours are kept. Stacked mountains without a palette provider only pay a pen-cache lookup for this assignment.`,
    ],
    metrics: { S, N, shippedRedraw, fixedRedraw, shippedZoom, fixedZoom, cachedLayers },
  });
}
