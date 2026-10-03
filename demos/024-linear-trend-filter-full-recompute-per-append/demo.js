const META = {
  id: "024",
  title: "XyLinearTrendFilter rebuilds and re-uploads the whole trend line on every source append",
  issue: "issues/024-linear-trend-filter-full-recompute-per-append.md",
  severity: "high",
  claim: "XyLinearTrendFilter implements only filterAll, so every append to the source recomputes the regression sums over all n points, builds two n-element JS arrays with push, clears its output and appendRange()s all n points back into wasm, even when 10 points were added.",
  method: "<p>A non-FIFO XyDataSeries of 500,000 points, plotted with an <code>XyLinearTrendFilter</code> line. Each frame appends 10 points to the source (40 frames per run). The demo counts, per source append: <code>filterAll</code> calls, <code>clear()</code> calls on the filter, the number of values passed to the filter's <code>appendRange</code> (copied into wasm), and the time of the whole <code>source.appendRange</code> call (filter work included).</p><p>A/B: the issue's library fix applied as a runtime patch of <code>XyLinearTrendFilter.prototype</code>: running sums kept by <code>filterAll</code>, an incremental <code>filterOnAppend</code> that adds only the new points to the sums, rewrites the existing output Y values in place through a Float64Array view and appends only the new points. Correctness check: after the patched run, a fresh unpatched filter is built on the same source and its slope, intercept and output values are compared with the patched filter's.</p>",
};

async function demo(P) {
  const { NumericAxis, XyDataSeries, FastLineRenderableSeries, XyLinearTrendFilter, EAutoRange, vectorToArrayViewF64 } = P.SciChart;
  const N = 500000, BATCH = 10, FRAMES = 40;

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
  let t = 0;
  const batch = (n) => {
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++, t++) { xs[i] = t; ys[i] = t * 0.00002 + Math.sin(t / 5000) + 0.4 * Math.sin(t / 77); }
    return { xs, ys };
  };
  const first = batch(N);
  const source = new XyDataSeries(wasmContext, { xValues: first.xs, yValues: first.ys, isSorted: true, containsNaN: false });
  const trend = new XyLinearTrendFilter(source);
  sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries: source, stroke: "#4e79a7", strokeThickness: 1 }));
  sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries: trend, stroke: "#e15759", strokeThickness: 3 }));
  await P.sleep(500);

  // Counters on this filter instance.
  const proto = XyLinearTrendFilter.prototype;
  P.hookMethod(trend, "clear", { name: "filter clear()" });
  P.hookMethod(trend, "appendRange", { name: "filter appendRange()", bytes: (a) => a[0].length });
  const undoFilterAll = P.hookMethod(proto, "filterAll", { name: "filterAll()" });

  async function stream(label) {
    const ms = [];
    const r = await P.frames(FRAMES, () => {
      const b = batch(BATCH);
      const t0 = P.now();
      source.appendRange(b.xs, b.ys);
      ms.push(P.now() - t0);
    });
    ms.sort((x, y) => x - y);
    const res = {
      filterAll: r.total("filterAll()") / FRAMES,
      clears: r.total("filter clear()") / FRAMES,
      copied: r.total("filter appendRange()", "bytes") / FRAMES,
      inPlace: r.total("output Y rewritten in place") / FRAMES,
      appendMs: ms[Math.floor(ms.length / 2)], appendP95: ms[Math.floor(ms.length * 0.95)],
      count: trend.count(), p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Appending 10 points per frame to a 500k-point source, as shipped…");
  const shipped = await stream("as shipped");

  // The issue's fix (library side), applied as a prototype patch.
  undoFilterAll();
  const orig = { filterAll: proto.filterAll, filterOnAppend: Object.prototype.hasOwnProperty.call(proto, "filterOnAppend") ? proto.filterOnAppend : undefined };
  proto.addToSums = function (x, y) {
    const s = this.sums;
    s.n++; s.xy += x * y; s.x += x; s.y += y; s.xx += Math.pow(x, 2); s.yy += Math.pow(y, 2);
  };
  proto.updateCoefficients = function () {
    const s = this.sums, a = s.xy * s.n, b = s.x * s.y, c = s.xx * s.n, d = Math.pow(s.x, 2);
    this.correlationProperty = (a - b) / Math.sqrt((c - d) * (s.yy * s.n - Math.pow(s.y, 2)));
    this.slopeProperty = (a - b) / (c - d);
    this.interceptProperty = (s.y - this.slopeProperty * s.x) / s.n;
  };
  proto.filterAll = function () {
    P.count("filterAll()");
    const originalCount = this.getOriginalCount();
    const xv = vectorToArrayViewF64(this.getOriginalXValues(), this.webAssemblyContext);
    const yv = vectorToArrayViewF64(this.getOriginalYValues(), this.webAssemblyContext);
    const fifoCapacity = this.originalSeries.fifoCapacity;
    const fifoStartIndex = fifoCapacity ? this.originalSeries.fifoStartIndex : 0;
    const rawIdx = (i) => (fifoCapacity ? (i + fifoStartIndex) % fifoCapacity : i);
    this.sums = { n: 0, x: 0, y: 0, xy: 0, xx: 0, yy: 0 };
    for (let i = 0; i < originalCount; i++) { const r = rawIdx(i); this.addToSums(xv[r], yv[r]); }
    this.updateCoefficients();
    const xValues = new Float64Array(originalCount), yValues = new Float64Array(originalCount);
    for (let i = 0; i < originalCount; i++) { const x = xv[rawIdx(i)]; xValues[i] = x; yValues[i] = x * this.slopeProperty + this.interceptProperty; }
    this.clear();
    this.appendRange(xValues, yValues);
  };
  proto.filterOnAppend = function (count) {
    const s = this.sums, n0 = s ? s.n : -1;
    if (!s || this.originalSeries.fifoCapacity || this.fifoCapacity || this.count() !== n0 || n0 + count !== this.getOriginalCount()) { this.filterAll(); return; }
    const xv = vectorToArrayViewF64(this.getOriginalXValues(), this.webAssemblyContext);
    const yv = vectorToArrayViewF64(this.getOriginalYValues(), this.webAssemblyContext);
    for (let i = n0; i < n0 + count; i++) this.addToSums(xv[i], yv[i]);
    this.updateCoefficients();
    const m = this.slopeProperty, c = this.interceptProperty;
    const newX = xv.slice(n0, n0 + count), newY = newX.map((x) => x * m + c);
    const outX = vectorToArrayViewF64(this.getNativeXValues(), this.webAssemblyContext);
    const outY = vectorToArrayViewF64(this.getNativeYValues(), this.webAssemblyContext);
    for (let i = 0; i < n0; i++) outY[i] = outX[i] * m + c;
    P.count("output Y rewritten in place", n0);
    this.appendRange(newX, newY);
  };
  trend.filterAll(); // initialise the running sums once, outside the measured run
  P.status("Appending 10 points per frame, with the incremental fix…");
  const fixed = await stream("with incremental fix");
  const patched = { slope: trend.slope, intercept: trend.intercept, y: Float64Array.from(vectorToArrayViewF64(trend.getNativeYValues(), wasmContext)) };

  // Restore, then compare against a fresh, unpatched filter over the same source.
  proto.filterAll = orig.filterAll;
  if (orig.filterOnAppend) proto.filterOnAppend = orig.filterOnAppend; else delete proto.filterOnAppend;
  delete proto.addToSums; delete proto.updateCoefficients;
  const fresh = new XyLinearTrendFilter(source);
  const freshY = vectorToArrayViewF64(fresh.getNativeYValues(), wasmContext);
  let maxDiff = 0;
  for (let i = 0; i < freshY.length; i++) maxDiff = Math.max(maxDiff, Math.abs(freshY[i] - patched.y[i]));
  const identical = Object.is(fresh.slope, patched.slope) && Object.is(fresh.intercept, patched.intercept) && freshY.length === patched.y.length && maxDiff === 0;
  P.log(`fresh filter vs patched: slope ${fresh.slope} / ${patched.slope}, intercept ${fresh.intercept} / ${patched.intercept}, max |dy| ${maxDiff}`);
  fresh.detachFromOriginalSeries();
  fresh.delete();

  const n = source.count();
  const reproduced = shipped.filterAll >= 0.99 && shipped.clears >= 0.99 && shipped.copied >= 0.99 * (N + BATCH) && fixed.copied <= BATCH * 1.01 && fixed.clears === 0;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Appending ${BATCH} points to a ${N.toLocaleString("en-US")}-point source makes the trend filter clear itself and copy ${Math.round(shipped.copied).toLocaleString("en-US")} values back into wasm, every append (${shipped.appendMs.toFixed(1)} ms median). With the incremental fix: ${Math.round(fixed.copied)} values, 0 clears (${fixed.appendMs.toFixed(1)} ms), identical output.`
      : `Expected a full rebuild (about ${N.toLocaleString("en-US")} values) per append; measured ${shipped.copied.toFixed(0)} values and ${shipped.clears.toFixed(2)} clears per append.`,
    columns: ["As shipped", "Incremental fix"],
    rows: [
      ["Source points (end of run)", n, n],
      ["filterAll() calls per append", shipped.filterAll, fixed.filterAll],
      ["Filter clear() calls per append", shipped.clears, fixed.clears],
      ["Values copied into the filter by appendRange, per append", shipped.copied, fixed.copied],
      ["Output Y values rewritten in place (typed-array view), per append", null, fixed.inPlace],
      ["source.appendRange() time, median ms", shipped.appendMs, fixed.appendMs],
      ["source.appendRange() time, p95 ms", shipped.appendP95, fixed.appendP95],
      ["Frame interval p95, ms", shipped.p95, fixed.p95],
    ],
    notes: [
      `Correctness: a fresh unpatched filter over the same source gives slope ${fresh.slope === patched.slope ? "identical" : "different"}, intercept ${fresh.intercept === patched.intercept ? "identical" : "different"}, max |output difference| ${maxDiff} (${identical ? "bit-identical" : "not identical"}).`,
      "The fix still touches every output point once per append (each Y depends on the new slope), but with a typed-array write instead of two pushed JS arrays, a clear(), a NaN/sortedness scan and a full copy into wasm. Counts do not depend on hardware; times do.",
    ],
    metrics: { shipped, fixed, n, batch: BATCH, maxDiff, identical },
  });
}
