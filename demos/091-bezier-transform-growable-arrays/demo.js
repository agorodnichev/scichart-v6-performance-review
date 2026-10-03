const META = {
  id: "091",
  title: "Bezier transform builds each run's output in growable JS arrays and drops them",
  issue: "issues/091-bezier-transform-grows-js-arrays-per-run.md",
  severity: "medium",
  claim: "bezierTransform() pushes every output vertex into three plain JS arrays (x, y, index), about visible points x interpolationPoints values each, and then copies them into wasm element by element with HEAPF64.set. This repeats on every pan or zoom frame and data change; the arrays become garbage straight away. The smooth stacked mountain runs it twice per series and uses one of the six arrays from the first call.",
  method: "<p>Left: a FastLineRenderableSeries with a BezierRenderDataTransform (interpolationPoints 20) on 20,000 points, 5,000 of them visible, resampling off so the transform sees every visible point. Right: a StackedMountainCollection with two SmoothStackedMountainRenderableSeries (1,000 points each). Both X axes are panned for 30 frames. The demo counts transform runs, output vertices, Array.prototype.push calls made inside runTransformInternal, and elements copied into wasm by Float64Array.set from a plain Array (the element-by-element conversion). The time per run comes from a separate pass without these counters.</p><p>A/B (line series): runTransformInternal uses the issue's bezierTransformF64, which writes the same values into exactly sized Float64Arrays and precomputes the eased t once per run. The demo checks once that both versions produce identical output. Garbage-collection time itself is not visible from a page; the issue rates the cost as a hypothesis.</p>",
};

async function demo(P) {
  const S = P.SciChart;
  const { NumericAxis, NumberRange, XyDataSeries, FastLineRenderableSeries, BezierRenderDataTransform, XyyBezierRenderDataTransform, StackedMountainCollection,
    SmoothStackedMountainRenderableSeries, EResamplingMode, vectorToArrayViewF64, appendDoubleVectorFromJsArray, easing } = S;
  const N = 20000, VIS = 5000, NS = 1000, FRAMES = 30;

  const left = await P.createSurface("chart");
  const wasm = left.wasmContext;
  const lx = new NumericAxis(wasm, { visibleRange: new NumberRange(0, VIS) });
  left.sciChartSurface.xAxes.add(lx);
  left.sciChartSurface.yAxes.add(new NumericAxis(wasm, { visibleRange: new NumberRange(-1.5, 1.5) }));
  const xs = Array.from({ length: N }, (_, i) => i);
  const line = new FastLineRenderableSeries(wasm, {
    dataSeries: new XyDataSeries(wasm, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 200) + 0.3 * Math.sin(x / 17)), isSorted: true, containsNaN: false }),
    stroke: "#4e79a7", strokeThickness: 1, resamplingMode: EResamplingMode.None,
  });
  line.renderDataTransform = new BezierRenderDataTransform(line, wasm, [line.drawingProviders[0]], { interpolationPoints: 20 });
  left.sciChartSurface.renderableSeries.add(line);

  const right = await P.createSurface("chart2");
  const rx = new NumericAxis(right.wasmContext, { visibleRange: new NumberRange(0, NS * 0.8) });
  right.sciChartSurface.xAxes.add(rx);
  right.sciChartSurface.yAxes.add(new NumericAxis(right.wasmContext, { visibleRange: new NumberRange(0, 5) }));
  const sx = Array.from({ length: NS }, (_, i) => i);
  const stack = new StackedMountainCollection(right.wasmContext);
  [["#59a14f", 0], ["#edc948", 2]].forEach(([fill, phase]) => stack.add(new SmoothStackedMountainRenderableSeries(right.wasmContext, {
    dataSeries: new XyDataSeries(right.wasmContext, { xValues: sx, yValues: sx.map((x) => 1.2 + Math.sin(x / 40 + phase)), isSorted: true, containsNaN: false }),
    fill, stroke: fill,
  })));
  right.sciChartSurface.renderableSeries.add(stack);
  await P.sleep(800);

  // The issue's fix: same values in exactly sized Float64Arrays (copied from the library's bezierTransform).
  const bezierTransformF64 = (oldX, oldY, iStart, iEnd, interpolationPoints, curvature, y1Values) => {
    const oldXSize = oldX.length;
    const perSegment = Math.max(1, Math.ceil(interpolationPoints));
    const outSize = Math.max(0, iEnd - iStart) * perSegment + 1;
    const newxValues = new Float64Array(outSize), newyValues = new Float64Array(outSize), newindexes = new Float64Array(outSize);
    const tByJ = new Float64Array(perSegment);
    for (let j = 1; j < interpolationPoints; j++) tByJ[j] = easing.inOutCubic(j / interpolationPoints);
    const getControlPoint = (x, y, xp, yp, xn, yn, f) => {
      if (yp !== yp) return { xc: x, yc: y };
      if (x === xp && y === yp) return { xc: x, yc: y };
      let m = Number.MAX_VALUE;
      if (x !== xp) m = (y - yp) / (x - xp);
      const d = (xn - x) * f;
      const xc = x + d;
      let yc = y + m * d;
      yc = Math.max(Math.min(yc, Math.max(y, yn)), Math.min(y, yn));
      return { xc, yc };
    };
    const bezier = (p1, p2, p3, p4, t) => { const f = 1 - t; return Math.pow(f, 3) * p1 + 3 * f * f * t * p2 + 3 * f * t * t * p3 + Math.pow(t, 3) * p4; };
    const getPoint = (i) => ({ x: oldX[i], y: oldY[i] });
    let index = 0;
    const getY1 = () => { if (!y1Values) return Infinity; const y1 = y1Values[index]; return y1 !== y1 ? Infinity : y1; };
    let pPrev = getPoint(Math.max(iStart - 1, 0)), pCur = getPoint(iStart), pNext = getPoint(iStart + 1), pAfter = getPoint(Math.min(iStart + 2, oldXSize - 1));
    let p3;
    for (let i = iStart; i < iEnd; i++) {
      newxValues[index] = pCur.x; newindexes[index] = index; newyValues[index] = Math.min(pCur.y, getY1()); index++;
      const p2 = getControlPoint(pCur.x, pCur.y, p3 ? p3.xc : pPrev.x, p3 ? p3.yc : pPrev.y, pNext.x, pNext.y, curvature);
      p3 = getControlPoint(pNext.x, pNext.y, pAfter.x, pAfter.y, pCur.x, pCur.y, curvature);
      for (let j = 1; j < interpolationPoints; j++) {
        const t = tByJ[j];
        newxValues[index] = bezier(pCur.x, p2.xc, p3.xc, pNext.x, t);
        newyValues[index] = Math.min(bezier(pCur.y, p2.yc, p3.yc, pNext.y, t), getY1());
        newindexes[index] = index; index++;
      }
      if (i > iStart) pPrev = pCur;
      pCur = pNext; pNext = pAfter;
      if (i < oldXSize - 3) pAfter = getPoint(i + 3);
    }
    newxValues[index] = pNext.x; newyValues[index] = Math.min(pNext.y, getY1()); newindexes[index] = index;
    return { newxValues, newyValues, newindexes };
  };
  function runTransformInternalF64(renderPassData) {
    const { xValues: oldX, yValues: oldY, resampled } = renderPassData.pointSeries;
    const { xValues, yValues, indexes } = this.pointSeries;
    const iStart = resampled ? 0 : renderPassData.indexRange.min;
    const iEnd = resampled ? oldX.size() - 1 : renderPassData.indexRange.max;
    if (oldX.size() == 0) return renderPassData.pointSeries;
    xValues.clear(); yValues.clear(); indexes.clear();
    const r = bezierTransformF64(vectorToArrayViewF64(oldX, this.wasmContext), vectorToArrayViewF64(oldY, this.wasmContext), iStart, iEnd, this.interpolationPoints, this.curvature);
    appendDoubleVectorFromJsArray(this.wasmContext, xValues, r.newxValues);
    appendDoubleVectorFromJsArray(this.wasmContext, yValues, r.newyValues);
    appendDoubleVectorFromJsArray(this.wasmContext, indexes, r.newindexes);
    return this.pointSeries;
  }

  // Wrap both transforms: runs, output size, time; `lineImpl` is what the A/B swaps.
  let inRun = false, runMs = 0;
  const wrapRun = (proto, label, getImpl) => {
    const shipped = proto.runTransformInternal;
    proto.runTransformInternal = function () {
      inRun = true;
      const t0 = P.now();
      try { return (getImpl ? getImpl() : shipped).apply(this, arguments); } finally {
        runMs += P.now() - t0;
        inRun = false;
        P.count(label + " runs");
        P.count(label + " output vertices", this.pointSeries.xValues.size());
      }
    };
    return shipped;
  };
  let lineImpl = null;
  const shippedLineRun = wrapRun(BezierRenderDataTransform.prototype, "bezier", () => lineImpl);
  lineImpl = shippedLineRun;
  const shippedXyyRun = wrapRun(XyyBezierRenderDataTransform.prototype, "smooth stacked");

  // Counters for the counting passes only: pushes inside a run, and copies into wasm from plain Arrays.
  const hookCounters = () => {
    const u1 = P.hookMethod(Array.prototype, "push", { name: "Array.push (all)", onCall: (a) => { if (inRun) P.count("Array.push inside a run", a.length); } });
    const u2 = P.hookMethod(Float64Array.prototype, "set", {
      name: "Float64Array.set (all)",
      onCall: (a) => { if (inRun) P.count(Array.isArray(a[0]) ? "copied into wasm from plain Arrays" : "copied into wasm from typed arrays", a[0] ? a[0].length : 0); },
    });
    return () => { u1(); u2(); };
  };

  const tri = (i) => { const k = (i % 40) / 40; return k < 0.5 ? k * 2 : 2 - k * 2; };
  async function pan(label, surface, axis, span, travel, prefix, withCounters) {
    const unhook = withCounters ? hookCounters() : null;
    await P.idleFrames(3);
    runMs = 0;
    const r = await P.frames(FRAMES, (i) => { const o = travel * tri(i); axis.visibleRange = new NumberRange(o, o + span); });
    if (unhook) unhook();
    const runs = r.total(prefix + " runs");
    const per = (name) => (runs ? r.total(name) / runs : 0);
    const res = {
      runsPerFrame: runs / FRAMES,
      outputPerRun: per(prefix + " output vertices"),
      pushesPerRun: per("Array.push inside a run"),
      plainCopiesPerRun: per("copied into wasm from plain Arrays"),
      typedCopiesPerRun: per("copied into wasm from typed arrays"),
      msPerRun: runs ? runMs / runs : 0,
      p95: r.frameP95,
    };
    P.log(`${label}${withCounters ? " (counting)" : " (timing)"}: ${JSON.stringify(res)}`);
    return res;
  }
  const both = async (label, ...args) => {
    const c = await pan(label, ...args, true), t = await pan(label, ...args, false);
    return { ...c, msPerRun: t.msPerRun, p95: t.p95 };
  };

  P.status("Panning the Bezier line, library as shipped…");
  const lineArgs = [left.sciChartSurface, lx, VIS, N - VIS, "bezier"];
  const shipped = await both("Bezier line, as shipped", ...lineArgs);
  P.status("Panning the Bezier line, typed-array fix…");
  lineImpl = runTransformInternalF64;
  const fixed = await both("Bezier line, typed arrays", ...lineArgs);

  // Identical output? Run both versions on the same input.
  const t = line.renderDataTransform, rpd = line.getCurrentRenderPassData();
  const grab = () => [t.pointSeries.xValues, t.pointSeries.yValues, t.pointSeries.indexes].map((v) => Array.from(vectorToArrayViewF64(v, wasm)));
  shippedLineRun.call(t, rpd);
  const a = grab();
  runTransformInternalF64.call(t, rpd);
  const b = grab();
  const identical = a[0].length > 0 && a.every((arr, k) => arr.length === b[k].length && arr.every((v, i) => Object.is(v, b[k][i])));
  lineImpl = shippedLineRun;

  P.status("Panning the smooth stacked mountains, as shipped…");
  const stacked = await both("smooth stacked, as shipped", right.sciChartSurface, rx, NS * 0.8, NS * 0.2, "smooth stacked");

  BezierRenderDataTransform.prototype.runTransformInternal = shippedLineRun;
  XyyBezierRenderDataTransform.prototype.runTransformInternal = shippedXyyRun;

  const growable = shipped.runsPerFrame >= 0.8 && shipped.outputPerRun > 0 && shipped.pushesPerRun >= 0.99 * 3 * shipped.outputPerRun &&
    shipped.plainCopiesPerRun >= 0.99 * 3 * shipped.outputPerRun;
  // A few pushes per run remain in both versions: embind's invoker pushes each wasm-call argument (resizeFast, dataPtr).
  const fixRemoves = fixed.pushesPerRun <= 0.001 * 3 * fixed.outputPerRun && fixed.plainCopiesPerRun === 0 && identical;
  const reproduced = growable && fixRemoves;
  const fmt = (v) => Math.round(v).toLocaleString("en-US");
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each pan frame reruns the Bezier transform, which makes ${fmt(shipped.pushesPerRun)} Array.push calls (3 growable arrays, one value per output vertex each) and copies ${fmt(shipped.plainCopiesPerRun)} values from plain Arrays into wasm element by element (${fmt(shipped.outputPerRun)} output vertices, ${shipped.msPerRun.toFixed(1)} ms per run). With exactly sized Float64Arrays: ${fmt(fixed.pushesPerRun)} pushes (wasm-call glue only), same output, ${fixed.msPerRun.toFixed(1)} ms per run.`
      : `Expected about 3 x ${fmt(shipped.outputPerRun)} array pushes per run; measured ${fmt(shipped.pushesPerRun)} (typed-array fix: ${fmt(fixed.pushesPerRun)}, identical output: ${identical}).`,
    columns: ["Bezier line, as shipped", "Bezier line, typed arrays (fix)", "Smooth stacked mountain, as shipped"],
    rows: [
      ["Transform runs per pan frame", shipped.runsPerFrame, fixed.runsPerFrame, stacked.runsPerFrame],
      ["Output vertices per run", shipped.outputPerRun, fixed.outputPerRun, stacked.outputPerRun],
      ["Array.push calls per run (values appended to growable arrays)", shipped.pushesPerRun, fixed.pushesPerRun, stacked.pushesPerRun],
      ["Values copied into wasm from plain Arrays per run", shipped.plainCopiesPerRun, fixed.plainCopiesPerRun, stacked.plainCopiesPerRun],
      ["Values copied into wasm from typed arrays per run", shipped.typedCopiesPerRun, fixed.typedCopiesPerRun, stacked.typedCopiesPerRun],
      ["Time per transform run, ms", shipped.msPerRun, fixed.msPerRun, stacked.msPerRun],
      ["Frame interval p95, ms", shipped.p95, fixed.p95, stacked.p95],
    ],
    notes: [
      `Identical output from both versions: ${identical ? "yes" : "NO"} (${a[0].length.toLocaleString("en-US")} vertices, x, y and index compared bit for bit). The few pushes left with the fix are embind's own argument marshalling (one push per argument of each wasm call, such as resizeFast and dataPtr), present in both columns.`,
      `Smooth stacked: each series run pushes ${(stacked.pushesPerRun / Math.max(1, stacked.outputPerRun)).toFixed(1)} values per output vertex (two bezierTransform calls, six arrays, one of the first three used) but copies ${(stacked.plainCopiesPerRun / Math.max(1, stacked.outputPerRun)).toFixed(1)} per vertex into wasm.`,
      "The arrays die young, so the cost is allocation and minor GC plus the element-by-element copy; a page cannot read GC time, and the time rows depend on hardware. Counts do not.",
    ],
    metrics: { N, visible: VIS, frames: FRAMES, shipped, fixed, stacked, identical },
  });
}
