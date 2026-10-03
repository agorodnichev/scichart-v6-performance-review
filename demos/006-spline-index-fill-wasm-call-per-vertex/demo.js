const META = {
  id: "006",
  title: "Spline series write each interpolated vertex's source index with a separate wasm call",
  issue: "issues/006-spline-index-fill-one-wasm-call-per-vertex.md",
  severity: "high",
  claim: "SplineRenderDataTransform.populateSourceIndexes() fills the output index vector with indexes.set(k, …): one embind call per interpolated vertex (input points x 11 by default), every time the transform reruns, which is on every pan or zoom frame that moves the visible index range.",
  method: "<p>A SplineLineRenderableSeries (interpolationPoints 10) whose X axis is panned for 30 frames (a new visibleRange each frame), in two set-ups: 1,000 points with default settings (too few to be resampled), and 10,000 points with resampling off. The demo counts SplineRenderDataTransform.populateSourceIndexes runs per frame, the interpolated vertices each run writes, and SCRTDoubleVector.set calls made inside it (embind calls into wasm). The time per run comes from a separate 30-frame pass without the per-call counter, so the counter's overhead is not in it.</p><p>A/B: populateSourceIndexes is replaced by the issue's fix, which writes the same values through a Float64Array view of the vector (vectorToArrayViewF64, taken after resizeFast). The demo checks once that both versions write identical indexes. A further pass pans with the Y axis on autoRange = Always to test the issue's hypothesis that the transform then runs twice per frame, and a last pass checks what happens with 10,000 points and default resampling.</p>",
};

async function demo(P) {
  const { NumericAxis, NumberRange, XyDataSeries, SplineLineRenderableSeries, SplineRenderDataTransform, EResamplingMode, EAutoRange, vectorToArrayViewF64 } = P.SciChart;
  const FRAMES = 30;

  const { sciChartSurface, wasmContext: wasm } = await P.createSurface("chart");
  const xAxis = new NumericAxis(wasm);
  const yAxis = new NumericAxis(wasm, { visibleRange: new NumberRange(-1.5, 1.5) });
  sciChartSurface.xAxes.add(xAxis);
  sciChartSurface.yAxes.add(yAxis);
  const spline = new SplineLineRenderableSeries(wasm, { stroke: "#4e79a7", strokeThickness: 2, interpolationPoints: 10 });
  let n = 0;
  function useData(points) {
    n = points;
    const xs = Array.from({ length: n }, (_, i) => i);
    const k = n / 10000;
    const previous = spline.dataSeries;
    spline.dataSeries = new XyDataSeries(wasm, { xValues: xs, yValues: xs.map((x) => Math.sin(x / (300 * k)) + 0.3 * Math.sin(x / (23 * k))), isSorted: true, containsNaN: false });
    if (previous) previous.delete();
    xAxis.visibleRange = new NumberRange(0, n * 0.8);
  }
  useData(1000);
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
  P.hookMethod(proto, "runTransformInternal", {
    name: "transform runs",
    onCall: (args, self, ret) => { if (ret !== self.pointSeries) P.count("transform runs that fell back to the input"); },
  });
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
      const k = (i % 40) / 40, off = n * 0.2 * (k < 0.5 ? k * 2 : 2 - k * 2);
      xAxis.visibleRange = new NumberRange(off, off + n * 0.8);
    });
    if (unhook) unhook();
    const runs = r.total("populateSourceIndexes runs");
    const rpd = spline.getCurrentRenderPassData();
    const res = {
      transformRunsPerFrame: r.perFrame("transform runs"),
      fallbacksPerFrame: r.perFrame("transform runs that fell back to the input"),
      runsPerFrame: runs / FRAMES,
      verticesPerRun: runs ? r.total("interpolated vertices written") / runs : 0,
      setPerRun: runs ? r.total("SCRTDoubleVector.set inside populateSourceIndexes") / runs : 0,
      setPerFrameAll: r.perFrame("SCRTDoubleVector.set (whole page)"),
      msPerRun: runs ? populateMs / runs : 0,
      resampled: !!(rpd && rpd.pointSeries && rpd.pointSeries.resampled),
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

  P.status("Panning a 1,000-point spline, default settings…");
  const small = await config("1,000 points, default settings");

  P.status("Panning a 10,000-point spline, resampling off…");
  useData(10000);
  spline.resamplingMode = EResamplingMode.None;
  await P.idleFrames(3);
  const large = await config("10,000 points, resampling off");

  // Same indexes from both versions? Run each on the live transform state and compare.
  const t = spline.renderDataTransform;
  shippedPopulate.call(t);
  const a = Array.from(vectorToArrayViewF64(t.pointSeries.indexes, wasm));
  populateWithView.call(t);
  const b = Array.from(vectorToArrayViewF64(t.pointSeries.indexes, wasm));
  const identical = a.length > 0 && a.length === b.length && a.every((v, i) => v === b[i]);

  P.status("Panning with Y autoRange = Always…");
  yAxis.autoRange = EAutoRange.Always;
  const autoY = await pan("10,000 points, resampling off, Y autoRange Always", false);
  yAxis.autoRange = EAutoRange.Never;
  yAxis.visibleRange = new NumberRange(-1.5, 1.5);

  P.status("10,000 points with default resampling…");
  spline.warnOnSplineFailure = false; // the library would otherwise log an error on every frame of this pass
  spline.resamplingMode = EResamplingMode.Auto;
  await P.idleFrames(3);
  const resampled = await pan("10,000 points, default resampling", false);
  proto.populateSourceIndexes = shippedPopulate;

  const ss = small.shipped, sf = small.fixed, ls = large.shipped, lf = large.fixed;
  const perVertex = (x) => x.runsPerFrame >= 0.8 && x.verticesPerRun > 0 && x.setPerRun >= 0.99 * x.verticesPerRun;
  const reproduced = perVertex(ss) && perVertex(ls) && sf.setPerRun === 0 && lf.setPerRun === 0 && identical;
  const fmt = (v) => Math.round(v).toLocaleString("en-US");
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each pan frame reruns the spline transform, which makes one wasm set() call per interpolated vertex: ${fmt(ss.setPerRun)} calls per run for 1,000 points, ${fmt(ls.setPerRun)} for 10,000 points (${ls.msPerRun.toFixed(1)} ms per run). Writing through a typed-array view: 0 calls (${lf.msPerRun.toFixed(2)} ms), same values.`
      : `Expected one SCRTDoubleVector.set call per interpolated vertex per run; measured ${fmt(ls.setPerRun)} calls for ${fmt(ls.verticesPerRun)} vertices (fix: ${fmt(lf.setPerRun)}, identical output: ${identical}).`,
    columns: ["1,000 pts, as shipped", "1,000 pts, fix", "10,000 pts, as shipped", "10,000 pts, fix"],
    rows: [
      ["Resampled input", ss.resampled ? "yes" : "no", sf.resampled ? "yes" : "no", ls.resampled ? "yes" : "no (off)", lf.resampled ? "yes" : "no (off)"],
      ["Transform runs (populateSourceIndexes) per pan frame", ss.runsPerFrame, sf.runsPerFrame, ls.runsPerFrame, lf.runsPerFrame],
      ["Interpolated vertices per run", ss.verticesPerRun, sf.verticesPerRun, ls.verticesPerRun, lf.verticesPerRun],
      ["SCRTDoubleVector.set calls per run (inside populateSourceIndexes)", ss.setPerRun, sf.setPerRun, ls.setPerRun, lf.setPerRun],
      ["SCRTDoubleVector.set calls per frame (whole page)", ss.setPerFrameAll, sf.setPerFrameAll, ls.setPerFrameAll, lf.setPerFrameAll],
      ["Time in populateSourceIndexes per run, ms", ss.msPerRun, sf.msPerRun, ls.msPerRun, lf.msPerRun],
      ["Frame interval p95, ms", ss.p95, sf.p95, ls.p95, lf.p95],
    ],
    notes: [
      `Identical indexes from both versions: ${identical ? "yes" : "NO"} (${a.length.toLocaleString("en-US")} values compared). Counts do not depend on hardware; times do.`,
      `With Y autoRange = Always the transform ran ${autoY.transformRunsPerFrame.toFixed(2)} times per pan frame (populateSourceIndexes ${autoY.runsPerFrame.toFixed(2)}); the issue's two-runs-per-frame hypothesis ${autoY.runsPerFrame >= 1.5 ? "holds here" : "did not show here"}.`,
      `10,000 points with default resampling: the transform ran ${resampled.transformRunsPerFrame.toFixed(2)} times per frame and ${resampled.fallbacksPerFrame.toFixed(2)} of them fell back to the resampled input (the cubic spline returned NaN, "X data may contain duplicates"), so populateSourceIndexes ran ${resampled.runsPerFrame.toFixed(2)} times per frame. In that set-up no spline is drawn and, unless warnOnSplineFailure = false, the library logs an error on every frame. The per-vertex cost applies when the input is not resampled: small series, or resampling turned off as here.`,
    ],
    metrics: { frames: FRAMES, small, large, autoY, resampled, identical },
  });
}
