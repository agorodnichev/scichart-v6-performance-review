const META = {
  id: "041",
  title: "XyMovingAverageFilter recomputes every output after an insert or remove, a full pass for a front edit",
  issue: "issues/041-moving-average-insert-remove-recompute-tail.md",
  severity: "medium",
  claim: "On a source insert or remove at startIndex, XyMovingAverageFilter discards and recomputes every output from startIndex to the end, building two JS arrays of that size and copying them back into wasm, although only the inserted outputs and the next length-1 can change. Trimming the front of a sliding window, or prepending older history, recomputes all n outputs.",
  method: "<p>A non-FIFO XyDataSeries of 500,000 points with an <code>XyMovingAverageFilter</code> (length 50), both plotted. Scenario 1, a manual sliding window: every frame appends 10 points and then calls <code>removeRange(0, 10)</code> (30 frames). Scenario 2, 'load older data': two <code>insertRange(0, 10,000 older points)</code> calls. The demo counts the outputs the filter recomputes (values it passes to its own <code>appendRange</code>/<code>insertRange</code>), its <code>clear()</code> calls, and times each source call (filter work included).</p><p>A/B: the issue's library fix applied as a runtime patch of <code>XyMovingAverageFilter.prototype</code>: <code>filterOnInsert</code>/<code>filterOnRemove</code> replace only the window that can change (<code>replaceWindow</code>). Correctness check: after the patched runs, a fresh unpatched filter is built on the same source and every output is compared.</p>",
};

async function demo(P) {
  const { NumericAxis, XyDataSeries, FastLineRenderableSeries, XyMovingAverageFilter, EAutoRange, vectorToArrayViewF64 } = P.SciChart;
  const N = 500000, L = 50, BATCH = 10, FRAMES = 30, PREPEND = 10000, PREPENDS = 2;

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
  const yAt = (x) => Math.sin(x / 9000) + 0.5 * Math.sin(x / 130) + 0.2 * Math.sin(x / 7);
  const range = (x0, n) => { const xs = new Float64Array(n), ys = new Float64Array(n); for (let i = 0; i < n; i++) { xs[i] = x0 + i; ys[i] = yAt(x0 + i); } return { xs, ys }; };
  let firstX = 1000000, nextX = firstX;
  const init = range(nextX, N); nextX += N;
  const source = new XyDataSeries(wasmContext, { xValues: init.xs, yValues: init.ys, isSorted: true, containsNaN: false });
  const ma = new XyMovingAverageFilter(source, { length: L });
  sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries: source, stroke: "#4e79a7", strokeThickness: 1 }));
  sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries: ma, stroke: "#e15759", strokeThickness: 2 }));
  await P.sleep(500);

  // Counters on the filter instance: outputs recomputed = values it writes back through appendRange/insertRange.
  P.hookMethod(ma, "appendRange", { name: "filter appendRange", bytes: (a) => a[0].length });
  P.hookMethod(ma, "insertRange", { name: "filter insertRange", bytes: (a) => a[1].length });
  P.hookMethod(ma, "clear", { name: "filter clear" });
  P.hookMethod(ma, "removeRange", { name: "filter removeRange", bytes: (a) => a[1] });
  const outputs = (r) => r.total("filter appendRange", "bytes") + r.total("filter insertRange", "bytes");
  // Counter deltas around one synchronous call.
  const syncDelta = (fn) => {
    const s0 = P.snap(), t0 = P.now();
    fn();
    const ms = P.now() - t0, d = P.diff(s0, P.snap());
    return { ms, outputs: P.get(d, "filter appendRange", "bytes") + P.get(d, "filter insertRange", "bytes"), clears: P.get(d, "filter clear") };
  };

  async function trim(label) {
    let removeOutputs = 0, removeMs = 0;
    const r = await P.frames(FRAMES, () => {
      const b = range(nextX, BATCH); nextX += BATCH;
      source.appendRange(b.xs, b.ys);
      const d = syncDelta(() => source.removeRange(0, BATCH));
      removeOutputs += d.outputs; removeMs += d.ms;
    });
    firstX += FRAMES * BATCH;
    const res = { outputsPerRemove: removeOutputs / FRAMES, outputsPerFrame: outputs(r) / FRAMES, clears: r.total("filter clear") / FRAMES, removeMs: removeMs / FRAMES, p95: r.frameP95 };
    P.log(`${label}, sliding window: ${JSON.stringify(res)}`);
    return res;
  }
  async function prepend(label) {
    let outs = 0, ms = 0, clears = 0;
    for (let k = 0; k < PREPENDS; k++) {
      firstX -= PREPEND;
      const b = range(firstX, PREPEND);
      const d = syncDelta(() => source.insertRange(0, b.xs, b.ys));
      outs += d.outputs; ms += d.ms; clears += d.clears;
      await P.idleFrames(2);
    }
    const res = { outputsPerInsert: outs / PREPENDS, clears: clears / PREPENDS, insertMs: ms / PREPENDS, n: source.count() };
    P.log(`${label}, prepend: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Sliding window (append 10, removeRange(0, 10)), as shipped…");
  const shippedTrim = await trim("as shipped");
  P.status("Prepending older history, as shipped…");
  const shippedPrepend = await prepend("as shipped");

  // The issue's fix, as a prototype patch.
  const proto = XyMovingAverageFilter.prototype;
  const orig = { filterOnInsert: proto.filterOnInsert, filterOnRemove: proto.filterOnRemove };
  proto.replaceWindow = function (start, oldCount, newCount) {
    const xv = vectorToArrayViewF64(this.getOriginalXValues(), this.webAssemblyContext);
    const yv = vectorToArrayViewF64(this.getOriginalYValues(), this.webAssemblyContext);
    const xs = new Float64Array(newCount), ys = new Float64Array(newCount);
    let sum = 0;
    for (let j = Math.max(0, start - L + 1); j < start; j++) sum += yv[j] || 0;
    for (let k = 0; k < newCount; k++) {
      const i = start + k;
      xs[k] = xv[i];
      sum += yv[i] || 0;
      ys[k] = i >= this.length - 1 ? sum / this.length : NaN;
      if (i - this.length + 1 >= 0) sum -= yv[i - this.length + 1] || 0;
    }
    if (oldCount > 0) this.removeRange(start, oldCount);
    if (newCount === 0) return;
    if (start < this.count()) this.insertRange(start, xs, ys);
    else this.appendRange(xs, ys);
  };
  proto.filterOnInsert = function (startIndex, count) {
    if (this.fifoCapacity) return this.calculate(startIndex);
    const affected = Math.min(this.length - 1, this.count() - startIndex);
    this.replaceWindow(startIndex, affected, count + affected);
  };
  proto.filterOnRemove = function (startIndex, count) {
    if (this.fifoCapacity) return this.calculate(startIndex);
    const affected = Math.min(this.length - 1, this.getOriginalCount() - startIndex);
    this.replaceWindow(startIndex, count + affected, affected);
  };

  P.status("Sliding window, with the fix…");
  const fixedTrim = await trim("with fix");
  P.status("Prepending older history, with the fix…");
  const fixedPrepend = await prepend("with fix");

  // Restore, then compare the patched filter's outputs with a fresh full recompute.
  proto.filterOnInsert = orig.filterOnInsert;
  proto.filterOnRemove = orig.filterOnRemove;
  delete proto.replaceWindow;
  const fresh = new XyMovingAverageFilter(source, { length: L });
  const a = vectorToArrayViewF64(ma.getNativeYValues(), wasmContext), b = vectorToArrayViewF64(fresh.getNativeYValues(), wasmContext);
  const ax = vectorToArrayViewF64(ma.getNativeXValues(), wasmContext), bx = vectorToArrayViewF64(fresh.getNativeXValues(), wasmContext);
  let maxDiff = 0, nanMismatch = 0, xMismatch = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (Number.isNaN(a[i]) !== Number.isNaN(b[i])) nanMismatch++;
    else if (!Number.isNaN(a[i])) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
    if (ax[i] !== bx[i]) xMismatch++;
  }
  const sameLength = a.length === b.length;
  P.log(`patched vs fresh filter: length ${a.length} / ${b.length}, max |dy| ${maxDiff}, NaN mismatches ${nanMismatch}, x mismatches ${xMismatch}`);
  fresh.detachFromOriginalSeries();
  fresh.delete();
  const correct = sameLength && nanMismatch === 0 && xMismatch === 0 && maxDiff < 1e-9;

  const n = source.count();
  const reproduced = shippedTrim.outputsPerRemove >= 0.95 * (N - BATCH) && shippedPrepend.outputsPerInsert >= 0.95 * N
    && fixedTrim.outputsPerRemove <= 2 * L && fixedPrepend.outputsPerInsert <= PREPEND + 2 * L && correct;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `removeRange(0, ${BATCH}) on a ${N.toLocaleString("en-US")}-point source makes the moving average recompute ${Math.round(shippedTrim.outputsPerRemove).toLocaleString("en-US")} outputs (${shippedTrim.removeMs.toFixed(1)} ms); prepending ${PREPEND.toLocaleString("en-US")} points recomputes ${Math.round(shippedPrepend.outputsPerInsert).toLocaleString("en-US")}. With the fix: ${Math.round(fixedTrim.outputsPerRemove)} and ${Math.round(fixedPrepend.outputsPerInsert).toLocaleString("en-US")}, same output.`
      : `Expected a full recompute (about ${N.toLocaleString("en-US")} outputs) per front edit; measured ${shippedTrim.outputsPerRemove.toFixed(0)} per removeRange and ${shippedPrepend.outputsPerInsert.toFixed(0)} per prepend (fix: ${fixedTrim.outputsPerRemove.toFixed(0)} / ${fixedPrepend.outputsPerInsert.toFixed(0)}; output check ${correct ? "passed" : "failed"}).`,
    columns: ["As shipped", "With fix"],
    rows: [
      ["Sliding window: outputs recomputed per removeRange(0, " + BATCH + ")", shippedTrim.outputsPerRemove, fixedTrim.outputsPerRemove],
      ["Sliding window: filter clear() calls per frame", shippedTrim.clears, fixedTrim.clears],
      ["Sliding window: removeRange() time, ms per call", shippedTrim.removeMs, fixedTrim.removeMs],
      ["Sliding window: frame interval p95, ms", shippedTrim.p95, fixedTrim.p95],
      ["Prepend: outputs recomputed per insertRange(0, " + PREPEND.toLocaleString("en-US") + ")", shippedPrepend.outputsPerInsert, fixedPrepend.outputsPerInsert],
      ["Prepend: insertRange() time, ms per call", shippedPrepend.insertMs, fixedPrepend.insertMs],
      ["Source points at the end", n, n],
    ],
    notes: [
      `Correctness: after the patched runs, a fresh unpatched filter over the same source gives ${sameLength ? "the same length" : "a different length"}, ${xMismatch} X mismatches, ${nanMismatch} NaN mismatches, max |output difference| ${maxDiff.toExponential(2)} (running sums restart at the edit point, so only floating-point rounding can differ).`,
      "Times include the native work on the source and the filter's wasm vectors and depend on hardware; the output counts do not.",
    ],
    metrics: { shippedTrim, shippedPrepend, fixedTrim, fixedPrepend, maxDiff, nanMismatch, xMismatch, sameLength, n },
  });
}
