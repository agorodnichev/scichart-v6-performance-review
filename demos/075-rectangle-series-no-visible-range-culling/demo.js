const META = {
  id: "075",
  title: "Rectangle series process and upload every rectangle on every frame, however far you zoom in",
  issue: "issues/075-rectangle-series-no-visible-range-culling.md",
  severity: "medium",
  claim: "FastRectangleRenderableSeries.getIndicesRange always returns the full index range, so each render hands all N rectangles to the native DrawPoints call and runs data labels and palettes over all of them, even when only a small fraction is on screen.",
  method: "<p>Left: a FastRectangleRenderableSeries with sorted X (columnXMode Mid, dataPointWidth 0.8 in data units), zoomed to 1% of the data (2,000 rectangles visible) and panned one step per frame for 30 frames, first with 200,000 and then with 400,000 rectangles. Counted per frame: the index range getIndicesRange returns, the count passed to the native SCRTRectangleSeriesDrawingProvider.DrawPoints, and GPU buffer uploads on the page (gl.bufferData/bufferSubData or GPUQueue.writeBuffer bytes); timed: the native DrawPoints call. Right: 20,000 rectangles with data labels, zoomed to 1%; counted: data-label getText calls per frame.</p><p>A/B: FastRectangleRenderableSeries.prototype.getIndicesRange is replaced with the issue's fix (binary search on the sorted X values with a margin of half a rectangle width, NumberUtil.FindIndex) and the same scenarios run again. The original method is restored.</p>",
};

async function demo(P) {
  const { NumericAxis, FastRectangleRenderableSeries, RectangleSeriesDataLabelProvider, XyDataSeries, EAutoRange, NumberRange, EColumnMode, EDataPointWidthMode } = P.SciChart;
  const N1 = 200000, N2 = 400000, N_LABELS = 20000, FRAMES = 30, LABEL_FRAMES = 15;

  function makeData(wasm, n) {
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++) { xs[i] = i; ys[i] = 1 + Math.abs(Math.sin(i / 60)) + 0.4 * Math.abs(Math.sin(i / 7)); }
    return new XyDataSeries(wasm, { xValues: xs, yValues: ys, isSorted: true, containsNaN: false });
  }
  const rectOptions = { fill: "#4e79a7", stroke: "#2b4c7e", strokeThickness: 1, columnXMode: EColumnMode.Mid, dataPointWidth: 0.8, dataPointWidthMode: EDataPointWidthMode.Range };

  const left = await P.createSurface("chart");
  const wasm = left.wasmContext;
  const xAxis = new NumericAxis(wasm);
  left.sciChartSurface.xAxes.add(xAxis);
  left.sciChartSurface.yAxes.add(new NumericAxis(wasm, { autoRange: EAutoRange.Always }));
  const rects = new FastRectangleRenderableSeries(wasm, { dataSeries: makeData(wasm, N1), ...rectOptions });
  left.sciChartSurface.renderableSeries.add(rects);

  const right = await P.createSurface("chart2");
  const xAxis2 = new NumericAxis(right.wasmContext);
  right.sciChartSurface.xAxes.add(xAxis2);
  right.sciChartSurface.yAxes.add(new NumericAxis(right.wasmContext, { autoRange: EAutoRange.Always }));
  const labelled = new FastRectangleRenderableSeries(right.wasmContext, {
    dataSeries: makeData(right.wasmContext, N_LABELS), ...rectOptions, fill: "#59a14f", stroke: "#2f6b2a",
    dataLabels: { style: { fontFamily: "Arial", fontSize: 10 }, color: "#ffffff", precision: 1 },
  });
  right.sciChartSurface.renderableSeries.add(labelled);
  const window2 = N_LABELS / 100;
  xAxis2.visibleRange = new NumberRange(N_LABELS / 2, N_LABELS / 2 + window2);
  await P.sleep(800);

  // ---- counters
  P.watch.gpu();
  P.hookMethod(wasm.SCRTRectangleSeriesDrawingProvider.prototype, "DrawPoints", { name: "DrawPoints", time: true, bytes: (a) => a[0].count });
  const proto = FastRectangleRenderableSeries.prototype;
  const shippedRange = proto.getIndicesRange;
  let rangeImpl = shippedRange;
  proto.getIndicesRange = function () {
    const r = rangeImpl.apply(this, arguments);
    P.count("getIndicesRange", 1, r.max - r.min + 1);
    return r;
  };
  P.hookMethod(RectangleSeriesDataLabelProvider.prototype, "getText", { name: "label getText" });
  P.hookMethod(RectangleSeriesDataLabelProvider.prototype, "generateDataLabels", { name: "generateDataLabels", time: true });

  // ---- the issue's fix: binary-search the sorted X column, widened by the largest rectangle extent
  const NU = wasm.NumberUtil, SM = wasm.SCRTFindIndexSearchMode;
  function culledRange(xRange, isCategoryData) {
    const ds = this.dataSeries, last = ds.count() - 1;
    if (isCategoryData || !ds.dataDistributionCalculator.isSortedAscending || ds.fifoCapacity > 0 || last < 1) return shippedRange.call(this, xRange, isCategoryData);
    let leftExtent, rightExtent; // rectangle i spans [x_i - leftExtent, x_i + rightExtent]
    if (this.dataPointWidthMode !== EDataPointWidthMode.Range) return shippedRange.call(this, xRange, isCategoryData); // only the mode this demo uses
    if (this.columnXMode === EColumnMode.Mid) { leftExtent = rightExtent = this.dataPointWidth / 2; }
    else if (this.columnXMode === EColumnMode.Start) { leftExtent = 0; rightExtent = this.dataPointWidth; }
    else return shippedRange.call(this, xRange, isCategoryData);
    const xv = ds.getNativeXValues();
    const i0 = NU.FindIndex(xv, xRange.min - rightExtent, SM.RoundDown, true);
    const i1 = NU.FindIndex(xv, xRange.max + leftExtent, SM.RoundUp, true);
    return new NumberRange(Math.max(0, i0 - 1), Math.min(last, i1 + 1));
  }

  async function panRun(label, n) {
    const win = n / 100 > 2000 ? 2000 : n / 100; // the same 2,000-rectangle window at both sizes
    const base = n / 2;
    xAxis.visibleRange = new NumberRange(base, base + win);
    await P.idleFrames(4);
    const r = await P.frames(FRAMES, (i) => { const x0 = base + (i % 10) * 25; xAxis.visibleRange = new NumberRange(x0, x0 + win); });
    const draws = Math.max(1, r.total("DrawPoints"));
    const res = {
      n, visible: win,
      rangeLen: r.total("getIndicesRange", "bytes") / Math.max(1, r.total("getIndicesRange")),
      drawCount: r.total("DrawPoints", "bytes") / draws,
      drawsPerFrame: r.perFrame("DrawPoints"),
      uploadKB: (r.perFrame("gl.bufferData", "bytes") + r.perFrame("gl.bufferSubData", "bytes") + r.perFrame("gpu.writeBuffer", "bytes")) / 1024,
      drawMs: r.total("DrawPoints", "t") / draws,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }
  async function labelRun(label) {
    const base = N_LABELS / 2;
    const r = await P.frames(LABEL_FRAMES, (i) => { const x0 = base + (i % 5) * 4; xAxis2.visibleRange = new NumberRange(x0, x0 + window2); });
    const passes = Math.max(1, r.total("generateDataLabels"));
    const res = { getText: r.total("label getText") / passes, labelMs: r.total("generateDataLabels", "t") / passes, passes, p95: r.frameP95 };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Panning a zoomed-in window, 200,000 rectangles, as shipped…");
  const s1 = await panRun("as shipped, 200,000 rectangles", N1);
  P.status("Same window, 20,000 labelled rectangles, as shipped…");
  const sLab = await labelRun("as shipped, 20,000 labelled rectangles");
  rangeImpl = culledRange;
  P.status("200,000 rectangles, with visible-range culling…");
  const f1 = await panRun("with fix, 200,000 rectangles", N1);
  const fLab = await labelRun("with fix, 20,000 labelled rectangles");
  P.status("400,000 rectangles (off-screen data doubled)…");
  const old = rects.dataSeries;
  rects.dataSeries = makeData(wasm, N2);
  old.delete();
  const f2 = await panRun("with fix, 400,000 rectangles", N2);
  rangeImpl = shippedRange;
  const s2 = await panRun("as shipped, 400,000 rectangles", N2);
  proto.getIndicesRange = shippedRange;

  const reproduced = s1.drawCount >= 0.9 * N1 && s2.drawCount >= 0.9 * N2 && f1.drawCount <= 0.05 * N1 && f2.drawCount <= 0.05 * N2;
  const fmt = (v) => Math.round(v).toLocaleString("en-US");
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `With ${fmt(s1.visible)} rectangles on screen, every frame hands ${fmt(s1.drawCount)} rectangles to the native draw and uploads ${fmt(s1.uploadKB)} KB to the GPU; doubling the off-screen data doubles both (${fmt(s2.drawCount)}, ${fmt(s2.uploadKB)} KB). With culling: ${fmt(f2.drawCount)} rectangles and ${fmt(f2.uploadKB)} KB. Data labels: ${fmt(sLab.getText)} -> ${fmt(fLab.getText)} getText calls per draw.`
      : `Expected all N rectangles per frame as shipped; measured ${fmt(s1.drawCount)} of ${fmt(N1)} and ${fmt(s2.drawCount)} of ${fmt(N2)} (fix: ${fmt(f1.drawCount)}, ${fmt(f2.drawCount)}).`,
    columns: ["As shipped", "With culling fix"],
    rows: [
      ["200,000 rectangles, 2,000 visible: index range length", s1.rangeLen, f1.rangeLen],
      ["... rectangles passed to native DrawPoints per draw", s1.drawCount, f1.drawCount],
      ["... GPU buffer uploads per frame, KB (whole page)", s1.uploadKB, f1.uploadKB],
      ["... time in native DrawPoints per draw, ms", s1.drawMs, f1.drawMs],
      ["400,000 rectangles, same 2,000 visible: rectangles passed to DrawPoints", s2.drawCount, f2.drawCount],
      ["... GPU buffer uploads per frame, KB (whole page)", s2.uploadKB, f2.uploadKB],
      ["... time in native DrawPoints per draw, ms", s2.drawMs, f2.drawMs],
      ["20,000 labelled rectangles, 200 visible: data-label getText calls per draw", sLab.getText, fLab.getText],
      ["... time in generateDataLabels per draw, ms", sLab.labelMs, fLab.labelMs],
      ["Frame interval p95, ms (400,000 rectangles)", s2.p95, f2.p95],
    ],
    notes: [
      "The upload bytes answer the issue's open question (evidence H): the engine does not skip off-screen rectangles before the GPU; the bytes it writes each frame follow the total count, not the visible count. Counts and bytes do not depend on hardware; times do.",
      "The fix keeps the full range for category axes, unsorted X and FIFO series, as the issue proposes. It changes which rectangles data labels are generated for, so labels suppressed by pointCountThreshold can appear when zoomed in.",
    ],
    metrics: { s1, s2, f1, f2, sLab, fLab, renderer: P.renderer() },
  });
}
