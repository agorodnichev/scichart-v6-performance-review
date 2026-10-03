const META = {
  id: "025",
  title: "DataPointSelectionModifier gives every point its own metadata object, on attach and on every append, even after removal",
  issue: "issues/025-datapointselection-per-point-metadata-objects.md",
  severity: "high",
  claim: "On attach, DataPointSelectionModifier installs a TemplateMetadataGenerator({ isSelected: false }) on each series, which creates one object per existing point and then one per appended point on every later append. The generator is never removed, so the allocations continue after the modifier is removed, and series added later get it even when excludedSeriesIds lists them.",
  method: "<p><b>Attach:</b> a 250,000-point line series, then DataPointSelectionModifier is added. The demo counts TemplateMetadataGenerator.getSingleMetadata calls (each returns a new object), getMetadataAt calls and wasm SCRTDoubleVector.size calls made by the attach, the distinct objects left in the series' metadata array, and the attach time.</p><p><b>Streaming:</b> a FIFO series (capacity 20,000, full) receives appendRange of 1,000 points per frame for 60 frames: before any modifier, with the modifier attached, and after chartModifiers.remove(modifier, true). <b>Excluded series:</b> with a modifier built with excludedSeriesIds, one excluded series exists at attach and another is added afterwards.</p><p><b>A/B:</b> the attach and streaming runs are repeated on fresh series with the issue's generator change applied at runtime: DataPointSelectionModifier.onAttachSeries first installs a generator that returns one shared frozen { isSelected: false } record. The issue's copy-on-write changes to the selection write sites are not applied, so the demo does not select points in that run. The original method is restored afterwards.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, DataPointSelectionModifier, TemplateMetadataGenerator, EDataSeriesType } = P.SciChart;
  const N_STATIC = 250000, N_LATE = 50000, FIFO = 20000, BATCH = 1000, FRAMES = 60;

  // BaseDataSeries is not exported by the UMD bundle: find the prototype that owns a method.
  const ownerOf = (proto, name) => { while (proto && !Object.prototype.hasOwnProperty.call(proto, name)) proto = Object.getPrototypeOf(proto); return proto; };
  P.hookMethod(TemplateMetadataGenerator.prototype, "getSingleMetadata", { name: "metadata objects created" });
  P.hookMethod(ownerOf(XyDataSeries.prototype, "getMetadataAt"), "getMetadataAt", { name: "getMetadataAt" });

  const top = await P.createSurface("chart");
  const wasmContext = top.wasmContext, chart = top.sciChartSurface;
  P.watchEmbind(wasmContext, ["SCRTDoubleVector.size"]);
  chart.xAxes.add(new NumericAxis(wasmContext));
  chart.yAxes.add(new NumericAxis(wasmContext));
  const { sciChartSurface: chart2 } = await P.createSurface("chart2");
  chart2.xAxes.add(new NumericAxis(wasmContext));
  chart2.yAxes.add(new NumericAxis(wasmContext));

  const staticSeries = (n, id) => {
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++) { xs[i] = i; ys[i] = Math.sin(i / 3000) + 0.2 * Math.sin(i / 97); }
    return new FastLineRenderableSeries(wasmContext, { id, stroke: "#4e79a7", strokeThickness: 1,
      dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: ys, isSorted: true, containsNaN: false }) });
  };
  let nextX = 0;
  const batch = (n) => {
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++, nextX++) { xs[i] = nextX; ys[i] = Math.sin(nextX / 400) + 0.1 * Math.sin(nextX / 13); }
    return { xs, ys };
  };
  const fifoSeries = () => {
    const ds = new XyDataSeries(wasmContext, { fifoCapacity: FIFO, isSorted: true, containsNaN: false });
    const b = batch(FIFO);
    ds.appendRange(b.xs, b.ys);
    return new FastLineRenderableSeries(wasmContext, { dataSeries: ds, stroke: "#f28e2b", strokeThickness: 1 });
  };
  const distinctMetadata = (ds) => (ds.metadataProperty ? new Set(ds.metadataProperty).size : 0);
  // Secondary: a full GC has to trace every live metadata object. Only where the page can force a GC
  // (the headless verifier passes --expose-gc); elsewhere this row shows "–".
  async function fullGcMs() {
    if (typeof window.gc !== "function") return null;
    const t = [];
    for (let i = 0; i < 5; i++) { await P.sleep(30); const t0 = P.now(); window.gc(); t.push(P.now() - t0); }
    return t.sort((a, b) => a - b)[2];
  }

  async function attach(surface, rs, label) {
    await P.idleFrames(2);
    const modifier = new DataPointSelectionModifier();
    const r = await P.during(() => surface.chartModifiers.add(modifier));
    const res = {
      objects: r.total("metadata objects created"),
      getMetadataAt: r.total("getMetadataAt"),
      wasmSize: r.total("wasm SCRTDoubleVector.size"),
      distinct: distinctMetadata(rs.dataSeries),
      slots: rs.dataSeries.metadataProperty ? rs.dataSeries.metadataProperty.length : 0,
      ms: r.ms,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return { modifier, res };
  }
  async function stream(rs, label) {
    const r = await P.frames(FRAMES, () => { const b = batch(BATCH); rs.dataSeries.appendRange(b.xs, b.ys); });
    const res = { objectsPerFrame: r.perFrame("metadata objects created"), distinct: distinctMetadata(rs.dataSeries), p95: r.frameP95 };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  // ---------------- as shipped
  P.status("Attaching DataPointSelectionModifier to a 250,000-point series…");
  const big = staticSeries(N_STATIC, "big");
  chart.renderableSeries.add(big);
  await P.sleep(400);
  const att = await attach(chart, big, "attach, as shipped");
  att.res.gcMs = await fullGcMs();
  chart.chartModifiers.remove(att.modifier, true);
  const keptAfterRemove = big.dataSeries.hasMetadataGenerator();

  P.status("Streaming 1,000 points per frame into a FIFO series…");
  const fifo = fifoSeries();
  chart2.renderableSeries.add(fifo);
  await P.sleep(300);
  const sNone = await stream(fifo, "stream, no modifier yet");
  const fifoAtt = await attach(chart2, fifo, "attach to the FIFO series, as shipped");
  const sWith = await stream(fifo, "stream, modifier attached");
  chart2.chartModifiers.remove(fifoAtt.modifier, true);
  const sAfter = await stream(fifo, "stream, modifier removed");

  P.status("Excluded series, present at attach and added later…");
  chart.renderableSeries.remove(big, true);
  const pre = staticSeries(N_LATE, "excluded-at-attach");
  chart.renderableSeries.add(pre);
  await P.idleFrames(3);
  const excl = new DataPointSelectionModifier({ excludedSeriesIds: ["excluded-at-attach", "excluded-added-later"] });
  const rPre = await P.during(() => chart.chartModifiers.add(excl));
  const late = staticSeries(N_LATE, "excluded-added-later");
  const rLate = await P.during(() => chart.renderableSeries.add(late));
  const exclusion = {
    atAttach: { objects: rPre.total("metadata objects created"), generator: pre.dataSeries.hasMetadataGenerator() },
    addedLater: { objects: rLate.total("metadata objects created"), generator: late.dataSeries.hasMetadataGenerator() },
  };
  P.log(`excluded series: ${JSON.stringify(exclusion)}`);
  chart.chartModifiers.remove(excl, true);
  chart.renderableSeries.remove(pre, true);
  chart.renderableSeries.remove(late, true);

  // ---------------- with the generator change from the issue's fix
  const UNSELECTED = Object.freeze({ isSelected: false });
  const sharedGenerator = { type: "Template", getSingleMetadata: () => UNSELECTED, getMetadata: () => undefined, toJSON: () => ({ isSelected: false }) };
  const DPS = DataPointSelectionModifier.prototype, shippedAttachSeries = DPS.onAttachSeries;
  DPS.onAttachSeries = function (rs) {
    const ds = rs.dataSeries;
    if (ds && ds.type !== EDataSeriesType.HeatmapUniform && !ds.hasMetadataGenerator()) ds.setMetadataGenerator(sharedGenerator);
    return shippedAttachSeries.call(this, rs);
  };
  P.status("Same attach and stream with one shared frozen record…");
  const big2 = staticSeries(N_STATIC, "big2");
  chart.renderableSeries.add(big2);
  await P.sleep(400);
  const attFix = await attach(chart, big2, "attach, with fix");
  attFix.res.gcMs = await fullGcMs();
  chart.chartModifiers.remove(attFix.modifier, true);
  chart2.renderableSeries.remove(fifo, true);
  const fifo2 = fifoSeries();
  chart2.renderableSeries.add(fifo2);
  await P.sleep(300);
  const fifoAttFix = await attach(chart2, fifo2, "attach to the FIFO series, with fix");
  const sWithFix = await stream(fifo2, "stream, modifier attached, with fix");
  chart2.chartModifiers.remove(fifoAttFix.modifier, true);
  DPS.onAttachSeries = shippedAttachSeries;

  const A = att.res, F = attFix.res;
  const reproduced = A.objects >= 0.99 * N_STATIC && A.distinct >= 0.99 * N_STATIC
    && sNone.objectsPerFrame === 0 && sWith.objectsPerFrame >= 0.99 * BATCH && sAfter.objectsPerFrame >= 0.99 * BATCH
    && F.objects === 0 && F.distinct <= 1 && sWithFix.objectsPerFrame === 0;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Attaching to a ${N_STATIC.toLocaleString("en-US")}-point series created ${A.objects.toLocaleString("en-US")} metadata objects (${A.ms.toFixed(0)} ms); streaming then allocates ${sWith.objectsPerFrame.toFixed(0)} objects per 1,000-point append, still ${sAfter.objectsPerFrame.toFixed(0)} after the modifier is removed. A series added later despite excludedSeriesIds got ${exclusion.addedLater.objects.toLocaleString("en-US")}. With one shared frozen record: ${F.objects} and ${sWithFix.objectsPerFrame}.`
      : `Expected one metadata object per point on attach and per appended point afterwards; measured ${A.objects} on attach of ${N_STATIC}, ${sWith.objectsPerFrame} / ${sAfter.objectsPerFrame} per ${BATCH}-point append with / after the modifier, ${F.objects} and ${sWithFix.objectsPerFrame} with the fix.`,
    columns: ["As shipped", "With fix (shared record)"],
    rows: [
      [`Attach to ${N_STATIC.toLocaleString("en-US")} points: metadata objects created`, A.objects, F.objects],
      ["  distinct objects in the metadata array afterwards", A.distinct, F.distinct],
      ["  metadata array slots", A.slots, F.slots],
      ["  getMetadataAt calls in the attach scan", A.getMetadataAt, F.getMetadataAt],
      ["  wasm SCRTDoubleVector.size calls during the attach", A.wasmSize, F.wasmSize],
      ["  attach time, ms", A.ms, F.ms],
      ["  forced full GC with that series alive, ms (median of 5)", A.gcMs, F.gcMs],
      [`FIFO stream, ${BATCH} points per frame: objects per frame before any modifier`, sNone.objectsPerFrame, null],
      ["  objects per frame with the modifier attached", sWith.objectsPerFrame, sWithFix.objectsPerFrame],
      ["  objects per frame after chartModifiers.remove(modifier, true)", sAfter.objectsPerFrame, null],
      ["  generator still installed after removal (static series)", keptAfterRemove ? "yes" : "no", null],
      ["  frame interval p95 with the modifier attached, ms", sWith.p95, sWithFix.p95],
      [`excludedSeriesIds, series present at attach (${N_LATE.toLocaleString("en-US")} points): objects`, exclusion.atAttach.objects, null],
      [`excludedSeriesIds, series added after the modifier (${N_LATE.toLocaleString("en-US")} points): objects`, exclusion.addedLater.objects, null],
    ],
    notes: [
      "Counts do not depend on hardware; times do. Each getSingleMetadata call of the shipped TemplateMetadataGenerator returns Object.assign({}, template), a new object that the series keeps (or, in a FIFO series, keeps until it is overwritten fifoCapacity points later). The shared-record generator returns the same frozen object, so the metadata array holds n references to one record.",
      "The attach scan (one getMetadataAt per point, each validating the index through a wasm size() call) is not changed by the fix and stays in both columns. The excluded-series rows run on the shipped library: excludedSeriesIds is honoured at attach but not for series added later, which pick up the per-point generator anyway.",
    ],
    metrics: { attach: A, attachFix: F, stream: { none: sNone, with: sWith, after: sAfter, withFix: sWithFix }, exclusion, keptAfterRemove, fifoAttach: fifoAtt.res, fifoAttachFix: fifoAttFix.res },
  });
}
