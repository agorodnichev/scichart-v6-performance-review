const META = {
  id: "032",
  title: "Candlestick Y autorange reads high and low with two embind get(i) calls per candle per frame",
  issue: "issues/032-ohlc-yrange-per-point-embind-get-loop.md",
  severity: "medium",
  claim: "With the price axis on EAutoRange.Always, every render computes the OHLC Y range in getOHLCYRange, which loops over the candles and calls highValues.get(i) and lowValues.get(i): two JS-to-wasm calls per candle, with no memo. The XY, band and HLC paths use one native NumberUtil.MinMaxWithIndex call per vector instead.",
  method: "<p>A FastCandlestickRenderableSeries with 100,000 candles and yAxis.autoRange = EAutoRange.Always is panned over a 20,000-candle window, one step per frame for 30 frames, first with default resampling and then with resamplingMode = None. Counted per frame: SCRTDoubleVector.get calls made inside the series' getYRange, and on the whole page. getYRange is timed in a second pass with the per-call hook removed.</p><p>A/B: BaseOhlcRenderableSeries.getYRange and OhlcDataSeries.getWindowedYRange are replaced with the issue's fix (two NumberUtil.MinMaxWithIndex calls over the low and high vectors), the same pans run again, and both versions are checked against each other: Y ranges for 20 windows computed directly, and the autoranged Y axis at the end of each pan. The originals are restored.</p>",
};

async function demo(P) {
  const { NumericAxis, FastCandlestickRenderableSeries, OhlcDataSeries, EAutoRange, NumberRange, EResamplingMode, ESearchMode, EYRangeMode, EDataSeriesValueType, deleteSafe } = P.SciChart;
  const N = 100000, W = 20000, X0 = 20000, FRAMES = 30;

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  const xAxis = new NumericAxis(wasmContext);
  const yAxis = new NumericAxis(wasmContext, { autoRange: EAutoRange.Always });
  sciChartSurface.xAxes.add(xAxis);
  sciChartSurface.yAxes.add(yAxis);
  const xs = new Float64Array(N), o = new Float64Array(N), h = new Float64Array(N), l = new Float64Array(N), c = new Float64Array(N);
  let seed = 7, price = 100;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < N; i++) {
    xs[i] = i; o[i] = price;
    const close = Math.max(5, price + (rnd() - 0.5) * 2);
    c[i] = close; h[i] = Math.max(price, close) + rnd(); l[i] = Math.min(price, close) - rnd();
    price = close;
  }
  const ds = new OhlcDataSeries(wasmContext, { xValues: xs, openValues: o, highValues: h, lowValues: l, closeValues: c, isSorted: true, containsNaN: false });
  const rs = new FastCandlestickRenderableSeries(wasmContext, { dataSeries: ds, strokeThickness: 1, brushUp: "#59a14f", brushDown: "#e15759", strokeUp: "#59a14f", strokeDown: "#e15759" });
  sciChartSurface.renderableSeries.add(rs);
  xAxis.visibleRange = new NumberRange(X0, X0 + W);
  await P.sleep(800);

  // ---- instrumentation
  const ohlcProto = Object.getPrototypeOf(FastCandlestickRenderableSeries.prototype); // BaseOhlcRenderableSeries
  const shippedGetYRange = ohlcProto.getYRange;
  const shippedWindowed = OhlcDataSeries.prototype.getWindowedYRange;
  let getYRangeImpl = shippedGetYRange, inYRange = 0, yRangeMs = 0;
  ohlcProto.getYRange = function () {
    inYRange++;
    const t0 = P.now();
    try { return getYRangeImpl.apply(this, arguments); } finally { inYRange--; yRangeMs += P.now() - t0; P.count("getYRange calls"); }
  };

  // ---- the issue's fix: two native scans instead of two embind get() calls per candle
  const NU = wasmContext.NumberUtil;
  function nativeOhlcRange(indicesRange, highValues, lowValues) {
    const iMin = Math.max(indicesRange.min, 0);
    const iMax = Math.min(indicesRange.max, highValues.size() - 1);
    if (iMax < iMin) return undefined;
    const start = Math.floor(iMin), count = Math.ceil(iMax) - start + 1;
    let lo, hi;
    try {
      lo = NU.MinMaxWithIndex(lowValues, start, count, true);
      hi = NU.MinMaxWithIndex(highValues, start, count, true);
      return new NumberRange(lo.minD, hi.maxD);
    } finally { deleteSafe(lo); deleteSafe(hi); }
  }
  function fixedGetYRange(xVisibleRange, isXCategoryAxis = false) {
    if (this.isRunningDataAnimation || (this.renderDataTransform && this.renderDataTransform.useForYRange)) return shippedGetYRange.apply(this, arguments);
    const ps = this.getResampledPointSeries(isXCategoryAxis);
    if (ps) return nativeOhlcRange(new NumberRange(0, ps.count - 1), ps.highValues, ps.lowValues);
    return this.dataSeries.getWindowedYRange(xVisibleRange, true, isXCategoryAxis, EDataSeriesValueType.Default, this.yRangeMode);
  }
  function fixedWindowed(xRange, getPositiveRange, isXCategoryAxis = false, valueType = EDataSeriesValueType.Default, yRangeMode = EYRangeMode.Visible) {
    if (this.count() === 1) return shippedWindowed.apply(this, arguments);
    const { highValues, lowValues } = this.getOHLCValues(valueType);
    const visible = yRangeMode === EYRangeMode.Visible;
    const indicesRange = isXCategoryAxis ? xRange : this.getIndicesRange(xRange, false, visible ? ESearchMode.RoundUp : ESearchMode.RoundDown, visible ? ESearchMode.RoundDown : ESearchMode.RoundUp);
    return nativeOhlcRange(indicesRange, highValues, lowValues);
  }

  async function pan(label, withCounter) {
    const undo = withCounter ? P.hookMethod(wasmContext.SCRTDoubleVector.prototype, "get", {
      name: "get (all)", onCall: () => { if (inYRange) P.count("get inside getYRange"); },
    }) : null;
    xAxis.visibleRange = new NumberRange(X0, X0 + W);
    await P.idleFrames(3);
    yRangeMs = 0;
    const r = await P.frames(FRAMES, (i) => { const x = X0 + (i + 1) * 101; xAxis.visibleRange = new NumberRange(x, x + W); });
    if (undo) undo();
    const calls = Math.max(1, r.total("getYRange calls"));
    const res = {
      getsInYRange: r.perFrame("get inside getYRange"),
      getsAll: r.perFrame("get (all)"),
      yRangeCallsPerFrame: r.perFrame("getYRange calls"),
      msPerFrame: yRangeMs / FRAMES,
      msPerCall: yRangeMs / calls,
      p95: r.frameP95,
      yRange: [yAxis.visibleRange.min, yAxis.visibleRange.max],
    };
    P.log(`${label}${withCounter ? "" : " (timing pass)"}: ${JSON.stringify(res)}`);
    return res;
  }
  async function scenario(label) {
    const count = await pan(label, true);
    const time = await pan(label, false);
    return { ...count, msPerFrame: time.msPerFrame, msPerCall: time.msPerCall, p95: time.p95 };
  }
  function useFix(on) {
    getYRangeImpl = on ? fixedGetYRange : shippedGetYRange;
    OhlcDataSeries.prototype.getWindowedYRange = on ? fixedWindowed : shippedWindowed;
  }

  P.status("Panning with default resampling, as shipped…");
  const resShipped = await scenario("default resampling, as shipped");
  useFix(true);
  P.status("Panning with default resampling, with the fix…");
  const resFixed = await scenario("default resampling, with fix");
  useFix(false);
  rs.resamplingMode = EResamplingMode.None;
  await P.idleFrames(3);
  P.status("Panning with resamplingMode None, as shipped…");
  const noneShipped = await scenario("resamplingMode None, as shipped");
  useFix(true);
  P.status("Panning with resamplingMode None, with the fix…");
  const noneFixed = await scenario("resamplingMode None, with fix");

  // Same answers? 20 windows straight from the data series, both versions.
  let compared = 0, mismatches = 0;
  for (let k = 0; k < 20; k++) {
    const a = X0 + k * 3001, win = new NumberRange(a, a + 500 + k * 977);
    useFix(false); const want = ds.getWindowedYRange(win, true, false);
    useFix(true); const got = ds.getWindowedYRange(win, true, false);
    compared++;
    if (want.min !== got.min || want.max !== got.max) mismatches++;
  }
  const axisSame = (x, y) => x.yRange[0] === y.yRange[0] && x.yRange[1] === y.yRange[1];
  useFix(false);
  ohlcProto.getYRange = shippedGetYRange;
  P.log(`range check: ${compared} windows compared, ${mismatches} differ; final Y axis equal: resampled ${axisSame(resShipped, resFixed)}, none ${axisSame(noneShipped, noneFixed)}`);

  const visibleCandles = W + 1;
  const reproduced = noneShipped.getsInYRange >= 0.9 * 2 * visibleCandles && resShipped.getsInYRange >= 1000;
  const fixWorks = noneFixed.getsInYRange <= 0.01 * visibleCandles && resFixed.getsInYRange <= 10 && mismatches === 0 && axisSame(resShipped, resFixed) && axisSame(noneShipped, noneFixed);
  const fmt = (v) => Math.round(v).toLocaleString("en-US");
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each frame the Y autorange makes ${fmt(noneShipped.getsInYRange)} embind get() calls with resampling off (2 per visible candle, ${fmt(visibleCandles)} candles) and ${fmt(resShipped.getsInYRange)} with default resampling. ` +
        (fixWorks ? `With two MinMaxWithIndex calls: 0 get() calls, the same Y ranges, ${noneShipped.msPerCall.toFixed(2)} -> ${noneFixed.msPerCall.toFixed(2)} ms per getYRange.` : "The fix check did not pass (see the table).")
      : `Expected about ${fmt(2 * visibleCandles)} get() calls per frame with resampling off; measured ${fmt(noneShipped.getsInYRange)} (default resampling: ${fmt(resShipped.getsInYRange)}).`,
    columns: ["Resampled: shipped", "Resampled: fix", "No resampling: shipped", "No resampling: fix"],
    rows: [
      ["Candles in the visible window", visibleCandles, visibleCandles, visibleCandles, visibleCandles],
      ["getYRange calls per frame", resShipped.yRangeCallsPerFrame, resFixed.yRangeCallsPerFrame, noneShipped.yRangeCallsPerFrame, noneFixed.yRangeCallsPerFrame],
      ["SCRTDoubleVector.get calls inside getYRange per frame", resShipped.getsInYRange, resFixed.getsInYRange, noneShipped.getsInYRange, noneFixed.getsInYRange],
      ["... candles scanned per frame (get calls / 2)", resShipped.getsInYRange / 2, resFixed.getsInYRange / 2, noneShipped.getsInYRange / 2, noneFixed.getsInYRange / 2],
      ["SCRTDoubleVector.get calls per frame, whole page", resShipped.getsAll, resFixed.getsAll, noneShipped.getsAll, noneFixed.getsAll],
      ["Time in getYRange per call, ms (pass without the per-call hook)", resShipped.msPerCall, resFixed.msPerCall, noneShipped.msPerCall, noneFixed.msPerCall],
      ["Frame interval p95, ms (same pass)", resShipped.p95, resFixed.p95, noneShipped.p95, noneFixed.p95],
      ["Autoranged Y axis after the pan, max", resShipped.yRange[1], resFixed.yRange[1], noneShipped.yRange[1], noneFixed.yRange[1]],
    ],
    notes: [
      `With default resampling the scan covers the resampled candles, on the order of the plot width in pixels; with resampling off it covers every visible candle. ${compared} Y ranges computed by both versions on the same windows: ${mismatches} differ. Counts do not depend on hardware; times do.`,
      "The default price-axis autoRange is Once, which runs this scan only for the first range; the per-frame cost needs EAutoRange.Always, as in this demo.",
    ],
    metrics: { N, W, visibleCandles, resShipped, resFixed, noneShipped, noneFixed, compared, mismatches },
  });
}
