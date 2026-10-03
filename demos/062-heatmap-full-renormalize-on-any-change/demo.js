const META = {
  id: "062",
  title: "Heatmap data series re-normalizes every cell after any change: one setZValue or an xStart scroll",
  issue: "issues/062-heatmap-full-renormalize-on-any-change.md",
  severity: "medium",
  claim: "BaseHeatmapDataSeries keeps one dirty flag. Any notification, including a single setZValue or an xStart/xStep change that leaves z untouched, makes the next draw run recreateNormalizedVector: a JS loop over all W x H cells plus one copy per row into wasm.",
  method: "<p>A 1000 x 1000 UniformHeatmapDataSeries (1,000,000 cells) drawn by a UniformHeatmapRenderableSeries. Scenario 1: 100 <code>setZValue</code> calls per frame (40 frames). Scenario 2: the heatmap scrolled by <code>xStart</code> every frame (40 frames). The demo counts <code>recreateNormalizedVector</code> calls and the cells each one normalizes, and times them; it also counts the per-draw texture fill (<code>SCRTFillTextureFloat32</code>), which is a separate cost the same in every column.</p><p>A/B: (1) the issue's library fix applied as a runtime patch (dirty-cell list filled by <code>setZValue</code>, a one-shot flag that keeps geometry setters from marking z dirty, and <code>getNormalizedVector</code> re-normalizing only the dirty cells); (2) for scrolling, the issue's app-side workaround: move the X axis <code>visibleRange</code> instead of <code>xStart</code>. After the patched sparse run the demo compares the incrementally updated normalized vector with a full recompute.</p>",
};

async function demo(P) {
  const { NumericAxis, UniformHeatmapDataSeries, UniformHeatmapRenderableSeries, HeatmapColorMap, NumberRange, EDataChangeType, vectorToArrayViewF32 } = P.SciChart;
  const W = 1000, H = 1000, CELLS_PER_FRAME = 100, FRAMES = 40;

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  const xAxis = new NumericAxis(wasmContext, { visibleRange: new NumberRange(-60, W + 20) });
  sciChartSurface.xAxes.add(xAxis);
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { visibleRange: new NumberRange(0, H) }));
  const zValues = [];
  for (let y = 0; y < H; y++) {
    const row = new Array(W);
    for (let x = 0; x < W; x++) row[x] = 50 + 25 * Math.sin(x / 70) + 25 * Math.cos(y / 45);
    zValues.push(row);
  }
  const ds = new UniformHeatmapDataSeries(wasmContext, { xStart: 0, xStep: 1, yStart: 0, yStep: 1, zValues });
  const colorMap = new HeatmapColorMap({ minimum: 0, maximum: 100, gradientStops: [
    { offset: 0, color: "#1d2330" }, { offset: 0.35, color: "#4e79a7" }, { offset: 0.7, color: "#edc948" }, { offset: 1, color: "#e15759" },
  ] });
  const rs = new UniformHeatmapRenderableSeries(wasmContext, { dataSeries: ds, colorMap });
  sciChartSurface.renderableSeries.add(rs);
  await P.sleep(600);

  // Counters.
  const baseProto = Object.getPrototypeOf(UniformHeatmapDataSeries.prototype); // BaseHeatmapDataSeries (not exported)
  sciChartSurface.rendered.subscribe(() => P.count("renders"));
  P.hookMethod(baseProto, "recreateNormalizedVector", { name: "full renormalizations", time: true, bytes: (a, ret, self) => self.arrayWidth * self.arrayHeight });
  P.watchEmbind(wasmContext, ["SCRTFillTextureFloat32"]);

  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  async function run(label, perFrame) {
    await P.idleFrames(3);
    const r = await P.frames(FRAMES, perFrame);
    await P.idleFrames(2);
    const res = {
      renders: r.total("renders"),
      full: r.total("full renormalizations") / FRAMES,
      cells: (r.total("full renormalizations", "bytes") + r.total("cells renormalized (dirty list)")) / FRAMES,
      ms: r.total("full renormalizations", "t") / FRAMES,
      fills: r.total("wasm SCRTFillTextureFloat32") / FRAMES,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }
  const sparse = () => { for (let k = 0; k < CELLS_PER_FRAME; k++) ds.setZValue(Math.floor(rnd() * H), Math.floor(rnd() * W), rnd() * 100); };
  let x0 = 0;
  const scrollXStart = () => { ds.xStart = --x0; };
  let v0 = 0;
  const scrollAxis = () => { v0++; xAxis.visibleRange = new NumberRange(-60 + v0, W + 20 + v0); };

  P.status("100 setZValue per frame, as shipped…");
  const sparseShipped = await run("sparse, as shipped", sparse);
  P.status("Scrolling by xStart, as shipped…");
  const xsShipped = await run("xStart scroll, as shipped", scrollXStart);
  P.status("Scrolling by the X axis visibleRange (workaround)…");
  const axisScroll = await run("visibleRange scroll (workaround)", scrollAxis);

  // The issue's fix, as a runtime patch.
  const orig = { setZValue: baseProto.setZValue, notify: baseProto.notifyDataChanged, getNV: baseProto.getNormalizedVector };
  const geom = ["xStart", "xStep", "yStart", "yStep"].map((p) => [p, Object.getOwnPropertyDescriptor(UniformHeatmapDataSeries.prototype, p)]);
  const normalizeZ = (zValueRaw, zMin, zMax, newZMin, factor, fill) => {
    let zValue = zValueRaw - newZMin;
    if (zValueRaw !== zValueRaw) zValue = 0;
    else if (zValue < zMin - newZMin) zValue = fill ? zMin - newZMin : 0;
    else if (zValue > zMax - newZMin) zValue = fill ? zMax - newZMin : 0;
    return zValue * factor;
  };
  baseProto.setZValue = function (yIndex, xIndex, zValue, metadata) {
    this.zValuesProperty[yIndex][xIndex] = zValue;
    this.setMetadataAt(yIndex, xIndex, metadata);
    if (!this.dirtyCells) this.dirtyCells = [];
    if (!this.hasDataChangesProperty && this.dirtyCells.length < (this.arrayWidth * this.arrayHeight) / 8) {
      this.dirtyCells.push(yIndex * this.arrayWidth + xIndex);
      this.zUnchangedNotify = true; // tracked cell: no full pass
    }
    this.notifyDataChanged(EDataChangeType.Update, xIndex, yIndex);
  };
  baseProto.notifyDataChanged = function (changeType, xIndex, yIndex, name) {
    this.changeCountProperty++;
    if (this.zUnchangedNotify) this.zUnchangedNotify = false;
    else { this.hasDataChangesProperty = true; if (this.dirtyCells) this.dirtyCells.length = 0; }
    this.dataChanged.raiseEvent({ changeType, index: xIndex, yIndex, name });
  };
  baseProto.getNormalizedVector = function (cm, fill) {
    const size = this.arrayWidth * this.arrayHeight;
    if (this.hasDataChangesProperty || size !== this.normalizedVector.size() || cm.minimum !== this.lastZMin || cm.maximum !== this.lastZMax || fill !== this.lastFillValuesOutOfRange) {
      const v = orig.getNV.call(this, cm, fill);
      if (this.dirtyCells) this.dirtyCells.length = 0;
      return v;
    }
    if (this.dirtyCells && this.dirtyCells.length > 0) {
      const zMin = cm.minimum, zMax = cm.maximum, newZMin = this.hasNaNs ? zMin - (zMax - zMin) / 128 : zMin, factor = 1.0 / (zMax - newZMin);
      const view = vectorToArrayViewF32(this.normalizedVector, this.webAssemblyContext), w = this.arrayWidth;
      for (const cell of this.dirtyCells) { const y = (cell / w) | 0; view[cell] = normalizeZ(this.zValuesProperty[y][cell - y * w], zMin, zMax, newZMin, factor, fill); }
      P.count("cells renormalized (dirty list)", this.dirtyCells.length);
      this.dirtyCells.length = 0;
    }
    return this.normalizedVector;
  };
  geom.forEach(([p, d]) => Object.defineProperty(UniformHeatmapDataSeries.prototype, p, { ...d, set(v) { this.zUnchangedNotify = true; d.set.call(this, v); } }));

  P.status("100 setZValue per frame, with the fix…");
  const sparseFixed = await run("sparse, with fix", sparse);
  // Correctness: incrementally updated vector vs a full recompute of the same z values.
  const pending = ds.dirtyCells ? ds.dirtyCells.length : 0;
  const snapshot = Float32Array.from(vectorToArrayViewF32(ds.normalizedVector, wasmContext));
  ds.recreateNormalizedVector(colorMap.minimum, colorMap.maximum, rs.fillValuesOutOfRange);
  const full = vectorToArrayViewF32(ds.normalizedVector, wasmContext);
  let mismatches = 0;
  for (let i = 0; i < full.length; i++) if (full[i] !== snapshot[i]) mismatches++;
  P.log(`fix check: ${mismatches} of ${full.length} normalized cells differ from a full recompute (pending dirty cells: ${pending})`);
  P.status("Scrolling by xStart, with the fix…");
  const xsFixed = await run("xStart scroll, with fix", scrollXStart);

  // Restore.
  baseProto.setZValue = orig.setZValue;
  baseProto.notifyDataChanged = orig.notify;
  baseProto.getNormalizedVector = orig.getNV;
  geom.forEach(([p, d]) => Object.defineProperty(UniformHeatmapDataSeries.prototype, p, d));

  const cells = W * H;
  const reproduced = sparseShipped.full >= 0.9 && sparseShipped.cells >= 0.9 * cells && xsShipped.full >= 0.9
    && sparseFixed.full === 0 && sparseFixed.cells <= CELLS_PER_FRAME * 1.05 && xsFixed.full === 0 && axisScroll.full === 0 && mismatches === 0 && pending === 0;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `${CELLS_PER_FRAME} setZValue calls per frame re-normalize all ${cells.toLocaleString("en-US")} cells every frame (${sparseShipped.ms.toFixed(1)} ms), and so does scrolling by xStart (no z change). With the dirty-cell fix: ${Math.round(sparseFixed.cells)} cells per frame and none for the scroll, identical result; scrolling the axis instead of xStart also avoids it.`
      : `Expected one full ${cells.toLocaleString("en-US")}-cell pass per frame after sparse or geometry-only changes; measured ${sparseShipped.full.toFixed(2)} (sparse) and ${xsShipped.full.toFixed(2)} (xStart) full passes per frame; fix: ${sparseFixed.full.toFixed(2)} / ${xsFixed.full.toFixed(2)}, ${mismatches} mismatches.`,
    columns: ["As shipped", "With fix"],
    rows: [
      ["Sparse: cells changed by setZValue per frame", CELLS_PER_FRAME, CELLS_PER_FRAME],
      ["Sparse: full recreateNormalizedVector passes per frame", sparseShipped.full, sparseFixed.full],
      ["Sparse: cells normalized per frame", sparseShipped.cells, sparseFixed.cells],
      ["Sparse: time in full passes per frame, ms", sparseShipped.ms, sparseFixed.ms],
      ["Scroll by xStart: full passes per frame", xsShipped.full, xsFixed.full],
      ["Scroll by xStart: cells normalized per frame", xsShipped.cells, xsFixed.cells],
      ["Scroll by X axis visibleRange (workaround): full passes per frame", axisScroll.full, null],
      ["Texture fills per frame (SCRTFillTextureFloat32, separate issue)", sparseShipped.fills, sparseFixed.fills],
      ["Frame interval p95, ms: sparse", sparseShipped.p95, sparseFixed.p95],
      ["Frame interval p95, ms: xStart scroll", xsShipped.p95, xsFixed.p95],
    ],
    notes: [
      `Fix check: after the patched sparse run, ${mismatches} of ${cells.toLocaleString("en-US")} normalized values differ from a full recompute of the same z values.`,
      "The drawing provider still uploads the whole W x H texture on every draw in every column (the texture-fill row); that is a separate issue in the drawing provider. Counts do not depend on hardware; times do.",
    ],
    metrics: { sparseShipped, sparseFixed, xsShipped, xsFixed, axisScroll, cells, mismatches, pending },
  });
}
