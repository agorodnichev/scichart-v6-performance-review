const META = {
  id: "013",
  title: "CursorModifier's SVG crosshair re-measures its axis labels on every render, even while hidden",
  issue: "issues/013-svgline-axis-label-getbbox-every-render-even-hidden.md",
  severity: "high",
  claim: "SvgLineAnnotation.update() rewrites each crosshair axis label (textContent and 8 attributes) and then reads getBBox() on every render. The label branch never checks isHidden, so a default CursorModifier forces style and layout twice per frame on a streaming chart, also while the pointer is elsewhere.",
  method: "<p>One line series streams 5 points per frame (FIFO, X axis auto-ranging) with a default <code>new CursorModifier()</code> (showAxisLabels and isSvgOnly default to true, so it adds two SvgLineAnnotation lines). Each scenario runs for 90 frames: pointer never entered the chart, a hover sweep (one pointermove per frame), and pointer left again. Per chart render (counted with <code>sciChartSurface.rendered</code>) the demo counts SvgLineAnnotation.update() and drawSvgAxisLabel() calls, getBBox() calls made inside drawSvgAxisLabel(), and how many of those reads came right after a DOM write (the harness's forced-layout counter). It also records whether both crosshair lines are hidden.</p><p>A/B: each scenario runs again with a runtime patch of <code>SvgLineAnnotation.prototype.drawSvgAxisLabel</code> that follows the library fix in the issue: a hidden line keeps its label and returns before any DOM write or getBBox, and a visible label is re-measured only when its text or font changed. The patch is removed after each run.</p>",
};

async function demo(P) {
  const { NumericAxis, NumberRange, EAutoRange, FastLineRenderableSeries, XyDataSeries, CursorModifier, SvgLineAnnotation } = P.SciChart;
  const FRAMES = 90, BATCH = 5, FIFO = 1500, SWEEP = 40;
  const LINES = 2; // CursorModifier adds an X line and a Y line, each labels one axis

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Never, visibleRange: new NumberRange(-1.5, 1.5) }));
  const dataSeries = new XyDataSeries(wasmContext, { fifoCapacity: FIFO, isSorted: true, containsNaN: false });
  let x = 0;
  const append = () => {
    const xs = [], ys = [];
    for (let k = 0; k < BATCH; k++, x++) { xs.push(x); ys.push(Math.sin(x / 60) + 0.2 * Math.sin(x / 7)); }
    dataSeries.appendRange(xs, ys);
  };
  for (let i = 0; i < FIFO / BATCH; i++) append();
  sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries, stroke: "#4e79a7", strokeThickness: 2 }));
  const cursor = new CursorModifier(); // defaults as shipped
  sciChartSurface.chartModifiers.add(cursor);
  sciChartSurface.rendered.subscribe(() => P.count("chart renders"));
  await P.sleep(500);

  // ---- counters attributed to the crosshair lines
  P.watch.layout();
  const FORCED = "layout reads after a DOM write (forced layout)";
  const forcedNow = () => { const r = P.snap()[FORCED]; return r ? r.n : 0; };
  const proto = SvgLineAnnotation.prototype;
  let inLabel = false, updateMs = 0;
  const origUpdate = proto.update;
  proto.update = function () {
    const t0 = P.now();
    try { return origUpdate.apply(this, arguments); } finally {
      updateMs += P.now() - t0;
      P.count("SvgLineAnnotation.update()");
      if (this.isHidden) P.count("update() of a hidden line");
    }
  };
  const origDraw = proto.drawSvgAxisLabel;
  let drawImpl = origDraw; // swapped for the fix below
  proto.drawSvgAxisLabel = function () {
    const f0 = forcedNow();
    inLabel = true;
    try { return drawImpl.apply(this, arguments); } finally {
      inLabel = false;
      P.count("drawSvgAxisLabel()");
      const df = forcedNow() - f0;
      if (df) P.count("forced layouts inside drawSvgAxisLabel", df);
    }
  };
  P.hookMethod(SVGGraphicsElement.prototype, "getBBox", { name: "getBBox (all)", onCall: () => { if (inLabel) P.count("getBBox inside drawSvgAxisLabel"); } });

  // ---- the library fix from the issue, as a runtime patch of drawSvgAxisLabel
  const memoized = [];
  function memoizeBBox(el) {
    let key = null, box = null;
    el.getBBox = function () {
      const k = el.textContent + "|" + el.getAttribute("font-family") + "|" + el.getAttribute("font-size");
      if (k === key && box && box.width > 0) return box; // text and font unchanged: no layout read
      box = SVGGraphicsElement.prototype.getBBox.call(el);
      key = k;
      return box;
    };
    memoized.push(el);
  }
  const fixedDraw = function (axis, coord) {
    if (this.isHidden) {
      const cached = this.labelCache.get(axis.id);
      if (cached) cached.inUse = true; // keep the label; no text/attribute writes, no getBBox
      return;
    }
    const before = this.labelCache.get(axis.id);
    if (before && !memoized.includes(before.text)) memoizeBBox(before.text);
    const r = origDraw.apply(this, arguments);
    const after = this.labelCache.get(axis.id);
    if (after && !memoized.includes(after.text)) memoizeBBox(after.text);
    return r;
  };
  const withFix = async (fn) => {
    drawImpl = fixedDraw;
    try { return await fn(); } finally {
      drawImpl = origDraw;
      memoized.splice(0).forEach((el) => { delete el.getBBox; });
    }
  };

  // ---- scenarios
  const pointer = P.pointer(sciChartSurface);
  async function run(label, perFrame) {
    updateMs = 0;
    const r = await P.frames(FRAMES, (i) => { append(); if (perFrame) perFrame(i); });
    const renders = Math.max(1, r.total("chart renders"));
    const res = {
      rendersPerFrame: r.total("chart renders") / FRAMES,
      updates: r.total("SvgLineAnnotation.update()") / renders,
      hiddenUpdates: r.total("update() of a hidden line") / renders,
      labels: r.total("drawSvgAxisLabel()") / renders,
      bbox: r.total("getBBox inside drawSvgAxisLabel") / renders,
      forced: r.total("forced layouts inside drawSvgAxisLabel") / renders,
      bothHidden: !!(cursor.xLineAnnotation && cursor.yLineAnnotation && cursor.xLineAnnotation.isHidden && cursor.yLineAnnotation.isHidden),
      ms: updateMs / renders,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Pointer never entered, streaming: as shipped, then with the fix…");
  const neverShipped = await run("pointer never entered, as shipped");
  const neverFixed = await withFix(() => run("pointer never entered, with fix"));

  P.status("Hover sweep, streaming: as shipped, then with the fix…");
  pointer.enter(0.5, 0.5);
  await P.idleFrames(5);
  const sweep = (i) => pointer.move(pointer.sweepX(i, SWEEP), 0.5);
  const sweepShipped = await run("hover sweep, as shipped", sweep);
  const sweepFixed = await withFix(() => run("hover sweep, with fix", sweep));

  P.status("Pointer left, streaming: as shipped, then with the fix…");
  pointer.leave();
  await P.idleFrames(5);
  const leftShipped = await run("pointer left, as shipped");
  const leftFixed = await withFix(() => run("pointer left, with fix"));

  proto.update = origUpdate;
  proto.drawSvgAxisLabel = origDraw;

  const hiddenRuns = [neverShipped, leftShipped];
  const hiddenOk = hiddenRuns.every((s) => s.bothHidden && s.bbox >= LINES * 0.8);
  const fixOk = [neverFixed, leftFixed].every((s) => s.bbox <= LINES * 0.1);
  const reproduced = hiddenOk && fixOk;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `With the crosshair hidden, every render still calls getBBox ${neverShipped.bbox.toFixed(2)} times (pointer never entered) and ${leftShipped.bbox.toFixed(2)} times (pointer left) from drawSvgAxisLabel, ${neverShipped.forced.toFixed(2)} of them right after a DOM write. With the fix: ${neverFixed.bbox.toFixed(2)} and ${leftFixed.bbox.toFixed(2)}; hover sweep ${sweepShipped.bbox.toFixed(2)} -> ${sweepFixed.bbox.toFixed(2)}.`
      : `Expected about ${LINES} getBBox calls per render from the hidden crosshair's labels; measured ${neverShipped.bbox.toFixed(2)} (never entered) and ${leftShipped.bbox.toFixed(2)} (left), hidden: ${neverShipped.bothHidden}/${leftShipped.bothHidden}; with the fix ${neverFixed.bbox.toFixed(2)} / ${leftFixed.bbox.toFixed(2)}.`,
    columns: ["Never entered: as shipped", "with fix", "Hover sweep: as shipped", "with fix", "Pointer left: as shipped", "with fix"],
    rows: [
      ["Both crosshair lines hidden", ...[neverShipped, neverFixed, sweepShipped, sweepFixed, leftShipped, leftFixed].map((s) => (s.bothHidden ? "yes" : "no"))],
      ["Chart renders per frame", ...[neverShipped, neverFixed, sweepShipped, sweepFixed, leftShipped, leftFixed].map((s) => s.rendersPerFrame)],
      ["SvgLineAnnotation.update() per render", ...[neverShipped, neverFixed, sweepShipped, sweepFixed, leftShipped, leftFixed].map((s) => s.updates)],
      ["drawSvgAxisLabel() per render", ...[neverShipped, neverFixed, sweepShipped, sweepFixed, leftShipped, leftFixed].map((s) => s.labels)],
      ["getBBox() inside drawSvgAxisLabel per render", ...[neverShipped, neverFixed, sweepShipped, sweepFixed, leftShipped, leftFixed].map((s) => s.bbox)],
      ["...of which right after a DOM write (forced layout)", ...[neverShipped, neverFixed, sweepShipped, sweepFixed, leftShipped, leftFixed].map((s) => s.forced)],
      ["Time in SvgLineAnnotation.update() per render, ms", ...[neverShipped, neverFixed, sweepShipped, sweepFixed, leftShipped, leftFixed].map((s) => s.ms)],
      ["Frame interval p95, ms", ...[neverShipped, neverFixed, sweepShipped, sweepFixed, leftShipped, leftFixed].map((s) => s.p95)],
    ],
    notes: [
      "Before the first hover both lines have no coordinates, resolve to 0 and label the X axis at pixel 0; after the pointer leaves they keep their last coordinates. In both states the label branch runs for an invisible crosshair.",
      "During the sweep the X label text changes every frame, so the fixed version still measures that one label once per render; the Y label (fixed pointer height, fixed Y range) is served from the cache.",
      "Counts do not depend on hardware; the time rows do, and other pages share this machine's CPU.",
    ],
    metrics: { neverShipped, neverFixed, sweepShipped, sweepFixed, leftShipped, leftFixed, lines: LINES },
  });
}
