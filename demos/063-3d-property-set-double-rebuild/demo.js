const META = {
  id: "063",
  title: "3D point-line/column style setters rebuild the whole series synchronously, then again next frame",
  issue: "issues/063-3d-series-property-set-rebuilds-mesh-twice.md",
  severity: "medium",
  claim: "PointLine3DSceneEntity (and the scatter/column entities) call updateSeries() inside notifySeriesPropertyChanged, then also set the dirty flag that makes the next frame call updateSeries() again. k style sets in one handler cost k+1 full O(N) rebuilds, and a column series with fill re-notifies itself from every rebuild, costing one extra frame.",
  method: "<p><b>Part 1</b>: PointLineRenderableSeries3D with 100,000 points and an EllipsePointMarker3D. A 'theme switch' handler sets stroke, strokeThickness and pointMarker.size in one task, 5 times, 10 frames apart. The demo counts PointLine3DSceneEntity.updateSeries() calls inside the handler (synchronous) and in the frames after it, the points walked by rebuildPointMetadata, and the handler's own duration.</p><p><b>Part 2</b>: the same chart then shows a ColumnRenderableSeries3D (2,500 columns) with series.fill set. The app appends one column 5 times, 10 frames apart; the demo counts renders and column rebuilds per append.</p><p>A/B: Part 1 again with the issue's fix (notifySeriesPropertyChanged only sets the flag, patched onto PointLine3DSceneEntity.prototype); Part 2 again with an equality guard on the point marker's fill setter, which stops the redundant write in ColumnSceneEntity.updateSeries from notifying (same effect as the issue's guard). Patches are removed afterwards.</p>",
};

async function demo(P) {
  const { NumericAxis3D, PointLineRenderableSeries3D, ColumnRenderableSeries3D, XyzDataSeries3D, EllipsePointMarker3D, PointLine3DSceneEntity, ColumnSceneEntity,
    RenderableSeriesSceneEntity, BasePointMarker3D, Vector3 } = P.SciChart;
  const N = 100000, CLICKS = 5, APPENDS = 5;

  const { sciChart3DSurface: scs, wasmContext: wasm } = await P.createSurface3D("chart", { worldDimensions: new Vector3(200, 200, 200) });
  scs.xAxis = new NumericAxis3D(wasm); scs.yAxis = new NumericAxis3D(wasm); scs.zAxis = new NumericAxis3D(wasm);
  const xs = new Array(N), ys = new Array(N), zs = new Array(N);
  for (let i = 0; i < N; i++) { const t = i / N * 40 * Math.PI; xs[i] = Math.cos(t) * (1 + i / N); ys[i] = i / N; zs[i] = Math.sin(t) * (1 + i / N); }
  const line = new PointLineRenderableSeries3D(wasm, {
    dataSeries: new XyzDataSeries3D(wasm, { xValues: xs, yValues: ys, zValues: zs }),
    stroke: "#4e79a7", strokeThickness: 2,
    pointMarker: new EllipsePointMarker3D(wasm, { size: 2, fill: "#4e79a7" }),
  });
  scs.renderableSeries.add(line);
  await P.sleep(1000);

  P.hookMethod(PointLine3DSceneEntity.prototype, "updateSeries", { name: "line updateSeries()", time: true });
  P.hookMethod(ColumnSceneEntity.prototype, "updateSeries", { name: "column updateSeries()" });
  P.hookMethod(line.sceneEntity, "rebuildPointMetadata", { name: "line rebuildPointMetadata()", bytes: (a) => a[3] });
  P.hookMethod(scs.sciChart3DRenderer, "render", { name: "3D render()" });
  const n = (name, field) => (P.snap()[name] || { n: 0, t: 0, bytes: 0 })[field || "n"];

  const themes = [["#e15759", 3, 3], ["#4e79a7", 2, 2]];
  async function styleClicks(label) {
    let sync = 0, total = 0, walked = 0, handlerMs = 0, renders = 0;
    for (let c = 0; c < CLICKS; c++) {
      const [stroke, thickness, size] = themes[c % 2];
      const u0 = n("line updateSeries()"), w0 = n("line rebuildPointMetadata()", "bytes"), r0 = n("3D render()");
      const t0 = P.now();
      line.stroke = stroke;             // one "theme switch" handler: three style sets in one task
      line.strokeThickness = thickness;
      line.pointMarker.size = size;
      handlerMs += P.now() - t0;
      sync += n("line updateSeries()") - u0;
      await P.idleFrames(10);
      total += n("line updateSeries()") - u0;
      walked += n("line rebuildPointMetadata()", "bytes") - w0;
      renders += n("3D render()") - r0;
    }
    const res = { syncPerClick: sync / CLICKS, framePerClick: (total - sync) / CLICKS, totalPerClick: total / CLICKS, walkedPerClick: walked / CLICKS, handlerMs: handlerMs / CLICKS, rendersPerClick: renders / CLICKS };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Part 1: three style sets per click, as shipped…");
  const lineShipped = await styleClicks("point-line, as shipped");
  const plProto = PointLine3DSceneEntity.prototype;
  const plOwn = Object.prototype.hasOwnProperty.call(plProto, "notifySeriesPropertyChanged");
  const plOrig = plProto.notifySeriesPropertyChanged;
  plProto.notifySeriesPropertyChanged = function (propertyName) {
    // the issue's fix: only set the dirty flag; the next frame's Update() rebuilds once
    RenderableSeriesSceneEntity.prototype.notifySeriesPropertyChanged.call(this, propertyName);
  };
  P.status("Part 1: three style sets per click, flag only (fix)…");
  const lineFixed = await styleClicks("point-line, flag only");
  if (plOwn) plProto.notifySeriesPropertyChanged = plOrig; else delete plProto.notifySeriesPropertyChanged;

  // ---- Part 2: columns with series.fill on the same chart
  P.status("Part 2: switching to a column series…");
  scs.renderableSeries.clear();
  const cx = [], cy = [], cz = [];
  for (let x = 0; x < 50; x++) for (let z = 0; z < 50; z++) { cx.push(x); cz.push(z); cy.push(1 + Math.sin(x / 6) * Math.cos(z / 6)); }
  const columnsDs = new XyzDataSeries3D(wasm, { xValues: cx, yValues: cy, zValues: cz });
  const columns = new ColumnRenderableSeries3D(wasm, { dataSeries: columnsDs, fill: "#59a14f" });
  scs.renderableSeries.add(columns);
  await P.sleep(800);

  async function appends(label) {
    let renders = 0, rebuilds = 0;
    for (let a = 0; a < APPENDS; a++) {
      const r0 = n("3D render()"), u0 = n("column updateSeries()");
      columnsDs.appendRange([50 + a], [1], [25]);
      await P.idleFrames(10);
      renders += n("3D render()") - r0;
      rebuilds += n("column updateSeries()") - u0;
    }
    const res = { rendersPerAppend: renders / APPENDS, rebuildsPerAppend: rebuilds / APPENDS };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }
  P.status("Part 2: one appendRange at a time, as shipped…");
  const colShipped = await appends("columns, as shipped");
  let owner = BasePointMarker3D.prototype, fillDesc;
  while (owner && !(fillDesc = Object.getOwnPropertyDescriptor(owner, "fill"))) owner = Object.getPrototypeOf(owner);
  Object.defineProperty(owner, "fill", {
    configurable: true, enumerable: fillDesc.enumerable, get: fillDesc.get,
    set(v) { if (this.fillProperty === v) return; fillDesc.set.call(this, v); },
  });
  P.status("Part 2: one appendRange at a time, fill write guarded…");
  const colFixed = await appends("columns, fill guarded");
  Object.defineProperty(owner, "fill", fillDesc);

  const reproduced = lineShipped.syncPerClick >= 2.5 && lineShipped.totalPerClick >= 3.5 && lineFixed.syncPerClick === 0 && lineFixed.totalPerClick <= 1.2;
  const colExtra = colShipped.rendersPerAppend >= 1.8 && colFixed.rendersPerAppend <= 1.2;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Three style sets in one handler rebuilt the ${N.toLocaleString("en-US")}-point series ${lineShipped.totalPerClick.toFixed(1)} times (${lineShipped.syncPerClick.toFixed(1)} inside the handler, ${lineShipped.framePerClick.toFixed(1)} next frame); only the last one is drawn. Flag only: ${lineFixed.totalPerClick.toFixed(1)}. Columns with fill: ${colShipped.rendersPerAppend.toFixed(1)} renders per append (${colFixed.rendersPerAppend.toFixed(1)} with the fill guard)${colExtra ? "" : ", extra frame not seen"}.`
      : `Expected 3 synchronous rebuilds plus 1 per frame for 3 style sets; measured ${lineShipped.syncPerClick.toFixed(2)} + ${lineShipped.framePerClick.toFixed(2)} (fix: ${lineFixed.syncPerClick.toFixed(2)} + ${lineFixed.framePerClick.toFixed(2)}).`,
    columns: ["As shipped", "With fix"],
    rows: [
      ["Point-line: style sets per click", 3, 3],
      ["  updateSeries() inside the handler (synchronous)", lineShipped.syncPerClick, lineFixed.syncPerClick],
      ["  updateSeries() in the next frames", lineShipped.framePerClick, lineFixed.framePerClick],
      ["  points walked by rebuildPointMetadata per click", lineShipped.walkedPerClick, lineFixed.walkedPerClick],
      ["  renders per click", lineShipped.rendersPerClick, lineFixed.rendersPerClick],
      ["  handler duration, ms", lineShipped.handlerMs, lineFixed.handlerMs],
      ["Columns with series.fill: renders per appendRange", colShipped.rendersPerAppend, colFixed.rendersPerAppend],
      ["  column rebuilds per appendRange", colShipped.rebuildsPerAppend, colFixed.rebuildsPerAppend],
    ],
    notes: [
      "Each synchronous rebuild is the full data path (strokeDashArray copy, rebuildPointMetadata over all points, native UpdateMeshesVec) inside the caller's input task, and the frame-time rebuild overwrites it before anything is drawn. The handler duration is what an INP measurement sees; it depends on hardware, the counts do not.",
      "Column part: ColumnSceneEntity.updateSeries writes pointMarker.fill = series.fill on every rebuild; the setter has no equality check, so the series notifies 'pointMarker.fill' and invalidates the surface from inside the frame, which costs one more render with no rebuild.",
    ],
    metrics: { N, lineShipped, lineFixed, colShipped, colFixed },
  });
}
