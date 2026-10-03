const META = {
  id: "009",
  title: "Rectangle hit tests scan every rectangle and run the Y test (2 get + 2 GetCoordinate) before X",
  issue: "issues/009-rectangle-hittest-unsorted-scan-y-before-x.md",
  severity: "high",
  claim: "RectangleSeriesHitTestProvider always calls the O(N) hitTestForBoxUnsorted helper, and inside the loop it evaluates the Y test (two vector.get() and two GetCoordinate calls through embind) for every rectangle before the X test, although the Y result only matters for the one or few rectangles that the X test hits.",
  method: "<p>One FastRectangleRenderableSeries with 20,000 StartEnd rectangles (Gantt-style: 100 lanes x 200 tasks, XyxyDataSeries with x/x1 = start/end and y/y1 = top/bottom) and a default RolloverModifier. Single pointer moves are dispatched one at a time and measured synchronously (the work done inside the pointermove handler), then the pointer sweeps the plot for 30 frames.</p><p>Counted: <code>hitTestHelpersRectangleSeries.hitTestForBoxUnsorted</code> calls and the rectangles they loop over, wasm <code>SCRTDoubleVector.get</code> calls, wasm <code>GetCoordinate</code> calls (every native coordinate-calculator class is hooked), and time in the helper and in the pointermove handler.</p><p>A/B: the issue's fix applied at runtime: the same helper with the Y test moved behind the X test (<code>isXHit && testIsYHit(...)</code>). Hit results are compared between the two versions on a 7 x 5 grid of points.</p>",
};

async function demo(P) {
  const { NumericAxis, FastRectangleRenderableSeries, XyxyDataSeries, RolloverModifier, EColumnMode, EColumnYMode,
    hitTestHelpersRectangleSeries, vectorToArrayViewF64 } = P.SciChart;
  const LANES = 100, PER_LANE = 200, N = LANES * PER_LANE, MOVES = 12, FRAMES = 30;

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext));
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const xs = [], x1s = [], ys = [], y1s = [];
  for (let k = 0; k < PER_LANE; k++) {
    for (let lane = 0; lane < LANES; lane++) {
      const start = k * 50 + rnd() * 8;
      xs.push(start); x1s.push(start + 20 + rnd() * 20);
      ys.push(lane + 0.4); y1s.push(lane - 0.4);
    }
  }
  const rs = new FastRectangleRenderableSeries(wasmContext, {
    dataSeries: new XyxyDataSeries(wasmContext, { xValues: xs, yValues: ys, x1Values: x1s, y1Values: y1s, containsNaN: false }),
    columnXMode: EColumnMode.StartEnd, columnYMode: EColumnYMode.TopBottom,
    fill: "#4e79a7", stroke: "#2b4a6f", strokeThickness: 1,
  });
  sciChartSurface.renderableSeries.add(rs);
  sciChartSurface.chartModifiers.add(new RolloverModifier());
  await P.sleep(800);

  // ---- counters
  P.watchEmbind(wasmContext, ["SCRTDoubleVector.get"]);
  // Local helper: hook a native method on whichever prototype in each class's chain defines it (deduplicated).
  const hookNative = (classes, method, name) => {
    const owners = new Set();
    classes.forEach((c) => {
      let p = wasmContext[c] && wasmContext[c].prototype;
      while (p && !Object.prototype.hasOwnProperty.call(p, method)) p = Object.getPrototypeOf(p);
      if (p) owners.add(p);
    });
    owners.forEach((p) => P.hookMethod(p, method, { name }));
    return owners.size;
  };
  const coordOwners = hookNative(["LinearCoordinateCalculatorDouble", "FlippedLinearCoordinateCalculatorDouble",
    "LinearCoordinateCalculatorSingle", "FlippedLinearCoordinateCalculatorSingle"], "GetCoordinate", "wasm GetCoordinate");

  // ---- the issue's fix: hitTestForBoxUnsorted (hitTestHelpersRectangleSeries.js:118-261) with the Y test behind the X test
  function testIsYHit(yValues, y1Values, yCoordinateCalculator, yHitCoord, defaultY1, resPointIndex, columnYMode) {
    const yValue = yValues ? yValues.get(resPointIndex) : 1;
    const y1Value = y1Values ? y1Values.get(resPointIndex) : defaultY1;
    let top = yValue, bottom = y1Value;
    switch (columnYMode) {
      case EColumnYMode.TopBottom: break;
      case EColumnYMode.TopHeight: bottom = yValue - y1Value; break;
      case EColumnYMode.CenterHeight: { const half = y1Value / 2; top = yValue + half; bottom = yValue - half; break; }
    }
    const topCoord = yCoordinateCalculator.getCoordinate(top);
    const bottomCoord = yCoordinateCalculator.getCoordinate(bottom);
    return Math.min(topCoord, bottomCoord) <= yHitCoord && yHitCoord <= Math.max(topCoord, bottomCoord);
  }
  function reorderedUnsorted(wasm, xCC, yCC, xValues, x1Values, yValues, y1Values, xHitCoord, yHitCoord, defaultY1, columnCoordWidth, columnXMode, columnYMode, isVertical, isPolar) {
    const xVectorSize = xValues.size(), halfColumn = columnCoordWidth / 2;
    let resIndex = -1, resCoordDist = Number.MAX_VALUE, resIsHit = false, resXHitCoord;
    let resLeft = Number.MAX_VALUE, resRight = Number.NEGATIVE_INFINITY;
    const calcDistFn = (l, r, v) => { const a = r - v, b = v - l; return a >= 0 && b >= 0 ? 0 : Math.min(Math.abs(a), Math.abs(b)); };
    const testIsXHitFn = (l, r) => {
      let dist = calcDistFn(l, r, xHitCoord), hit = xHitCoord;
      if (isPolar && !isVertical) {
        [xHitCoord - 2 * Math.PI, xHitCoord + 2 * Math.PI].forEach((c) => { const d = calcDistFn(l, r, c); if (d < dist) { dist = d; hit = c; } });
      }
      return { xCoordDist: dist, xHitCoord: hit, isHit: dist === 0 };
    };
    const update = (l, r, i) => {
      if (l < resLeft) resLeft = l;
      if (r > resRight) resRight = r;
      const { isHit: isXHit, xCoordDist, xHitCoord: xh } = testIsXHitFn(l, r);
      const isBothHit = isXHit && testIsYHit(yValues, y1Values, yCC, yHitCoord, defaultY1, i, columnYMode); // the fix
      if (resIsHit) {
        if (isBothHit && xCoordDist < resCoordDist) { resIndex = i; resCoordDist = xCoordDist; resXHitCoord = xh; }
      } else if (isBothHit) {
        resIsHit = true; resIndex = i; resCoordDist = xCoordDist; resXHitCoord = xh;
      } else if (xCoordDist < resCoordDist) {
        resIndex = i; resCoordDist = xCoordDist; resXHitCoord = xh;
      }
    };
    const flipped = xCC.isFlipped;
    const xv = vectorToArrayViewF64(xValues, wasm);
    const x1v = x1Values ? vectorToArrayViewF64(x1Values, wasm) : undefined;
    for (let i = 0; i < xVectorSize; i++) {
      let l, r;
      switch (columnXMode) {
        case EColumnMode.Mid: { const c = xCC.getCoordinate(xv[i]); l = c - halfColumn; r = c + halfColumn; break; }
        case EColumnMode.Start: { const c = xCC.getCoordinate(xv[i]); l = flipped ? c - columnCoordWidth : c; r = flipped ? c : c + columnCoordWidth; break; }
        case EColumnMode.MidWidth: l = xCC.getCoordinate(xv[i] - x1v[i] / 2); r = xCC.getCoordinate(xv[i] + x1v[i] / 2); break;
        case EColumnMode.StartWidth: l = xCC.getCoordinate(xv[i]); r = xCC.getCoordinate(xv[i] + x1v[i]); break;
        case EColumnMode.StartEnd: l = xCC.getCoordinate(xv[i]); r = xCC.getCoordinate(x1v[i]); break;
        default: continue;
      }
      if (flipped && columnXMode !== EColumnMode.Mid && columnXMode !== EColumnMode.Start) update(r, l, i); else update(l, r, i);
    }
    if (resIndex === -1) return { isHit: false, nearestPointIndex: -1, isWithinDataBounds: false };
    const isCategoryAxis = xCC.isCategoryCoordinateCalculator;
    return {
      isHit: resCoordDist === 0 && testIsYHit(yValues, y1Values, yCC, yHitCoord, defaultY1, resIndex, columnYMode),
      nearestPointIndex: resIndex,
      isWithinDataBounds: resLeft <= resXHitCoord && resXHitCoord <= resRight,
      xValue: isCategoryAxis ? resIndex : xValues.get(resIndex),
      x1Value: isCategoryAxis ? resIndex : x1Values && x1Values.get ? x1Values.get(resIndex) : undefined,
      yValue: yValues.get(resIndex),
      y1Value: y1Values && y1Values.get ? y1Values.get(resIndex) : undefined,
    };
  }
  const shippedUnsorted = hitTestHelpersRectangleSeries.hitTestForBoxUnsorted;
  let useFix = false, helperMs = 0;
  hitTestHelpersRectangleSeries.hitTestForBoxUnsorted = function () {
    const t0 = P.now();
    try { return (useFix ? reorderedUnsorted : shippedUnsorted).apply(this, arguments); } finally {
      helperMs += P.now() - t0;
      P.count("O(N) box scans (hitTestForBoxUnsorted)");
      P.count("rectangles scanned", arguments[3].size());
    }
  };

  // ---- scenarios
  const pointer = P.pointer(sciChartSurface);
  async function singleMoves(label) {
    pointer.enter(0.15, 0.5);
    await P.idleFrames(4);
    const acc = { moves: 0, scans: 0, rects: 0, get: 0, coord: 0, handlerMs: 0, helperMs: 0 };
    for (let i = 0; i < MOVES; i++) {
      const fx = 0.15 + (0.7 * i) / (MOVES - 1), fy = 0.2 + 0.6 * ((i * 5) % MOVES) / MOVES;
      helperMs = 0;
      const r = await P.during(() => { pointer.move(fx, fy); });
      acc.moves++;
      acc.scans += r.total("O(N) box scans (hitTestForBoxUnsorted)");
      acc.rects += r.total("rectangles scanned");
      acc.get += r.total("wasm SCRTDoubleVector.get");
      acc.coord += r.total("wasm GetCoordinate");
      acc.handlerMs += r.ms;
      acc.helperMs += helperMs;
      await P.idleFrames(2);
    }
    pointer.leave();
    await P.idleFrames(3);
    const per = (v) => v / acc.moves;
    const res = {
      scansPerMove: per(acc.scans), rectsPerScan: acc.rects / Math.max(1, acc.scans),
      getPerMove: per(acc.get), coordPerMove: per(acc.coord),
      getPerRect: acc.get / Math.max(1, acc.rects), coordPerRect: acc.coord / Math.max(1, acc.rects),
      handlerMs: per(acc.handlerMs), helperMs: acc.helperMs / Math.max(1, acc.scans),
    };
    P.log(`${label}, single moves: ${JSON.stringify(res)}`);
    return res;
  }
  async function hover(label) {
    pointer.enter(0.15, 0.5);
    await P.idleFrames(4);
    const r = await P.frames(FRAMES, (i) => pointer.move(pointer.sweepX(i, FRAMES), 0.5));
    pointer.leave();
    await P.idleFrames(3);
    const res = { scansPerFrame: r.perFrame("O(N) box scans (hitTestForBoxUnsorted)"), callsPerFrame: r.perFrame("wasm SCRTDoubleVector.get") + r.perFrame("wasm GetCoordinate"), p95: r.frameP95 };
    P.log(`${label}, hover sweep: ${JSON.stringify(res)}`);
    return res;
  }
  function probeGrid() {
    const v = sciChartSurface.seriesViewRect, out = [];
    for (let gx = 0; gx < 7; gx++) for (let gy = 0; gy < 5; gy++) {
      const h = rs.hitTestProvider.hitTest(v.left + v.width * (0.08 + 0.14 * gx), v.top + v.height * (0.1 + 0.2 * gy));
      out.push([h.dataSeriesIndex, h.isHit, h.isWithinDataBounds, h.xValue, h.x1Value, h.yValue, h.y1Value].join("|"));
    }
    return out;
  }

  P.status("Single pointer moves, library as shipped…");
  const shipped = await singleMoves("as shipped");
  P.status("Hover sweep, library as shipped…");
  const shippedHover = await hover("as shipped");
  const shippedGrid = P.quiet(probeGrid);

  useFix = true;
  P.status("Single pointer moves, Y test after X test…");
  const fixed = await singleMoves("with fix");
  P.status("Hover sweep, Y test after X test…");
  const fixedHover = await hover("with fix");
  const fixedGrid = P.quiet(probeGrid);
  useFix = false;
  hitTestHelpersRectangleSeries.hitTestForBoxUnsorted = shippedUnsorted;

  const mismatches = shippedGrid.filter((s, i) => s !== fixedGrid[i]).length;
  const hits = shippedGrid.filter((s) => s.split("|")[1] === "true").length;
  const valid = coordOwners > 0 && shipped.scansPerMove >= 0.9;
  const reproduced = valid && shipped.rectsPerScan >= N * 0.99 && shipped.getPerRect >= 1.9 && fixed.getPerRect <= 0.05 && mismatches === 0;
  P.report({
    verdict: !valid ? "inconclusive" : reproduced ? "reproduced" : "not-reproduced",
    headline: !valid
      ? `The pointer moves did not reach the rectangle hit test (scans per move: ${shipped.scansPerMove.toFixed(2)}, coordinate hooks: ${coordOwners}).`
      : reproduced
        ? `Each pointer move loops over all ${N.toLocaleString("en-US")} rectangles and makes ${Math.round(shipped.getPerMove).toLocaleString("en-US")} get() + ${Math.round(shipped.coordPerMove).toLocaleString("en-US")} GetCoordinate calls. With the Y test behind the X test: ${Math.round(fixed.getPerMove)} get() + ${Math.round(fixed.coordPerMove).toLocaleString("en-US")} GetCoordinate, identical hit results.`
        : `Expected 2 get() calls per rectangle for all ${N} rectangles on each move; measured ${shipped.getPerRect.toFixed(2)} per rectangle over ${Math.round(shipped.rectsPerScan)} (fix: ${fixed.getPerRect.toFixed(3)}; result mismatches: ${mismatches}).`,
    columns: ["As shipped", "Y test after X test"],
    rows: [
      ["O(N) scans per pointer move", shipped.scansPerMove, fixed.scansPerMove],
      ["Rectangles looped over per scan", shipped.rectsPerScan, fixed.rectsPerScan],
      ["wasm SCRTDoubleVector.get calls per pointer move", shipped.getPerMove, fixed.getPerMove],
      ["wasm GetCoordinate calls per pointer move", shipped.coordPerMove, fixed.coordPerMove],
      ["  embind calls per rectangle (get + GetCoordinate)", shipped.getPerRect + shipped.coordPerRect, fixed.getPerRect + fixed.coordPerRect],
      ["O(N) scans per frame while hovering", shippedHover.scansPerFrame, fixedHover.scansPerFrame],
      ["Time in one scan, ms", shipped.helperMs, fixed.helperMs],
      ["Time in the pointermove handler, ms", shipped.handlerMs, fixed.handlerMs],
      ["Frame interval p95 while hovering, ms", shippedHover.p95, fixedHover.p95],
    ],
    notes: [
      `Hit results on a 7 x 5 grid of probe points: ${mismatches === 0 ? "identical" : mismatches + " differ"} between the shipped code and the reordered loop (${hits} of 35 are hits). With the fix, the Y test still runs for every rectangle the X test hits: one per lane in this Gantt layout.`,
      "The loop stays O(N) after the fix (X still costs 2 GetCoordinate per StartEnd rectangle). The O(log N) helper hitTestForBoxSorted exists but RectangleSeriesHitTestProvider.hitTestForBox never calls it, and it would not cover StartEnd rectangles anyway.",
      "Counts do not depend on hardware; times do, and they include the counting hooks on get() and GetCoordinate, which make each embind call slower than in production.",
    ],
    metrics: { rectangles: N, shipped, fixed, shippedHover, fixedHover, mismatches, hits, coordOwners },
  });
}
