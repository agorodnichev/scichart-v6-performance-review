const META = {
  id: "089",
  title: "Column widths rescan every X value on every frame when X is unsorted",
  issue: "issues/089-datapointwidth-unsorted-minmax-every-frame.md",
  severity: "low",
  claim: "With the default Relative dataPointWidthMode, getDataPointWidth computes the column spacing from the X min and max. For unsorted X it runs a native NumberUtil.MinMax over the whole series on every draw, although the result only changes when the data changes. Horizontal error bars take the same path over their Y values even when X is sorted.",
  method: "<p>Left: a FastColumnRenderableSeries with 1,000,000 points whose X values are a shuffled permutation, panned one step per frame for 30 frames. Right: a FastErrorBarsRenderableSeries (errorDirection Horizontal) with 100,000 sorted points, redrawn every frame. The demo wraps each series' getDataPointWidth (bound per instance) and counts the NumberUtil.MinMax calls made inside it and the number of values each call scans, and times getDataPointWidth.</p><p>A/B: (1) the issue's fix, emulated at runtime: inside getDataPointWidth, MinMax results are cached per data series and changeCount; (2) the issue's app-side workaround for columns: the same data sorted by X. All patches are removed afterwards.</p>",
};

async function demo(P) {
  const { NumericAxis, FastColumnRenderableSeries, FastErrorBarsRenderableSeries, XyDataSeries, HlcDataSeries, EAutoRange, NumberRange, EErrorDirection } = P.SciChart;
  const N_COL = 1000000, N_ERR = 100000, FRAMES = 30;

  // ---- charts
  const left = await P.createSurface("chart");
  const wasm = left.wasmContext;
  const colX = new NumericAxis(wasm);
  left.sciChartSurface.xAxes.add(colX);
  left.sciChartSurface.yAxes.add(new NumericAxis(wasm, { autoRange: EAutoRange.Always }));
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  const shuffled = new Float64Array(N_COL);
  for (let i = 0; i < N_COL; i++) shuffled[i] = i;
  for (let i = N_COL - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = t; }
  const yOf = (x) => 1 + Math.abs(Math.sin(x / 3000)) + 0.3 * Math.abs(Math.sin(x / 97));
  const ysShuffled = shuffled.map(yOf);
  const unsortedDs = new XyDataSeries(wasm, { xValues: shuffled, yValues: ysShuffled, containsNaN: false });
  const columns = new FastColumnRenderableSeries(wasm, { dataSeries: unsortedDs, fill: "#4e79a7", stroke: "#4e79a7", strokeThickness: 0 });
  left.sciChartSurface.renderableSeries.add(columns);

  const right = await P.createSurface("chart2");
  right.sciChartSurface.xAxes.add(new NumericAxis(right.wasmContext, { autoRange: EAutoRange.Always }));
  right.sciChartSurface.yAxes.add(new NumericAxis(right.wasmContext, { autoRange: EAutoRange.Always }));
  const ex = new Float64Array(N_ERR), ey = new Float64Array(N_ERR), eh = new Float64Array(N_ERR), el = new Float64Array(N_ERR);
  for (let i = 0; i < N_ERR; i++) { ex[i] = i; ey[i] = Math.sin(i / 2000) * 10 + i / 5000; eh[i] = ex[i] + 0.4; el[i] = ex[i] - 0.4; }
  const errorBars = new FastErrorBarsRenderableSeries(right.wasmContext, {
    dataSeries: new HlcDataSeries(right.wasmContext, { xValues: ex, yValues: ey, highValues: eh, lowValues: el, isSorted: true, containsNaN: false }),
    errorDirection: EErrorDirection.Horizontal, stroke: "#e15759", strokeThickness: 1,
  });
  right.sciChartSurface.renderableSeries.add(errorBars);
  await P.sleep(800);

  // ---- instrumentation: MinMax calls made inside getDataPointWidth, and an optional per-changeCount cache (the fix)
  const NU = wasm.NumberUtil;
  let depth = 0, dpwMs = 0, memo = false;
  P.hookMethod(NU, "MinMax", { name: "MinMax (all)", onCall: (a) => { if (depth > 0) P.count("MinMax scans inside getDataPointWidth", 1, a[0].size()); } });
  const restore = [];
  function instrument(rs) {
    const bound = rs.getDataPointWidth; // BaseRenderableSeries binds it per instance in the constructor
    let cache = null;
    rs.getDataPointWidth = function () {
      depth++;
      const t0 = P.now();
      const real = NU.MinMax;
      if (memo) {
        const ds = this.dataSeries;
        NU.MinMax = function (vec, containsNaN) {
          if (cache && cache.ds === ds && cache.changeCount === ds.changeCount && cache.vec === vec) return { minD: cache.min, maxD: cache.max, delete() {} };
          const res = real.call(this, vec, containsNaN);
          cache = { ds, changeCount: ds.changeCount, vec, min: res.minD, max: res.maxD };
          return res;
        };
      }
      try { return bound.apply(this, arguments); } finally {
        NU.MinMax = real;
        depth--;
        dpwMs += P.now() - t0;
        P.count("getDataPointWidth calls");
      }
    };
    restore.push(() => { rs.getDataPointWidth = bound; });
  }
  instrument(columns);
  instrument(errorBars);

  async function run(label, perFrame) {
    dpwMs = 0;
    const r = await P.frames(FRAMES, perFrame);
    const res = {
      calls: r.perFrame("getDataPointWidth calls"),
      scans: r.perFrame("MinMax scans inside getDataPointWidth"),
      scanned: r.perFrame("MinMax scans inside getDataPointWidth", "bytes"),
      totalScans: r.total("MinMax scans inside getDataPointWidth"),
      msPerFrame: dpwMs / FRAMES,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }
  const W = 20000;
  const pan = (i) => { const x0 = 100000 + i * 997; colX.visibleRange = new NumberRange(x0, x0 + W); };
  const redrawRight = () => right.sciChartSurface.invalidateElement();

  P.status("Panning 1,000,000 unsorted columns, as shipped…");
  const colShipped = await run("columns, unsorted X, as shipped", pan);
  memo = true;
  P.status("Panning, with MinMax cached per changeCount (the fix)…");
  const colFixed = await run("columns, unsorted X, with the cache", pan);
  memo = false;

  P.status("Redrawing horizontal error bars, as shipped and with the cache…");
  const errShipped = await run("horizontal error bars, sorted X, as shipped", redrawRight);
  memo = true;
  const errFixed = await run("horizontal error bars, sorted X, with the cache", redrawRight);
  memo = false;

  P.status("Panning the same columns sorted by X (workaround)…");
  const order = Array.from({ length: N_COL }, (_, i) => i); // x values are 0..N-1, so sorted X is simply i
  const sortedDs = new XyDataSeries(wasm, { xValues: order, yValues: order.map(yOf), isSorted: true, containsNaN: false });
  columns.dataSeries = sortedDs;
  unsortedDs.delete();
  await P.idleFrames(5);
  const colSorted = await run("columns, sorted X, as shipped", pan);
  restore.forEach((f) => f());

  const reproduced = colShipped.scans >= 0.9 && colShipped.scanned >= 0.9 * N_COL && colSorted.scans <= 0.05;
  const fixWorks = colFixed.totalScans <= 1 && errFixed.totalScans <= 1;
  const errAlso = errShipped.scans >= 0.9 && errShipped.scanned >= 0.9 * N_ERR;
  const fmt = (v) => Math.round(v).toLocaleString("en-US");
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Every frame of the pan runs ${colShipped.scans.toFixed(0)} native MinMax over all ${fmt(colShipped.scanned)} unsorted X values (${colShipped.msPerFrame.toFixed(2)} ms per frame here) to size the columns; with a per-changeCount cache ${colFixed.totalScans} scan in ${FRAMES} frames, with sorted X none.` +
        (errAlso ? ` Horizontal error bars rescan their ${fmt(N_ERR)} Y values on every redraw although X is sorted.` : "")
      : `Expected one full MinMax per frame for unsorted X; measured ${colShipped.scans.toFixed(2)} scans of ${fmt(colShipped.scanned)} values per frame (sorted X: ${colSorted.scans.toFixed(2)}).`,
    columns: ["Unsorted X: shipped", "Unsorted X: cache", "Sorted X", "Error bars: shipped", "Error bars: cache"],
    rows: [
      ["Points in the series", N_COL, N_COL, N_COL, N_ERR, N_ERR],
      ["getDataPointWidth calls per frame", colShipped.calls, colFixed.calls, colSorted.calls, errShipped.calls, errFixed.calls],
      ["NumberUtil.MinMax calls inside it per frame", colShipped.scans, colFixed.scans, colSorted.scans, errShipped.scans, errFixed.scans],
      ["Values scanned per frame", colShipped.scanned, colFixed.scanned, colSorted.scanned, errShipped.scanned, errFixed.scanned],
      ["MinMax calls in the whole 30-frame run", colShipped.totalScans, colFixed.totalScans, colSorted.totalScans, errShipped.totalScans, errFixed.totalScans],
      ["Time in getDataPointWidth per frame, ms", colShipped.msPerFrame, colFixed.msPerFrame, colSorted.msPerFrame, errShipped.msPerFrame, errFixed.msPerFrame],
      ["Frame interval p95, ms", colShipped.p95, colFixed.p95, colSorted.p95, errShipped.p95, errFixed.p95],
    ],
    notes: [
      "The scan is native and fast (it is a fraction of a millisecond even at 1,000,000 points on a desktop), and unsorted data is drawn in full every frame anyway, so the saving is a fraction of frame time, as the issue says. The count is the evidence: the same full scan repeats on every frame while the data is unchanged.",
      "The cache column keys the result on the data series and its changeCount, as the issue's fix does; the fix must also clear it before data animations, which rewrite X without bumping changeCount.",
    ],
    metrics: { N_COL, N_ERR, colShipped, colFixed, colSorted, errShipped, errFixed },
  });
}
