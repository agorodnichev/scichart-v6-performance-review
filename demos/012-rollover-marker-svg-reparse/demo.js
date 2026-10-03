const META = {
  id: "012",
  title: "RolloverModifier markers re-parse their SVG and call getBBox on every render",
  issue: "issues/012-rollover-marker-typo-rebuilds-svg-and-forces-layout.md",
  severity: "high",
  claim: "RolloverMarkerSvgAnnotation.create() compares instead of assigning (this.currentColor === color), so the colour check always fails: every render removes each series' 8x8 marker <svg>, parses a new one and measures it with getBBox.",
  method: "<p>10 line series with a default RolloverModifier. The pointer sweeps the plot for 120 frames, one pointermove per frame. The demo counts, per frame: marker update() calls, SVG parses (Range.createContextualFragment) and getBBox calls made inside a marker update, and the time spent in marker update(). It then patches RolloverMarkerSvgAnnotation.prototype.create with the workaround from the issue (assign currentColor after create) and runs the same sweep again.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, RolloverModifier, RolloverMarkerSvgAnnotation } = P.SciChart;
  const SERIES = 10, POINTS = 1000, FRAMES = 120;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"];

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext));
  const xs = Array.from({ length: POINTS }, (_, i) => i);
  for (let s = 0; s < SERIES; s++) {
    const ys = xs.map((x) => Math.sin(x / 60 + s) + s * 0.6);
    sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, {
      dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: ys, isSorted: true, containsNaN: false }),
      stroke: COLORS[s % COLORS.length], strokeThickness: 2,
    }));
  }
  sciChartSurface.chartModifiers.add(new RolloverModifier());
  await P.sleep(500);

  // Attribute parses and getBBox calls to marker updates.
  P.watch.layout();
  const proto = RolloverMarkerSvgAnnotation.prototype;
  let inMarker = false, markerMs = 0;
  const update = proto.update;
  proto.update = function () {
    inMarker = true;
    const t0 = P.now();
    try { return update.apply(this, arguments); } finally {
      inMarker = false;
      P.count("marker update()");
      markerMs += P.now() - t0;
    }
  };
  P.hookMethod(SVGGraphicsElement.prototype, "getBBox", { name: "getBBox (all)", onCall: () => { if (inMarker) P.count("getBBox inside marker update"); } });
  P.hookMethod(Range.prototype, "createContextualFragment", { name: "parse (all)", onCall: () => { if (inMarker) P.count("marker SVG parses"); } });

  const pointer = P.pointer(sciChartSurface);
  async function sweep(label) {
    pointer.enter(0.5, 0.5);
    await P.idleFrames(5);
    markerMs = 0;
    const r = await P.frames(FRAMES, (i) => pointer.move(pointer.sweepX(i, 40), 0.5));
    const res = {
      updates: r.perFrame("marker update()"),
      parses: r.perFrame("marker SVG parses"),
      bbox: r.perFrame("getBBox inside marker update"),
      forced: r.perFrame("layout reads after a DOM write (forced layout)"),
      ms: markerMs / FRAMES,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    pointer.leave();
    await P.idleFrames(5);
    return res;
  }

  P.status("Sweeping the pointer, library as shipped…");
  const shipped = await sweep("as shipped");

  // Workaround from the issue: remember the colour after create(), as the guard intended.
  const create = proto.create;
  proto.create = function () {
    create.apply(this, arguments);
    const p = this.tooltipProps;
    this.currentColor = p.markerColor != null ? p.markerColor : p.tooltipColor;
  };
  P.status("Sweeping the pointer, with the one-line fix…");
  const fixed = await sweep("with fix");
  proto.create = create;

  const reproduced = shipped.parses >= SERIES * 0.8 && shipped.bbox >= SERIES * 0.8 && fixed.parses <= SERIES * 0.1;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each render re-parses ${shipped.parses.toFixed(1)} marker SVGs and calls getBBox ${shipped.bbox.toFixed(1)} times (${SERIES} series). With currentColor assigned: ${fixed.parses.toFixed(1)} and ${fixed.bbox.toFixed(1)}.`
      : `Expected about ${SERIES} marker re-parses per frame; measured ${shipped.parses.toFixed(1)} (fixed: ${fixed.parses.toFixed(1)}).`,
    columns: ["As shipped", "With fix"],
    rows: [
      ["Marker update() calls per frame", shipped.updates, fixed.updates],
      ["Marker SVG parses per frame", shipped.parses, fixed.parses],
      ["getBBox calls inside marker update() per frame", shipped.bbox, fixed.bbox],
      ["Layout reads after a DOM write, per frame (whole page)", shipped.forced, fixed.forced],
      ["Time in marker update() per frame, ms", shipped.ms, fixed.ms],
      ["Frame interval p95, ms", shipped.p95, fixed.p95],
    ],
    notes: [
      "Counts do not depend on hardware; times do. The rollover tooltips (issue 023) also re-render each frame and are counted in the whole-page layout row in both columns.",
    ],
    metrics: { shipped, fixed, series: SERIES },
  });
}
