const META = {
  id: "026",
  title: "3D tooltip and hover hit tests repeat the same selection-buffer lookup once per series",
  issue: "issues/026-3d-hittest-reads-selection-buffer-per-series.md",
  severity: "medium",
  claim: "A selection-buffer pixel holds one entity id, yet TooltipModifier3D and SeriesSelectionModifier3D hit-test every series at every sample pixel (17 pixels per hover miss), on each pointer move and again on each render. Each hit test is several wasm calls plus JS allocations, so the work grows with series count.",
  method: "<p>10 ScatterRenderableSeries3D x 200 sphere markers, TooltipModifier3D and SeriesSelectionModifier3D({ enableHover: true }) with default hitTestRadius 2. The pointer sweeps across the chart, one pointermove per frame for 120 frames. Per frame the demo counts series.hitTest() calls (split by the modifier that made them), wasm SCRTGetSelectionInfo and SCRTSetActiveWorld calls, and the sample pixels looked up (tooltip updates + SeriesSelectionModifier3D.hitTestAtPointAllSeries calls).</p><p>A/B: the issue's fix is applied at runtime: for each sample pixel, read the selection info once, find the series that owns the entity id, and hit-test only that series (hitTestAtPointAllSeries on the selection modifier, and an owner-only getIncludedRenderableSeries on the tooltip instance). The same sweep runs again, and the demo checks that hover and tooltip results are identical frame by frame. Patches are removed afterwards.</p>",
};

async function demo(P) {
  const { NumericAxis3D, ScatterRenderableSeries3D, XyzDataSeries3D, SpherePointMarker3D, TooltipModifier3D, SeriesSelectionModifier3D,
    Vector3 } = P.SciChart;
  const SERIES = 10, POINTS = 200, FRAMES = 120;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"];

  const { sciChart3DSurface: scs, wasmContext: wasm } = await P.createSurface3D("chart", { worldDimensions: new Vector3(200, 200, 200) });
  scs.xAxis = new NumericAxis3D(wasm); scs.yAxis = new NumericAxis3D(wasm); scs.zAxis = new NumericAxis3D(wasm);
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const series = [];
  for (let s = 0; s < SERIES; s++) {
    const xs = [], ys = [], zs = [];
    for (let i = 0; i < POINTS; i++) { xs.push(rnd()); ys.push(rnd()); zs.push(rnd()); }
    const rs = new ScatterRenderableSeries3D(wasm, {
      dataSeries: new XyzDataSeries3D(wasm, { xValues: xs, yValues: ys, zValues: zs }),
      pointMarker: new SpherePointMarker3D(wasm, { size: 6, fill: COLORS[s] }),
    });
    scs.renderableSeries.add(rs);
    series.push(rs);
  }
  const tooltip = new TooltipModifier3D();
  const selection = new SeriesSelectionModifier3D({ enableHover: true });
  scs.chartModifiers.add(tooltip);
  scs.chartModifiers.add(selection);
  await P.sleep(800);

  // Attribute hit tests to the modifier that makes them.
  let who = "other", modifierMs = 0;
  const wrapScope = (proto, method, label) => {
    const orig = proto[method];
    proto[method] = function () {
      const prev = who; who = label;
      const t0 = P.now();
      try { return orig.apply(this, arguments); } finally {
        who = prev;
        if (prev === "other") modifierMs += P.now() - t0; // outermost scope only
      }
    };
    return () => { proto[method] = orig; };
  };
  const undoScopes = [
    wrapScope(TooltipModifier3D.prototype, "update", "tooltip"),
    wrapScope(SeriesSelectionModifier3D.prototype, "updateHoverState", "hover"),
  ];
  series.forEach((rs) => P.hookMethod(rs, "hitTest", { name: "series hitTest()", onCall: () => P.count("hitTest from " + who) }));
  P.hookMethod(TooltipModifier3D.prototype, "update", { name: "tooltip update()" });
  P.hookMethod(SeriesSelectionModifier3D.prototype, "hitTestAtPointAllSeries", { name: "hover sample pixels" });
  P.watchEmbind(wasm, ["SCRTGetSelectionInfo", "SCRTSetActiveWorld"]);
  P.hookMethod(scs.sciChart3DRenderer, "render", { name: "3D render()" });

  const pointer = P.pointer(scs);
  async function sweep(label, animate) {
    const trace = [];
    const yaw0 = scs.camera.orbitalYaw;
    pointer.enter(0.1, 0.5);
    await P.idleFrames(3);
    modifierMs = 0;
    const r = await P.frames(FRAMES, (i) => {
      if (animate) scs.camera.orbitalYaw = yaw0 + 0.5 * (i + 1);
      pointer.move(pointer.sweepX(i, 60), 0.47 + 0.06 * Math.sin(i / 7));
      const hov = selection.hoveredSeries[0];
      const si = tooltip.tooltipAnnotation && tooltip.tooltipAnnotation.seriesInfo;
      trace.push((hov ? series.indexOf(hov) : -1) + ":" + (si && si.isHit ? series.indexOf(si.renderableSeries) + "/" + si.dataSeriesIndex : "-"));
    });
    pointer.leave();
    if (animate) scs.camera.orbitalYaw = yaw0;
    await P.idleFrames(5);
    const samples = r.total("tooltip update()") + r.total("hover sample pixels");
    const res = {
      rendersPerFrame: r.perFrame("3D render()"),
      hitTests: r.perFrame("series hitTest()"),
      fromTooltip: r.perFrame("hitTest from tooltip"),
      fromHover: r.perFrame("hitTest from hover"),
      selectionReads: r.perFrame("wasm SCRTGetSelectionInfo"),
      setActiveWorld: r.perFrame("wasm SCRTSetActiveWorld"),
      samplePixels: samples / FRAMES,
      readsPerSample: samples ? r.total("wasm SCRTGetSelectionInfo") / samples : 0,
      modifierMs: modifierMs / FRAMES,
      hoverHitFrames: trace.filter((t) => !t.startsWith("-1")).length,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return { res, trace };
  }

  P.status("Sweeping the pointer, library as shipped…");
  const shipped = await sweep("static camera, as shipped", false);
  P.status("Sweeping the pointer while the camera turns, library as shipped…");
  const shippedOrbit = await sweep("camera turning, as shipped", true);

  // The issue's fix: one selection read per sample pixel, then hit-test only the owning series.
  const ownerAt = (surface, list, point) => {
    surface.prepareSelectionBuffer();
    const sel = wasm.SCRTGetSelectionInfo(Math.round(point.x), Math.round(point.y));
    const entity = sel.GetEntity();
    const id = entity ? entity.GetEntityId() : undefined;
    if (id === undefined) return undefined;
    return list.find((rs) => rs.sceneEntity && rs.sceneEntity.entityId === id);
  };
  const selProto = SeriesSelectionModifier3D.prototype;
  const origAllSeries = selProto.hitTestAtPointAllSeries;
  selProto.hitTestAtPointAllSeries = function (allSeries, point) {
    P.count("hover sample pixels");
    const owner = ownerAt(this.parentSurface, allSeries, point);
    const hit = owner ? owner.hitTest(point) : undefined;
    return hit && hit.isHit ? [hit] : [];
  };
  tooltip.getIncludedRenderableSeries = function () {
    const all = TooltipModifier3D.prototype.getIncludedRenderableSeries.call(this); // the inherited, unpatched method
    const owner = this.mousePoint ? ownerAt(this.parentSurface, all, this.mousePoint) : undefined;
    return owner ? [owner] : [];
  };
  P.status("Sweeping the pointer, one selection read per sample pixel…");
  const fixed = await sweep("static camera, one read per pixel", false);
  P.status("Sweeping the pointer while the camera turns, one selection read per sample pixel…");
  const fixedOrbit = await sweep("camera turning, one read per pixel", true);
  selProto.hitTestAtPointAllSeries = origAllSeries;
  delete tooltip.getIncludedRenderableSeries;
  undoScopes.forEach((u) => u());

  const sameTrace = (x, y) => x.trace.length === y.trace.length && x.trace.every((t, i) => t === y.trace[i]);
  const same = sameTrace(shipped, fixed) && sameTrace(shippedOrbit, fixedOrbit);
  const s = shipped.res, f = fixed.res, so = shippedOrbit.res, fo = fixedOrbit.res;
  const reproduced = s.readsPerSample >= SERIES * 0.8 && so.readsPerSample >= SERIES * 0.8 && f.readsPerSample <= 2 && fo.readsPerSample <= 2 && s.selectionReads >= f.selectionReads * 3;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Every sample pixel costs ${s.readsPerSample.toFixed(1)} selection-buffer reads with ${SERIES} series: a hover sweep makes ${s.hitTests.toFixed(0)} hit tests per frame, ${so.hitTests.toFixed(0)} while the camera turns (render pass repeats them). SCRTGetSelectionInfo calls per frame: ${s.selectionReads.toFixed(0)} and ${so.selectionReads.toFixed(0)}. Reading each pixel once and hit-testing only its owner: ${f.selectionReads.toFixed(0)} and ${fo.selectionReads.toFixed(0)}, ${same ? "with identical hover and tooltip results" : "but hover/tooltip results differed"}.`
      : `Expected about ${SERIES} selection reads per sample pixel; measured ${s.readsPerSample.toFixed(2)} as shipped and ${f.readsPerSample.toFixed(2)} with the fix.`,
    columns: ["Static camera, as shipped", "Static camera, fix", "Camera turning, as shipped", "Camera turning, fix"],
    rows: [
      ["Renders per frame", s.rendersPerFrame, f.rendersPerFrame, so.rendersPerFrame, fo.rendersPerFrame],
      ["Sample pixels looked up per frame (tooltip + hover)", s.samplePixels, f.samplePixels, so.samplePixels, fo.samplePixels],
      ["series.hitTest() calls per frame", s.hitTests, f.hitTests, so.hitTests, fo.hitTests],
      ["  of which from TooltipModifier3D", s.fromTooltip, f.fromTooltip, so.fromTooltip, fo.fromTooltip],
      ["  of which from SeriesSelectionModifier3D hover", s.fromHover, f.fromHover, so.fromHover, fo.fromHover],
      ["wasm SCRTGetSelectionInfo calls per frame", s.selectionReads, f.selectionReads, so.selectionReads, fo.selectionReads],
      ["wasm SCRTSetActiveWorld calls per frame", s.setActiveWorld, f.setActiveWorld, so.setActiveWorld, fo.setActiveWorld],
      ["Selection reads per sample pixel", s.readsPerSample, f.readsPerSample, so.readsPerSample, fo.readsPerSample],
      ["Frames with a hovered series (of " + FRAMES + ")", s.hoverHitFrames, f.hoverHitFrames, so.hoverHitFrames, fo.hoverHitFrames],
      ["Time in tooltip update() + hover updateHoverState() per frame, ms (includes the per-call counters' overhead)", s.modifierMs, f.modifierMs, so.modifierMs, fo.modifierMs],
      ["Frame interval p95, ms", s.p95, f.p95, so.p95, fo.p95],
    ],
    notes: [
      "Each frame has one pointermove; with the camera turning (as during an orbit drag) it also has one render, and both modifiers repeat their hit tests in onParentSurfaceRendered. A hover miss samples 17 pixels (hitTestRadius 2), each across all 10 series. With the fix a miss costs one read per pixel and a hit two (owner lookup plus the owner's own hitTest).",
      same ? "Hover and tooltip results (hovered series, hit series and point index) were recorded every frame and are identical with and without the fix." : "Hover or tooltip results differed between the runs; see the log.",
      "The issue's review found no GPU sync per call: the cost is wasm boundary crossings and garbage, so it shows as call counts here and as main-thread time on slower machines. Counts do not depend on hardware; times do.",
    ],
    metrics: { shipped: s, fixed: f, shippedOrbit: so, fixedOrbit: fo, sameResults: same },
  });
}
