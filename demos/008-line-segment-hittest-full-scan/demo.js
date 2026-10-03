const META = {
  id: "008",
  title: "Line-segment hit tests scan every segment with 8 embind get() calls each, on every pointer move",
  issue: "issues/008-line-segment-hittest-full-scan-embind-get.md",
  severity: "high",
  claim: "LineSegmentSeriesHitTestProvider answers each RolloverModifier hit test with a JS scan of the whole series (the visible range is ignored): two bounding-box passes plus a distance pass, reading every value through an embind vector.get() instead of a typed-array view. It runs synchronously in the pointermove handler and again in each render while the pointer hovers.",
  method: "<p>One FastLineSegmentRenderableSeries with 20,000 random segments (40,000 points, unsorted) and a default RolloverModifier. Single pointer moves are dispatched one at a time and measured synchronously (the work done inside the pointermove handler), then the pointer sweeps the plot for 30 frames (one move per frame, so render-time Rollover updates are included). The same single moves are repeated after zooming the X axis to 2% of the data range.</p><p>Counted: full scans (<code>hitTestHelpers.getNearestLineSegment</code> calls), wasm <code>SCRTDoubleVector.get</code> calls and wasm <code>GetCoordinate</code> calls (every native coordinate-calculator class is hooked), plus time in the scan and in the pointermove handler.</p><p>A/B: the issue's fix applied at runtime: <code>hitTestXy</code> reads through <code>vectorToArrayViewF64</code> views and the scan computes the bounding box in its single distance pass. Hit results (index, isHit, isWithinDataBounds, values) are compared between the two versions on a 7 x 5 grid of points.</p>",
};

async function demo(P) {
  const { NumericAxis, NumberRange, FastLineSegmentRenderableSeries, XyDataSeries, RolloverModifier, LineSegmentSeriesHitTestProvider,
    hitTestHelpers, HitTestInfo, vectorToArrayViewF64, calcDistance, calcDistanceFromLine } = P.SciChart;
  const SEGMENTS = 20000, MOVES = 12, FRAMES = 30;

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  const xAxis = new NumericAxis(wasmContext);
  sciChartSurface.xAxes.add(xAxis);
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext));
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const xs = new Array(2 * SEGMENTS), ys = new Array(2 * SEGMENTS);
  for (let i = 0; i < SEGMENTS; i++) {
    const x = rnd() * 1000, y = rnd() * 100;
    xs[2 * i] = x; ys[2 * i] = y;
    xs[2 * i + 1] = x + (rnd() - 0.5) * 12; ys[2 * i + 1] = y + (rnd() - 0.5) * 8;
  }
  const rs = new FastLineSegmentRenderableSeries(wasmContext, {
    dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: ys, containsNaN: false }),
    stroke: "#4e79a7", strokeThickness: 1,
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

  // ---- the issue's fix, switchable: typed-array views in hitTestXy + bounding box fused into the distance pass
  const shippedScan = hitTestHelpers.getNearestLineSegment;
  const fusedScan = (xCC, yCC, numberOfSegments, getXFn, getYFn, getX1Fn, getY1Fn, xHitCoord, yHitCoord, hitTestRadius) => {
    let minX = Number.MAX_VALUE, maxX = Number.NEGATIVE_INFINITY, minY = Number.MAX_VALUE, maxY = Number.NEGATIVE_INFINITY;
    let minDistance = Number.MAX_VALUE, minDistanceIndex = -1;
    for (let i = 0; i < numberOfSegments; i++) {
      const x = getXFn(i), y = getYFn(i), x1 = getX1Fn(i), y1 = getY1Fn(i);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (x1 < minX) minX = x1;
      if (x1 > maxX) maxX = x1;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (y1 < minY) minY = y1;
      if (y1 > maxY) maxY = y1;
      const xCoord = xCC.getCoordinate(x), yCoord = yCC.getCoordinate(y);
      const x1Coord = xCC.getCoordinate(x1), y1Coord = yCC.getCoordinate(y1);
      const len = calcDistance(xCoord, yCoord, x1Coord, y1Coord);
      if (calcDistance(xCoord, yCoord, xHitCoord, yHitCoord) <= len + hitTestRadius && calcDistance(x1Coord, y1Coord, xHitCoord, yHitCoord) <= len + hitTestRadius) {
        const d = calcDistanceFromLine(xHitCoord, yHitCoord, xCoord, yCoord, x1Coord, y1Coord);
        if (d <= minDistance) { minDistance = d; minDistanceIndex = i; }
      }
    }
    const xHitValue = xCC.getDataValue(xHitCoord), yHitValue = yCC.getDataValue(yHitCoord);
    return {
      isHit: minDistance <= hitTestRadius,
      isWithinDataBounds: minX <= xHitValue && xHitValue <= maxX && minY <= yHitValue && yHitValue <= maxY,
      nearestPointIndex: minDistanceIndex,
      nearestDistance: minDistanceIndex >= 0 ? minDistance : undefined,
    };
  };
  const proto = LineSegmentSeriesHitTestProvider.prototype;
  const shippedHitTestXy = proto.hitTestXy;
  // Same as the shipped hitTestXy (LineSegmentSeriesHitTestProvider.js:25-69) except the four getters read typed-array views.
  const fixedHitTestXy = function (x, y, hitTestRadius) {
    const hitTestPoint = this.getTranslatedHitTestPoint(x, y);
    if (!hitTestPoint) return HitTestInfo.empty();
    const { xCoordinateCalculator, yCoordinateCalculator, isVerticalChart } = this.currentRenderPassData;
    const xHitCoord = isVerticalChart ? hitTestPoint.y : hitTestPoint.x;
    const yHitCoord = isVerticalChart ? hitTestPoint.x : hitTestPoint.y;
    const dataSeries = this.parentSeries.dataSeries;
    if (!dataSeries) return HitTestInfo.empty();
    const xNativeValues = dataSeries.getNativeXValues();
    const yNativeValues = dataSeries.getNativeYValues();
    const dataSeriesCount = xNativeValues.size();
    if (dataSeriesCount < 2) return HitTestInfo.empty();
    const xv = dataSeries.fifoCapacity ? undefined : vectorToArrayViewF64(xNativeValues, this.webAssemblyContext);
    const yv = dataSeries.fifoCapacity ? undefined : vectorToArrayViewF64(yNativeValues, this.webAssemblyContext);
    const getXFn = xv ? (i) => xv[2 * i] : (i) => xNativeValues.get(2 * i);
    const getYFn = yv ? (i) => yv[2 * i] : (i) => yNativeValues.get(2 * i);
    const getX1Fn = xv ? (i) => xv[2 * i + 1] : (i) => xNativeValues.get(2 * i + 1);
    const getY1Fn = yv ? (i) => yv[2 * i + 1] : (i) => yNativeValues.get(2 * i + 1);
    const { isHit, isWithinDataBounds, nearestPointIndex, nearestDistance } = hitTestHelpers.getNearestLineSegment(xCoordinateCalculator, yCoordinateCalculator, dataSeriesCount / 2, getXFn, getYFn, getX1Fn, getY1Fn, xHitCoord, yHitCoord, hitTestRadius);
    const firstPointIndex = nearestPointIndex >= 0 ? nearestPointIndex * 2 : -1;
    const info = hitTestHelpers.createHitTestInfo(this.parentSeries, xCoordinateCalculator, yCoordinateCalculator, isVerticalChart, dataSeries, xNativeValues, yNativeValues, xHitCoord, yHitCoord, firstPointIndex, hitTestRadius, nearestDistance);
    if (firstPointIndex !== -1) {
      info.dataSeriesIndex = firstPointIndex;
      info.isWithinDataBounds = isWithinDataBounds;
      info.isHit = isHit;
      info.xValue = xNativeValues.get(firstPointIndex);
      info.xCoord = xCoordinateCalculator.getCoordinate(info.xValue);
      info.yValue = yNativeValues.get(firstPointIndex);
      info.yCoord = yCoordinateCalculator.getCoordinate(info.yValue);
      info.point2dataSeriesIndex = firstPointIndex + 1;
      info.point2xValue = xNativeValues.get(firstPointIndex + 1);
      info.point2xCoord = xCoordinateCalculator.getCoordinate(info.point2xValue);
      info.point2yValue = yNativeValues.get(firstPointIndex + 1);
      info.point2yCoord = yCoordinateCalculator.getCoordinate(info.point2yValue);
      info.point2metadata = dataSeries.getMetadataAt(firstPointIndex + 1);
      info.point2yValueByName = dataSeries.valueNames.reduce((map, name) => {
        map[name] = dataSeries.getNativeValue(dataSeries.getYValuesByName(name), info.point2dataSeriesIndex);
        return map;
      }, {});
    }
    return info;
  };
  let useFix = false, scanMs = 0;
  hitTestHelpers.getNearestLineSegment = function () {
    const t0 = P.now();
    try { return (useFix ? fusedScan : shippedScan).apply(this, arguments); } finally {
      scanMs += P.now() - t0;
      P.count("full scans (getNearestLineSegment)");
      P.count("segments scanned", arguments[2]);
    }
  };
  proto.hitTestXy = function () { return (useFix ? fixedHitTestXy : shippedHitTestXy).apply(this, arguments); };

  // ---- scenarios
  const pointer = P.pointer(sciChartSurface);
  async function singleMoves(label) {
    pointer.enter(0.15, 0.5);
    await P.idleFrames(4);
    const acc = { moves: 0, scans: 0, segments: 0, get: 0, coord: 0, handlerMs: 0, scanMs: 0 };
    for (let i = 0; i < MOVES; i++) {
      const fx = 0.15 + (0.7 * i) / (MOVES - 1);
      scanMs = 0;
      const r = await P.during(() => { pointer.move(fx, 0.5); });
      acc.moves++;
      acc.scans += r.total("full scans (getNearestLineSegment)");
      acc.segments += r.total("segments scanned");
      acc.get += r.total("wasm SCRTDoubleVector.get");
      acc.coord += r.total("wasm GetCoordinate");
      acc.handlerMs += r.ms;
      acc.scanMs += scanMs;
      await P.idleFrames(2); // let the render-time update run outside the measured window
    }
    pointer.leave();
    await P.idleFrames(3);
    const per = (v) => v / acc.moves;
    const res = {
      scansPerMove: per(acc.scans), segmentsPerScan: acc.segments / Math.max(1, acc.scans),
      getPerMove: per(acc.get), coordPerMove: per(acc.coord),
      getPerSegment: acc.get / Math.max(1, acc.segments), coordPerSegment: acc.coord / Math.max(1, acc.segments),
      handlerMs: per(acc.handlerMs), scanMs: acc.scanMs / Math.max(1, acc.scans),
    };
    P.log(`${label}, single moves: ${JSON.stringify(res)}`);
    return res;
  }
  // Hover sweep, one pointer move per frame. rerender: also invalidate the chart each frame (as streaming data would).
  async function hover(label, rerender) {
    pointer.enter(0.15, 0.5);
    await P.idleFrames(4);
    let renders = 0;
    const onRendered = () => { renders++; };
    sciChartSurface.rendered.subscribe(onRendered);
    const r = await P.frames(FRAMES, (i) => {
      pointer.move(pointer.sweepX(i, FRAMES), 0.5);
      if (rerender) sciChartSurface.invalidateElement();
    });
    sciChartSurface.rendered.unsubscribe(onRendered);
    pointer.leave();
    await P.idleFrames(3);
    const res = { rendersPerFrame: renders / FRAMES, scansPerFrame: r.perFrame("full scans (getNearestLineSegment)"), getPerFrame: r.perFrame("wasm SCRTDoubleVector.get"), coordPerFrame: r.perFrame("wasm GetCoordinate"), p95: r.frameP95 };
    P.log(`${label}, hover sweep${rerender ? " + re-render each frame" : ""}: ${JSON.stringify(res)}`);
    return res;
  }
  function probeGrid() {
    const v = sciChartSurface.seriesViewRect, out = [];
    for (let gx = 0; gx < 7; gx++) for (let gy = 0; gy < 5; gy++) {
      const h = rs.hitTestProvider.hitTestXSlice(v.left + v.width * (0.08 + 0.14 * gx), v.top + v.height * (0.1 + 0.2 * gy));
      out.push([h.dataSeriesIndex, h.isHit, h.isWithinDataBounds, h.xValue, h.yValue, h.point2xValue, h.point2yValue].join("|"));
    }
    return out;
  }

  P.status("Single pointer moves, library as shipped…");
  const shipped = await singleMoves("as shipped");
  P.status("Hover sweep, library as shipped…");
  const shippedHover = await hover("as shipped", false);
  P.status("Hover sweep while the chart re-renders each frame, as shipped…");
  const shippedHoverRender = await hover("as shipped", true);
  const shippedGrid = P.quiet(probeGrid);

  P.status("Zoomed to 2% of the X range, as shipped…");
  const fullRange = xAxis.visibleRange;
  xAxis.visibleRange = new NumberRange(500, 520);
  await P.idleFrames(6);
  P.log(`X visible range for the zoomed run: ${xAxis.visibleRange.min} to ${xAxis.visibleRange.max} (data spans about 0 to 1000)`);
  const zoomed = await singleMoves("as shipped, zoomed to 2% of X");
  xAxis.visibleRange = fullRange;
  await P.idleFrames(6);

  useFix = true;
  P.status("Single pointer moves, with the fix…");
  const fixed = await singleMoves("with fix");
  P.status("Hover sweep, with the fix…");
  const fixedHover = await hover("with fix", false);
  const fixedHoverRender = await hover("with fix", true);
  const fixedGrid = P.quiet(probeGrid);
  useFix = false;
  hitTestHelpers.getNearestLineSegment = shippedScan;
  proto.hitTestXy = shippedHitTestXy;

  const mismatches = shippedGrid.filter((s, i) => s !== fixedGrid[i]).length;
  const hits = shippedGrid.filter((s) => s.split("|")[1] === "true").length;
  const valid = coordOwners > 0 && shipped.scansPerMove >= 0.9;
  const reproduced = valid &&
    shipped.segmentsPerScan >= SEGMENTS * 0.99 && shipped.getPerSegment >= 7.5 &&
    zoomed.segmentsPerScan >= SEGMENTS * 0.99 && zoomed.getPerSegment >= 7.5 &&
    fixed.getPerSegment <= 0.01 && mismatches === 0;
  P.report({
    verdict: !valid ? "inconclusive" : reproduced ? "reproduced" : "not-reproduced",
    headline: !valid
      ? `The pointer moves did not reach the line-segment scan (scans per move: ${shipped.scansPerMove.toFixed(2)}, coordinate hooks: ${coordOwners}).`
      : reproduced
        ? `Each pointer move scans all ${SEGMENTS.toLocaleString("en-US")} segments with ${Math.round(shipped.getPerMove).toLocaleString("en-US")} embind get() calls and ${Math.round(shipped.coordPerMove).toLocaleString("en-US")} GetCoordinate calls, also when zoomed to 2% of the data. With typed-array views and one pass: ${Math.round(fixed.getPerMove)} get() calls, identical hit results.`
        : `Expected about 8 get() calls per segment for every segment on each move; measured ${shipped.getPerSegment.toFixed(2)} per segment over ${Math.round(shipped.segmentsPerScan)} segments (zoomed: ${zoomed.getPerSegment.toFixed(2)}; fix: ${fixed.getPerSegment.toFixed(3)}; result mismatches: ${mismatches}).`,
    columns: ["As shipped", "As shipped, zoomed to 2%", "With fix"],
    rows: [
      ["Full scans per pointer move", shipped.scansPerMove, zoomed.scansPerMove, fixed.scansPerMove],
      ["Segments scanned per scan", shipped.segmentsPerScan, zoomed.segmentsPerScan, fixed.segmentsPerScan],
      ["wasm SCRTDoubleVector.get calls per pointer move", shipped.getPerMove, zoomed.getPerMove, fixed.getPerMove],
      ["  per segment scanned", shipped.getPerSegment, zoomed.getPerSegment, fixed.getPerSegment],
      ["wasm GetCoordinate calls per pointer move", shipped.coordPerMove, zoomed.coordPerMove, fixed.coordPerMove],
      ["Full scans per frame, hover sweep on a static chart", shippedHover.scansPerFrame, null, fixedHover.scansPerFrame],
      ["Full scans per frame, hover sweep while the chart re-renders", shippedHoverRender.scansPerFrame, null, fixedHoverRender.scansPerFrame],
      ["wasm calls (get + GetCoordinate) per frame, re-rendering", shippedHoverRender.getPerFrame + shippedHoverRender.coordPerFrame, null, fixedHoverRender.getPerFrame + fixedHoverRender.coordPerFrame],
      ["Time in one scan, ms", shipped.scanMs, zoomed.scanMs, fixed.scanMs],
      ["Time in the pointermove handler, ms", shipped.handlerMs, zoomed.handlerMs, fixed.handlerMs],
      ["Frame interval p95, hover sweep on a static chart, ms", shippedHover.p95, null, fixedHover.p95],
      ["Frame interval p95, hover sweep while re-rendering, ms", shippedHoverRender.p95, null, fixedHoverRender.p95],
    ],
    notes: [
      `Hit results on a 7 x 5 grid of probe points: ${mismatches === 0 ? "identical" : mismatches + " differ"} between the shipped code and the fix (${hits} of 35 are hits).`,
      "Counts do not depend on hardware; times do, and they include the counting hooks on get() and GetCoordinate, which make each embind call slower than in production. The fix keeps the 4 GetCoordinate calls per segment and the O(N) scan; only the get() calls and the two extra passes go away.",
      `On a static chart the Rollover markers only trigger SVG-only renders, which skip layout, so each move costs one scan. When the chart does a full render while the pointer is in the plot (streaming data, animations; simulated here with invalidateElement() each frame), RolloverModifier.onParentSurfaceLayoutComplete runs the scan again on every render: ${shippedHoverRender.scansPerFrame.toFixed(1)} scans per frame.`,
    ],
    metrics: { segments: SEGMENTS, shipped, zoomed, fixed, shippedHover, shippedHoverRender, fixedHover, fixedHoverRender, mismatches, hits, coordOwners },
  });
}
