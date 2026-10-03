const META = {
  id: "006",
  title: "Spline series write each interpolated vertex's source index with a separate wasm call",
  issue: "issues/006-spline-index-fill-one-wasm-call-per-vertex.md",
  severity: "high",
  claim: "SplineRenderDataTransform.populateSourceIndexes() fills the output index vector with indexes.set(k, …): one embind call per interpolated vertex (input points x 11 by default), every time the transform reruns, which is on every pan or zoom frame that moves the visible index range.",
  method: "<p>A SplineLineRenderableSeries with 10,000 points (interpolationPoints 10). The X axis is panned for 30 frames (a new visibleRange each frame), first with the default resampling, then with resampling off. The demo counts SplineRenderDataTransform.populateSourceIndexes runs per frame, the interpolated vertices each run writes, and SCRTDoubleVector.set calls made inside it (embind calls into wasm). The time per run comes from a separate 30-frame pass without the per-call counter, so the counter's overhead is not in it.</p><p>A/B: populateSourceIndexes is replaced by the issue's fix, which writes the same values through a Float64Array view of the vector (vectorToArrayViewF64, taken after resizeFast). The demo checks once that both versions write identical indexes. A last pass pans with the Y axis on autoRange = Always to test the issue's hypothesis that the transform then runs twice per frame.</p>",
};

async function demo(P) {
  const { NumericAxis, NumberRange, XyDataSeries, SplineLineRenderableSeries, SplineRenderDataTransform, EResamplingMode, EAutoRange, vectorToArrayViewF64 } = P.SciChart;
  const N = 10000, FRAMES = 30;

  const { sciChartSurface, wasmContext: wasm } = await P.createSurface("chart");
  const xAxis = new NumericAxis(wasm, { visibleRange: new NumberRange(0, N * 0.8) });
  const yAxis = new NumericAxis(wasm, { visibleRange: new NumberRange(-1.5, 1.5) });
  sciChartSurface.xAxes.add(xAxis);
  sciChartSurface.yAxes.add(yAxis);
  const xs = Array.from({ length: N }, (_, i) => i);
  const spline = new SplineLineRenderableSeries(wasm, {
    dataSeries: new XyDataSeries(wasm, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 300) + 0.3 * Math.sin(x / 23)), isSorted: true, containsNaN: false }),
    stroke: "#4e79a7", strokeThickness: 2, interpolationPoints: 10,
  });
  sciChartSurface.renderableSeries.add(spline);
  await P.sleep(600);

  // Wrap populateSourceIndexes: runs, vertices written, time; `impl` is what the A/B swaps.
  const proto = SplineRenderDataTransform.prototype;
  const shippedPopulate = proto.populateSourceIndexes;
  let impl = shippedPopulate, inPopulate = false, populateMs = 0;
  proto.populateSourceIndexes = function () {
    inPopulate = true;
    const t0 = P.now();
    try { return impl.apply(this, arguments); } finally {
      populateMs += P.now() - t0;
      inPopulate = false;
      P.count("populateSourceIndexes runs");
      P.count("interpolated vertices written", this.pointSeries.indexes.size());
    }
  };
  // The issue's fix: same values, written through a typed-array view instead of one set() call each.
  function populateWithView() {
    const size = this.pointSeries.xValues.size();
    const intPoints2 = this.interpolationPoints + 1;
    const indexes = this.pointSeries.indexes;
    indexes.resizeFast(size);
    if (size === 0) return;
    const view = vectorToArrayViewF64(indexes, this.wasmContext); // after resizeFast: a heap grow detaches older views
    for (let k = 0; k < size; k++) view[k] = Math.floor(k / intPoints2);
  }

  // Embind calls into SCRTDoubleVector.set, attributed to populateSourceIndexes. Installed only for the counting passes.
  const hookSet = () => P.hookMethod(wasm.SCRTDoubleVector.prototype, "set", {
    name: "SCRTDoubleVector.set (whole page)",
    onCall: () => { if (inPopulate) P.count("SCRTDoubleVector.set inside populateSourceIndexes"); },
  });

  async function pan(label, withCounter) {
    const unhook = withCounter ? hookSet() : null;
    await P.idleFrames(3);
    populateMs = 0;
    const r = await P.frames(FRAMES, (i) => {
      const k = (i % 40) / 40, off = N * 0.2 * (k < 0.5 ? k * 2 : 2 - k * 2);
      xAxis.visibleRange = new NumberRange(off, off + N * 0.8);
    });
    if (unhook) unhook();
    const runs = r.total("populateSourceIndexes runs");
    const res = {
      runsPerFrame: runs / FRAMES,
      verticesPerRun: runs ? r.total("interpolated vertices written") / runs : 0,
      setPerRun: runs ? r.total("SCRTDoubleVector.set inside populateSourceIndexes") / runs : 0,
      setPerFrameAll: r.perFrame("SCRTDoubleVector.set (whole page)"),
      msPerRun: runs ? populateMs / runs : 0,
      p95: r.frameP95,
    };
    P.log(`${label}${withCounter ? " (counting)" : " (timing)"}: ${JSON.stringify(res)}`);
    return res;
  }
  async function config(label) {
    impl = shippedPopulate;
    const sc = await pan(label + ", as shipped", true), st = await pan(label + ", as shipped", false);
    impl = populateWithView;
    const fc = await pan(label + ", with fix", true), ft = await pan(label + ", with fix", false);
    impl = shippedPopulate;
    return { shipped: { ...sc, msPerRun: st.msPerRun, p95: st.p95 }, fixed: { ...fc, msPerRun: ft.msPerRun, p95: ft.p95 } };
  }

  P.status("Panning the spline, default resampling…");
  const resampled = await config("default resampling");

  P.status("Panning the spline, resampling off…");
  spline.resamplingMode = EResamplingMode.None;
  const full = await config("resampling off");

  // Same indexes from both versions? Run each on the live transform state and compare.
  const t = spline.renderDataTransform;
  shippedPopulate.call(t);
  const a = Array.from(vectorToArrayViewF64(t.pointSeries.indexes, wasm));
  populateWithView.call(t);
  const b = Array.from(vectorToArrayViewF64(t.pointSeries.indexes, wasm));
  const identical = a.length > 0 && a.length === b.length && a.every((v, i) => v === b[i]);

  P.status("Panning with Y autoRange = Always…");
  spline.resamplingMode = EResamplingMode.Auto;
  yAxis.autoRange = EAutoRange.Always;
  const autoY = await pan("default resampling, Y autoRange Always", false);
  yAxis.autoRange = EAutoRange.Once;
  proto.populateSourceIndexes = shippedPopulate;

  const s = full.shipped, f = full.fixed, rs = resampled.shipped, rf = resampled.fixed;
  const perVertex = s.runsPerFrame >= 0.8 && s.verticesPerRun > 0 && s.setPerRun >= 0.99 * s.verticesPerRun &&
    rs.runsPerFrame >= 0.8 && rs.setPerRun >= 0.99 * rs.verticesPerRun;
  const fixRemoves = f.setPerRun === 0 && rf.setPerRun === 0 && identical;
  const reproduced = perVertex && fixRemoves;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each pan frame reruns the spline transform, which makes one wasm set() call per interpolated vertex: ${Math.round(rs.setPerRun).toLocaleString("en-US")} per run with default resampling, ${Math.round(s.setPerRun).toLocaleString("en-US")} with resampling off (10,000 points). Writing through a typed-array view: 0, same values.`
      : `Expected one SCRTDoubleVector.set call per interpolated vertex per run; measured ${s.setPerRun.toFixed(0)} calls for ${s.verticesPerRun.toFixed(0)} vertices (fix: ${f.setPerRun.toFixed(0)}, identical output: ${identical}).`,
    columns: ["Resampled, as shipped", "Resampled, fix", "Resampling off, as shipped", "Resampling off, fix"],
    rows: [
      ["Transform runs (populateSourceIndexes) per pan frame", rs.runsPerFrame, rf.runsPerFrame, s.runsPerFrame, f.runsPerFrame],
      ["Interpolated vertices per run", rs.verticesPerRun, rf.verticesPerRun, s.verticesPerRun, f.verticesPerRun],
      ["SCRTDoubleVector.set calls per run (inside populateSourceIndexes)", rs.setPerRun, rf.setPerRun, s.setPerRun, f.setPerRun],
      ["SCRTDoubleVector.set calls per frame (whole page)", rs.setPerFrameAll, rf.setPerFrameAll, s.setPerFrameAll, f.setPerFrameAll],
      ["Time in populateSourceIndexes per run, ms", rs.msPerRun, rf.msPerRun, s.msPerRun, f.msPerRun],
      ["Frame interval p95, ms", rs.p95, rf.p95, s.p95, f.p95],
    ],
    notes: [
      `Identical indexes from both versions: ${identical ? "yes" : "NO"} (${a.length.toLocaleString("en-US")} values compared).`,
      `With Y autoRange = Always the transform ran ${autoY.runsPerFrame.toFixed(2)} times per pan frame (the issue marks two runs per frame as a hypothesis; ${autoY.runsPerFrame >= 1.5 ? "it holds here" : "it did not happen here"}).`,
      "Counts do not depend on hardware; times do. With resampling, the transform input is the resampled set (about two points per pixel), so the call count scales with the chart width rather than the data size.",
    ],
    metrics: { N, frames: FRAMES, resampled, full, autoY, identical },
  });
}
