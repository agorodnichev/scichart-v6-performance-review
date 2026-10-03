const META = {
  id: "015",
  title: "SciChartOverview's selection annotations force a layout and re-parse the grip adorner on every overview render",
  issue: "issues/015-overview-annotation-forced-layout-and-adorner-reparse-per-re.md",
  severity: "high",
  claim: "Each of the overview's three OverviewCustomResizableAnnotation instances writes its styles and x/y/width/height, then calls getBoundingClientRect() (the stored rect only feeds borders that update() overwrites), so every overview render runs three interleaved forced layouts. The drag box also removes and re-parses its grip adorner SVG on every render, even when the markup is identical.",
  method: "<p>A main chart (one line series, 3,000 points, X range fixed to a window) with <code>SciChartOverview.create()</code> below it; the overview shares the series' data. Scenario A appends 5 points per frame for 90 frames (the overview X axis auto-ranges, so the box moves in pixels). Scenario B updates 20 Y values in place per frame for 90 frames (<code>dataSeries.update()</code>), so the overview X range and the box stay fixed. Per overview render (counted with <code>rendered</code>) the demo counts OverviewCustomResizableAnnotation.update() calls, layout reads made inside them (getBoundingClientRect, getBBox) and how many came right after a DOM write (the harness's forced-layout counter), and adorner parses through annotationHelpers.createSvg, comparing each adorner's markup with the previous one.</p><p>A/B: each scenario runs again with the library fix from the issue applied at runtime: inside update() the svg's getBoundingClientRect returns a DOMRect built from the x/y/width/height just written, and updateAdornerInner keeps the existing adorner when its clipped markup is unchanged. Patches are removed afterwards.</p>",
};

async function demo(P) {
  const { NumericAxis, NumberRange, EAutoRange, FastLineRenderableSeries, XyDataSeries, SciChartOverview, OverviewCustomResizableAnnotation, annotationHelpers } = P.SciChart;
  const FRAMES = 90, POINTS = 3000, BATCH = 5, UPDATES = 20;
  const OVERVIEW_ANNOTATIONS = 3; // drag box + shading before and after it

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Never, visibleRange: new NumberRange(1200, 2200) }));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always, growBy: new NumberRange(0.1, 0.1) }));
  const yAt = (x, phase) => Math.sin(x / 90 + phase) + 0.3 * Math.sin(x / 13);
  const dataSeries = new XyDataSeries(wasmContext, {
    xValues: Array.from({ length: POINTS }, (_, i) => i),
    yValues: Array.from({ length: POINTS }, (_, i) => yAt(i, 0)),
    isSorted: true, containsNaN: false,
  });
  sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries, stroke: "#4e79a7", strokeThickness: 2 }));
  const overview = await SciChartOverview.create(sciChartSurface, "overview");
  const overviewSurface = overview.overviewSciChartSurface;
  overviewSurface.rendered.subscribe(() => P.count("overview renders"));
  await P.sleep(600);

  let nextX = POINTS;
  const appendBatch = () => {
    const xs = [], ys = [];
    for (let k = 0; k < BATCH; k++, nextX++) { xs.push(nextX); ys.push(yAt(nextX, 0)); }
    dataSeries.appendRange(xs, ys);
  };
  let tick = 0;
  const updateInPlace = () => {
    tick++;
    const n = dataSeries.count();
    for (let k = 0; k < UPDATES; k++) {
      const i = (tick * UPDATES + k * 97) % n;
      dataSeries.update(i, yAt(i, tick / 10));
    }
  };

  // ---- counters attributed to OverviewCustomResizableAnnotation
  P.watch.layout();
  const READS = "layout reads", FORCED = "layout reads after a DOM write (forced layout)";
  const cnt = (name) => { const r = P.snap()[name]; return r ? r.n : 0; };
  const proto = OverviewCustomResizableAnnotation.prototype;
  let current = null, updateMs = 0, fixOn = false;
  const origUpdate = proto.update;
  proto.update = function () {
    const r0 = cnt(READS), f0 = cnt(FORCED), t0 = P.now();
    current = this;
    try { return origUpdate.apply(this, arguments); } finally {
      current = null;
      updateMs += P.now() - t0;
      P.count("overview annotation update()");
      const dr = cnt(READS) - r0, df = cnt(FORCED) - f0;
      if (dr) P.count("layout reads inside update()", dr);
      if (df) P.count("forced layouts inside update()", df);
    }
  };
  // Fix part 1: the rect stored by update() is built from the values it just wrote, without a layout read.
  const gbcrCounted = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    if (current && this === current.svg) {
      P.count("getBoundingClientRect inside update()");
      if (fixOn) {
        const el = this.firstElementChild;
        const n = (a) => Number(el.getAttribute(a)) || 0;
        return new DOMRect(n("x"), n("y"), n("width"), n("height"));
      }
    }
    return gbcrCounted.apply(this, arguments);
  };
  // Adorner parses, and whether the markup equals the previous adorner of the same annotation.
  let adornerOwner = null;
  const lastMarkup = new WeakMap();
  const origCreateSvg = annotationHelpers.createSvg;
  annotationHelpers.createSvg = function (svgString) {
    if (adornerOwner) {
      P.count("adorner parses");
      if (lastMarkup.get(adornerOwner) === svgString) P.count("adorner parses with unchanged markup");
      lastMarkup.set(adornerOwner, svgString);
    }
    return origCreateSvg.apply(this, arguments);
  };
  const origAdorner = proto.updateAdornerInner;
  // Fix part 2 (from the issue): keep the adorner when its clipped markup has not changed.
  const fixedAdorner = function () {
    if (!this.adornerSvgStringTemplate) { this.deleteAdorner(); return; }
    const { x1, x2, y1, y2 } = this.getAdornerAnnotationBorders(true);
    const clipped = this.applySvgClipping(this.adornerSvgStringTemplate(x1, y1, x2, y2), this.adornerClipping);
    if (this.svgAdorner && clipped === this.__fixLastAdorner) return;
    this.deleteAdorner();
    this.__fixLastAdorner = clipped;
    this.svgAdorner = annotationHelpers.createSvg(clipped, this.svgAdornerRoot);
  };
  proto.updateAdornerInner = function () {
    adornerOwner = this;
    try { return (fixOn ? fixedAdorner : origAdorner).apply(this, arguments); } finally { adornerOwner = null; }
  };

  async function run(label, perFrame, fix) {
    fixOn = fix;
    updateMs = 0;
    const r = await P.frames(FRAMES, perFrame);
    fixOn = false;
    const renders = Math.max(1, r.total("overview renders"));
    const res = {
      rendersPerFrame: r.total("overview renders") / FRAMES,
      updates: r.total("overview annotation update()") / renders,
      gbcr: r.total("getBoundingClientRect inside update()") / renders,
      reads: r.total("layout reads inside update()") / renders,
      forced: r.total("forced layouts inside update()") / renders,
      parses: r.total("adorner parses") / renders,
      sameParses: r.total("adorner parses with unchanged markup") / renders,
      ms: updateMs / renders,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Scenario A: appending 5 points per frame, as shipped then with the fix…");
  const aShipped = await run("A: appendRange per frame, as shipped", appendBatch, false);
  const aFixed = await run("A: appendRange per frame, with fix", appendBatch, true);
  P.status("Scenario B: updating Y values in place, as shipped then with the fix…");
  const bShipped = await run("B: Y-only updates in place, as shipped", updateInPlace, false);
  const bFixed = await run("B: Y-only updates in place, with fix", updateInPlace, true);

  proto.update = origUpdate;
  proto.updateAdornerInner = origAdorner;
  Element.prototype.getBoundingClientRect = gbcrCounted;
  annotationHelpers.createSvg = origCreateSvg;

  const all = [aShipped, aFixed, bShipped, bFixed];
  const rendered = all.every((s) => s.rendersPerFrame >= 0.8);
  const forcedOk = [aShipped, bShipped].every((s) => s.updates >= OVERVIEW_ANNOTATIONS * 0.8 && s.forced >= OVERVIEW_ANNOTATIONS * 0.8);
  const reparseOk = bShipped.sameParses >= 0.8;
  const fixOk = [aFixed, bFixed].every((s) => s.reads <= 0.1 * OVERVIEW_ANNOTATIONS) && bFixed.parses <= 0.1;
  const reproduced = rendered && forcedOk && reparseOk && fixOk;
  const verdict = !rendered ? "inconclusive" : reproduced ? "reproduced" : "not-reproduced";
  P.report({
    verdict,
    headline: !rendered
      ? `The overview did not render once per frame in every run (renders per frame: ${all.map((s) => s.rendersPerFrame.toFixed(2)).join(", ")}), so the counts cannot be compared.`
      : reproduced
      ? `Every overview render runs ${aShipped.forced.toFixed(2)} forced layouts from the selection annotations' update() (A: streaming; B: ${bShipped.forced.toFixed(2)}) and, with the box standing still (B), re-parses an identical grip adorner ${bShipped.sameParses.toFixed(2)} times. With the fix: ${aFixed.forced.toFixed(2)} / ${bFixed.forced.toFixed(2)} forced layouts and ${bFixed.parses.toFixed(2)} adorner parses in B.`
      : `Expected ${OVERVIEW_ANNOTATIONS} forced layouts and, in B, one unchanged adorner re-parse per overview render; measured A ${aShipped.forced.toFixed(2)}, B ${bShipped.forced.toFixed(2)} forced and ${bShipped.sameParses.toFixed(2)} unchanged re-parses (fix: ${aFixed.reads.toFixed(2)} / ${bFixed.reads.toFixed(2)} reads, ${bFixed.parses.toFixed(2)} parses).`,
    columns: ["A streaming: as shipped", "with fix", "B Y-only: as shipped", "with fix"],
    rows: [
      ["Overview renders per frame", ...all.map((s) => s.rendersPerFrame)],
      ["OverviewCustomResizableAnnotation.update() per render", ...all.map((s) => s.updates)],
      ["getBoundingClientRect() on the annotation svg, per render", ...all.map((s) => s.gbcr)],
      ["Layout reads that reached the browser inside update(), per render", ...all.map((s) => s.reads)],
      ["...of which right after a DOM write (forced layout)", ...all.map((s) => s.forced)],
      ["Grip adorner SVG parses per render", ...all.map((s) => s.parses)],
      ["...with markup identical to the previous adorner", ...all.map((s) => s.sameParses)],
      ["Time in update() per render, ms", ...all.map((s) => s.ms)],
      ["Frame interval p95, ms", ...all.map((s) => s.p95)],
    ],
    notes: [
      "In A the overview X axis grows with the data (EAutoRange.Always), so the box moves a little in pixels on most frames and rebuilding the adorner is legitimate there; the forced layouts are not. In B nothing moves, so every adorner parse is wasted.",
      "With the fix the getBoundingClientRect call still happens in update() but is answered from the values just written (counted in the getBoundingClientRect row, not in the layout-read rows).",
      "Counts do not depend on hardware; the time rows do, and other pages share this machine's CPU.",
    ],
    metrics: { aShipped, aFixed, bShipped, bFixed },
  });
}
