const META = {
  id: "021",
  title: "Stacked collections rebuild every stack with per-point wasm push_back calls on each append",
  issue: "issues/021-stacked-accumulation-per-point-push-back-rebuild.md",
  severity: "high",
  claim: "After any data change, StackedXyCollection.updateAccumulatedVectors clears every accumulated vector and refills it with one embind push_back call per value: N x (2S + 1) calls for S layers of N points, plus N more to unwind FIFO X values. Appending one point per layer costs as much as rebuilding the whole history.",
  method: "<p>A StackedMountainCollection with 5 layers, each a full FIFO XyDataSeries (fifoCapacity = N), streams one appendRange of 1 point per layer per frame for 30 frames, at N = 10,000 and N = 40,000. The demo counts SCRTDoubleVector.push_back calls made inside updateAccumulatedVectors and the rebuilds per frame (calls that found the collection dirty). Times per rebuild come from a second pass with the per-call hook removed, because hooking 480,000 calls per frame would inflate them.</p><p>A/B: StackedXyCollection.prototype.updateAccumulatedVectors is replaced with the issue's library fix (allocate with resizeFast first, then write through Float64Array views). Before streaming with it, both versions rebuild the same data and every accumulated value, bottom value and unwound X value is compared. The original method is restored afterwards.</p>",
};

async function demo(P) {
  const { NumericAxis, StackedMountainCollection, StackedMountainRenderableSeries, XyDataSeries, EAutoRange, vectorToArrayViewF64 } = P.SciChart;
  const S = 5, N_SMALL = 10000, N_LARGE = 40000, FRAMES = 30;
  const FILLS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f"];

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));

  // Layer s at index i. xNext is the next X value to append (shared by all layers).
  const yAt = (s, i) => 1 + Math.abs(Math.sin(i / 400 + s * 0.7)) * (1 + s * 0.2);
  let xNext = 0;
  function makeSeries(n) {
    const out = [];
    const xs = new Float64Array(n);
    for (let i = 0; i < n; i++) xs[i] = i;
    for (let s = 0; s < S; s++) {
      const ys = new Float64Array(n);
      for (let i = 0; i < n; i++) ys[i] = yAt(s, i);
      const ds = new XyDataSeries(wasmContext, { fifoCapacity: n, isSorted: true, containsNaN: false });
      ds.appendRange(xs, ys);
      out.push(ds);
    }
    xNext = n;
    return out;
  }
  let dataSeries = makeSeries(N_SMALL);
  const coll = new StackedMountainCollection(wasmContext);
  dataSeries.forEach((ds, s) => coll.add(new StackedMountainRenderableSeries(wasmContext, { dataSeries: ds, fill: FILLS[s], stroke: "#2b2b2b", strokeThickness: 1 })));
  sciChartSurface.renderableSeries.add(coll);
  await P.sleep(600);

  // StackedMountainCollection extends StackedXyCollection (not exported by name in the UMD bundle).
  const xyProto = Object.getPrototypeOf(StackedMountainCollection.prototype);
  const shipped = xyProto.updateAccumulatedVectors;

  // The issue's library fix: every allocation first (a heap growth detaches earlier views), then plain indexed writes.
  function fixedUpdateAccumulatedVectors() {
    const n = this.getDataSeriesValuesCount();
    if (!this.isAccumulatedVectorDirty || !n) return;
    this.checkXValuesCorrect();
    this.isAccumulatedVectorDirty = false;
    const wasm = this.webAssemblyContext;
    const separate = this.separatePositiveNegativeStacksProperty;
    const pct = this.isOneHundredPercent;
    const vis = this.getVisibleSeries();
    const sized = (got) => { if (got !== n) throw new Error("resizeFast could not grow a vector to " + n); };
    this.clearAccumulatedVectors(n);
    sized(this.accumulatedValues0.resizeFast(n));
    for (const rs of vis) {
      sized(rs.accumulatedValues.resizeFast(n));
      if (separate) sized(rs.bottomAccumulatedValues.resizeFast(n));
    }
    const fifo = this.isSourceFifo;
    if (fifo) {
      if (!this.unwoundXValuesProperty) this.unwoundXValuesProperty = new wasm.SCRTDoubleVector();
      this.unwoundXValuesProperty.clear();
      sized(this.unwoundXValuesProperty.resizeFast(n));
    }
    const view = (v) => vectorToArrayViewF64(v, wasm);
    if (fifo) {
      const ds = this.getFirstSeries().dataSeries;
      const src = view(ds.getNativeXValues()), dst = view(this.unwoundXValuesProperty), st = ds.fifoStartIndex;
      for (let i = 0; i < n; i++) dst[i] = src[(i + st) % n];
    }
    view(this.accumulatedValues0).fill(0);
    const ys = vis.map((rs) => view(rs.dataSeries.getNativeYValues()));
    const starts = vis.map((rs) => (rs.dataSeries.fifoCapacity > 0 && !rs.dataSeries.fifoSweeping ? rs.dataSeries.fifoStartIndex : 0));
    const tops = vis.map((rs) => view(rs.accumulatedValues));
    const bottoms = separate ? vis.map((rs) => view(rs.bottomAccumulatedValues)) : null;
    const L = vis.length;
    for (let i = 0; i < n; i++) {
      if (separate) {
        let pT = 0, nT = 0;
        if (pct) for (let s = 0; s < L; s++) { const y = ys[s][(i + starts[s]) % n]; if (y >= 0) pT += y; else nT += y; }
        let pA = 0, nA = 0;
        for (let s = 0; s < L; s++) {
          let y = ys[s][(i + starts[s]) % n];
          if (pct) y = y >= 0 ? (pT !== 0 ? (y / pT) * 100 : 0) : (nT !== 0 ? (y / Math.abs(nT)) * 100 : 0);
          if (y >= 0) { bottoms[s][i] = pA; const top = pA + y; tops[s][i] = top; pA = top; }
          else { const bottom = nA + y; bottoms[s][i] = bottom; tops[s][i] = nA; nA = bottom; }
        }
      } else {
        let total = 0;
        if (pct) for (let s = 0; s < L; s++) total += ys[s][(i + starts[s]) % n];
        let prev = 0;
        for (let s = 0; s < L; s++) { let y = ys[s][(i + starts[s]) % n]; if (pct) y = (y * 100) / total; const cur = prev + y; tops[s][i] = cur; prev = cur; }
      }
    }
    for (const rs of vis) if (rs.renderDataTransform) rs.renderDataTransform.requiresTransform = true;
  }

  // Timing + attribution wrapper around whichever implementation is active.
  let impl = shipped, inRebuild = false, rebuilds = 0, rebuildMs = 0;
  xyProto.updateAccumulatedVectors = function () {
    const dirty = this.isAccumulatedVectorDirty && this.getDataSeriesValuesCount();
    inRebuild = true;
    const t0 = P.now();
    try { return impl.apply(this, arguments); } finally {
      inRebuild = false;
      if (dirty) { rebuilds++; rebuildMs += P.now() - t0; P.count("rebuilds"); }
    }
  };

  async function stream(label, n, withCounter) {
    let undo = null;
    if (withCounter) {
      undo = P.hookMethod(wasmContext.SCRTDoubleVector.prototype, "push_back", {
        name: "push_back (all)",
        onCall: () => { if (inRebuild) P.count("push_back inside updateAccumulatedVectors"); },
      });
    }
    rebuilds = 0; rebuildMs = 0;
    const r = await P.frames(FRAMES, () => {
      for (let s = 0; s < S; s++) dataSeries[s].appendRange([xNext], [yAt(s, xNext)]);
      xNext++;
    });
    if (undo) undo();
    const res = {
      n,
      pushBack: r.perFrame("push_back inside updateAccumulatedVectors"),
      pushBackAll: r.perFrame("push_back (all)"),
      rebuildsPerFrame: r.perFrame("rebuilds"),
      msPerRebuild: rebuilds ? rebuildMs / rebuilds : 0,
      p95: r.frameP95,
    };
    P.log(`${label}${withCounter ? " (counting push_back)" : " (timing, no per-call hook)"}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Streaming 1 point per layer per frame, N = 10,000 per layer, as shipped…");
  const smallCount = await stream("as shipped, N = 10,000", N_SMALL, true);
  const smallTime = await stream("as shipped, N = 10,000", N_SMALL, false);

  // Swap in 40,000-point FIFO series (synchronously, so no render sees mixed lengths).
  const old = dataSeries;
  dataSeries = makeSeries(N_LARGE);
  coll.asArray().forEach((rs, s) => { rs.dataSeries = dataSeries[s]; });
  old.forEach((ds) => ds.delete());
  await P.idleFrames(5);
  P.status("Streaming, N = 40,000 per layer, as shipped…");
  const largeCount = await stream("as shipped, N = 40,000", N_LARGE, true);
  const largeTime = await stream("as shipped, N = 40,000", N_LARGE, false);

  // Same data, both implementations: compare every value they write.
  function snapshotVectors() {
    const v = (vec) => Array.from(vectorToArrayViewF64(vec, wasmContext));
    const o = { acc0: v(coll.accumulatedValues0), unwoundX: coll.unwoundXValuesProperty ? v(coll.unwoundXValuesProperty) : [] };
    coll.getVisibleSeries().forEach((rs, s) => { o["top" + s] = v(rs.accumulatedValues); o["bottom" + s] = v(rs.bottomAccumulatedValues); });
    return o;
  }
  coll.setAccumulatedValuesDirty(); shipped.call(coll);
  const a = snapshotVectors();
  coll.setAccumulatedValuesDirty(); fixedUpdateAccumulatedVectors.call(coll);
  const b = snapshotVectors();
  let compared = 0, mismatches = 0, maxDiff = 0;
  Object.keys(a).forEach((k) => {
    if (a[k].length !== b[k].length) { mismatches++; return; }
    for (let i = 0; i < a[k].length; i++) { compared++; const d = Math.abs(a[k][i] - b[k][i]); if (d > 0) { mismatches++; maxDiff = Math.max(maxDiff, d); } }
  });
  P.log(`output check: ${compared} values compared, ${mismatches} differ, max difference ${maxDiff}`);

  P.status("Streaming, N = 40,000 per layer, with the bulk-write fix…");
  impl = fixedUpdateAccumulatedVectors;
  const fixCount = await stream("with fix, N = 40,000", N_LARGE, true);
  const fixTime = await stream("with fix, N = 40,000", N_LARGE, false);
  impl = shipped;
  xyProto.updateAccumulatedVectors = shipped;

  const expected = (n) => n * (2 * S + 1) + n; // separate +/- stacks (default) plus the FIFO X unwind
  const growth = largeCount.pushBack / Math.max(1, smallCount.pushBack);
  const reproduced = smallCount.pushBack >= 0.9 * expected(N_SMALL) && largeCount.pushBack >= 0.9 * expected(N_LARGE) &&
    growth >= 3 && largeCount.rebuildsPerFrame >= 0.9;
  const fixWorks = fixCount.pushBack <= 0.01 * expected(N_LARGE) && mismatches === 0;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Appending 1 point to each of ${S} layers costs ${Math.round(largeCount.pushBack).toLocaleString("en-US")} embind push_back calls per frame at N = 40,000 (${Math.round(smallCount.pushBack).toLocaleString("en-US")} at N = 10,000): the rebuild follows the history length. ` +
        (fixWorks ? `With the bulk-write fix: ${Math.round(fixCount.pushBack)} calls, identical output, ${largeTime.msPerRebuild.toFixed(1)} ms -> ${fixTime.msPerRebuild.toFixed(1)} ms per rebuild.` : `The fix check did not pass (see the table).`)
      : `Expected about ${expected(N_LARGE).toLocaleString("en-US")} push_back calls per frame at N = 40,000; measured ${Math.round(largeCount.pushBack).toLocaleString("en-US")} (N = 10,000: ${Math.round(smallCount.pushBack).toLocaleString("en-US")}).`,
    columns: ["As shipped, N = 10,000", "As shipped, N = 40,000", "With fix, N = 40,000"],
    rows: [
      ["Points appended per frame (all layers)", S, S, S],
      ["Accumulated-vector rebuilds per frame", smallCount.rebuildsPerFrame, largeCount.rebuildsPerFrame, fixCount.rebuildsPerFrame],
      ["SCRTDoubleVector.push_back calls per frame (inside the rebuild)", smallCount.pushBack, largeCount.pushBack, fixCount.pushBack],
      ["Expected from the code: N x (2S + 1) + N", expected(N_SMALL), expected(N_LARGE), 0],
      ["Time per rebuild, ms (pass without the per-call hook)", smallTime.msPerRebuild, largeTime.msPerRebuild, fixTime.msPerRebuild],
      ["Frame interval p95, ms (pass without the per-call hook)", smallTime.p95, largeTime.p95, fixTime.p95],
      ["Values checked against the shipped rebuild of the same data", null, null, compared],
      ["Values that differ from the shipped rebuild", null, null, mismatches],
    ],
    notes: [
      "Counts do not depend on hardware; times do. Each push_back crosses into wasm through the generic embind invoker. At the issue's scale (5 layers x 100,000 points) the same code makes about 1.2 million calls per append.",
      "The fix column writes the same values (compared one by one above) without any per-value wasm call. Stacking at index i only reads index i, so a further fix could recompute only the appended indices for non-FIFO data.",
    ],
    metrics: { S, smallCount, smallTime, largeCount, largeTime, fixCount, fixTime, compared, mismatches, maxDiff, expectedSmall: expected(N_SMALL), expectedLarge: expected(N_LARGE) },
  });
}
