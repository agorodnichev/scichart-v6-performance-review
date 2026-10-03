const META = {
  id: "018",
  title: "Filters over a FIFO data series keep every appended point and grow without bound",
  issue: "issues/018-filters-on-fifo-source-grow-unbounded.md",
  severity: "high",
  claim: "A filter appends to itself on every source append, but its constructor ignores the source's fifoCapacity, so a filter created with default options is a growable XyDataSeries: its native X/Y vectors keep the whole stream while the FIFO source stays at its capacity, and an auto-ranged X axis widens to the filter's whole history.",
  method: "<p>Two identical streams, side by side. Each source is an XyDataSeries with <code>fifoCapacity: 5,000</code>, pre-filled with 5,000 points, then fed 100 points per frame for 150 frames (15,000 more). Each source has an <code>XyMovingAverageFilter</code> (length 50) and an <code>XyScaleOffsetFilter</code>; both are plotted with the source, X axis <code>autoRange: Always</code>. Left: filters created with default options (as shipped). Right: the issue's app-side workaround, <code>fifoCapacity: source.fifoCapacity</code> in each filter's options.</p><p>The demo reads <code>count()</code> of every series and the X range of source and filters after the run, and computes the native bytes held by each filter's X and Y vectors (8 bytes per double).</p>",
};

async function demo(P) {
  const { NumericAxis, XyDataSeries, FastLineRenderableSeries, XyMovingAverageFilter, XyScaleOffsetFilter, EAutoRange } = P.SciChart;
  const CAP = 5000, BATCH = 100, FRAMES = 150, MA = 50;

  let t = 0;
  const batch = (n) => {
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++, t++) { xs[i] = t; ys[i] = Math.sin(t / 200) + 0.3 * Math.sin(t / 23); }
    return { xs, ys };
  };

  async function setup(div, withWorkaround) {
    const { sciChartSurface, wasmContext } = await P.createSurface(div);
    sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
    sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
    const source = new XyDataSeries(wasmContext, { fifoCapacity: CAP, isSorted: true, containsNaN: false });
    const extra = withWorkaround ? { fifoCapacity: source.fifoCapacity } : {};
    const ma = new XyMovingAverageFilter(source, { length: MA, ...extra });
    const offset = new XyScaleOffsetFilter(source, { scale: 1, offset: 1.5, ...extra });
    [[source, "#4e79a7"], [ma, "#e15759"], [offset, "#59a14f"]].forEach(([dataSeries, stroke]) =>
      sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries, stroke, strokeThickness: 1.5 })));
    return { sciChartSurface, wasmContext, source, ma, offset };
  }

  const A = await setup("chartA", false);
  const B = await setup("chartB", true);
  t = 0;
  const pre = batch(CAP);
  A.source.appendRange(pre.xs, pre.ys);
  B.source.appendRange(pre.xs, pre.ys);
  await P.sleep(300);
  const start = { a: [A.source.count(), A.ma.count(), A.offset.count()], b: [B.source.count(), B.ma.count(), B.offset.count()] };
  P.log(`after pre-fill: as shipped ${JSON.stringify(start.a)}, workaround ${JSON.stringify(start.b)} (source, MA, scale-offset)`);

  P.status("Streaming 100 points per frame into both FIFO sources…");
  const r = await P.frames(FRAMES, () => {
    const b = batch(BATCH);
    A.source.appendRange(b.xs, b.ys);
    B.source.appendRange(b.xs, b.ys);
  });
  await P.idleFrames(2);

  const appended = FRAMES * BATCH;
  const width = (ds) => { const x = ds.getXRange(); return x.max - x.min; };
  const read = (S, label) => {
    const res = {
      source: S.source.count(), ma: S.ma.count(), offset: S.offset.count(),
      maFifo: S.ma.fifoCapacity || 0, sourceWidth: width(S.source), maWidth: width(S.ma),
      axisWidth: S.sciChartSurface.xAxes.get(0).visibleRange.max - S.sciChartSurface.xAxes.get(0).visibleRange.min,
    };
    res.bytes = (res.ma + res.offset) * 16;
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  };
  const a = read(A, "as shipped"), b = read(B, "with fifoCapacity");
  const growth = (end, s0) => (end - s0) / appended;
  const gA = growth(a.ma, start.a[1]), gB = growth(b.ma, start.b[1]);

  const reproduced = a.source === CAP && a.ma >= CAP + 0.9 * appended && a.offset >= CAP + 0.9 * appended && b.ma <= CAP && b.offset <= CAP;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `After ${appended.toLocaleString("en-US")} streamed points the FIFO source holds ${a.source.toLocaleString("en-US")} points, but its moving-average filter holds ${a.ma.toLocaleString("en-US")} and its scale-offset filter ${a.offset.toLocaleString("en-US")}: they gain one point per appended point. With fifoCapacity on the filters: ${b.ma.toLocaleString("en-US")} and ${b.offset.toLocaleString("en-US")}.`
      : `Expected the default filters to grow by about one point per appended point; MA filter: ${a.ma} points, source: ${a.source}, workaround: ${b.ma}.`,
    columns: ["As shipped", "fifoCapacity on filters"],
    rows: [
      ["Points appended to the source during the run", appended, appended],
      ["Source count() (fifoCapacity " + CAP.toLocaleString("en-US") + ")", a.source, b.source],
      ["XyMovingAverageFilter count()", a.ma, b.ma],
      ["XyScaleOffsetFilter count()", a.offset, b.offset],
      ["Filter growth per appended point (MA filter)", gA, gB],
      ["Native X+Y bytes held by the two filters", a.bytes, b.bytes],
      ["X range width: source", a.sourceWidth, b.sourceWidth],
      ["X range width: MA filter", a.maWidth, b.maWidth],
      ["X axis visible range width (autoRange Always)", a.axisWidth, b.axisWidth],
      ["Projected filter growth at 1,000 points/s, MiB of X+Y per hour per filter", gA * 3600000 * 16 / 1048576, gB * 3600000 * 16 / 1048576],
      ["Frame interval p95, ms (hardware-dependent)", r.frameP95, null],
    ],
    notes: [
      "Both streams run in the same frames, so the frame-time row covers both charts. The left chart's X axis spans the filters' whole history while its source line covers only the last 5,000 points.",
      "Counts and bytes do not depend on hardware. FIFO sources never raise Remove notifications, so nothing ever shrinks a non-FIFO filter.",
    ],
    metrics: { start, shipped: a, workaround: b, appended, cap: CAP },
  });
}
