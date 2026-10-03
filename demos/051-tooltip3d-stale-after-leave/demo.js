const META = {
  id: "051",
  title: "TooltipModifier3D keeps hit-testing every series at a stale point after the pointer leaves",
  issue: "issues/051-tooltip3d-keeps-hittesting-after-pointer-leave.md",
  severity: "medium",
  claim: "TooltipModifier3D has no modifierMouseLeave override, so mousePoint keeps the last in-chart position. Every later render (animation, streaming data) hit-tests all series there and updates the tooltip, and over a surface mesh the render loop of issue 020 keeps running with the pointer off the chart.",
  method: "<p><b>Part 1, scatter</b>: 5 ScatterRenderableSeries3D x 300 points with a default TooltipModifier3D. The app animates the camera (camera.orbitalYaw += 0.5 per frame, 120 frames), so the chart renders every frame. The demo counts series.hitTest() calls and wasm SCRTGetSelectionInfo calls per rendered frame in three runs: the pointer never entered the chart; the pointer moved over the chart and then left (mouseleave), as shipped; the same with the issue's workaround, a modifierMouseLeave override that clears mousePoint and hides the tooltip and crosshair (patched onto TooltipModifier3D.prototype and removed afterwards).</p><p><b>Part 2, surface mesh</b>: the scatter series are replaced by a 50 x 50 SurfaceMeshRenderableSeries3D on the same chart. The pointer moves over the mesh and leaves; then, with no input at all, the demo counts renders and mesh hit tests per second, as shipped and with the same leave override.</p>",
};

async function demo(P) {
  const { NumericAxis3D, ScatterRenderableSeries3D, XyzDataSeries3D, SpherePointMarker3D, SurfaceMeshRenderableSeries3D, UniformGridDataSeries3D,
    GradientColorPalette, TooltipModifier3D, CameraController, Vector3, Point } = P.SciChart;
  const SERIES = 5, POINTS = 300, FRAMES = 120, WINDOW = 2000;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f"];

  const { sciChart3DSurface: scs, wasmContext: wasm } = await P.createSurface3D("chart", { worldDimensions: new Vector3(200, 200, 200) });
  scs.xAxis = new NumericAxis3D(wasm); scs.yAxis = new NumericAxis3D(wasm); scs.zAxis = new NumericAxis3D(wasm);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const scatter = [];
  for (let s = 0; s < SERIES; s++) {
    const xs = [], ys = [], zs = [];
    for (let i = 0; i < POINTS; i++) { xs.push(rnd() * 10); ys.push(rnd() * 10); zs.push(rnd() * 10); }
    const rs = new ScatterRenderableSeries3D(wasm, {
      dataSeries: new XyzDataSeries3D(wasm, { xValues: xs, yValues: ys, zValues: zs }),
      pointMarker: new SpherePointMarker3D(wasm, { size: 8, fill: COLORS[s] }),
    });
    scs.renderableSeries.add(rs);
    scatter.push(rs);
  }
  const tooltip = new TooltipModifier3D();
  scs.chartModifiers.add(tooltip);
  await P.sleep(800);

  // Counters
  P.watch.domWrites();
  P.watchEmbind(wasm, ["SCRTGetSelectionInfo"]);
  P.hookMethod(scs.sciChart3DRenderer, "render", { name: "3D render()" });
  scatter.forEach((rs) => P.hookMethod(rs, "hitTest", { name: "series hitTest()" }));
  const pointer = P.pointer(scs);

  // The issue's workaround, applied and removed around the "fixed" runs.
  const proto = TooltipModifier3D.prototype;
  const hadOwn = Object.prototype.hasOwnProperty.call(proto, "modifierMouseLeave");
  const inherited = proto.modifierMouseLeave;
  const leaveOverride = function (args) {
    inherited.call(this, args);
    this.mousePoint = undefined;
    if (this.tooltipAnnotation) { this.tooltipAnnotation.seriesInfo = undefined; this.tooltipAnnotation.isHidden = true; }
    if (this.crosshairEntity) this.crosshairEntity.isVisible = false;
  };
  const patchLeave = (on) => {
    if (on) proto.modifierMouseLeave = leaveOverride;
    else if (hadOwn) proto.modifierMouseLeave = inherited;
    else delete proto.modifierMouseLeave;
  };

  async function animated(label, hoverFirst) {
    if (hoverFirst) {
      pointer.enter(0.45, 0.5);
      for (let i = 0; i < 10; i++) { pointer.move(0.45 + i * 0.01, 0.5); await P.nextFrame(); }
      pointer.leave();
      await P.idleFrames(3);
    }
    const r = await P.frames(FRAMES, () => { scs.camera.orbitalYaw += 0.5; });
    const renders = r.total("3D render()");
    const res = {
      rendersPerFrame: renders / FRAMES,
      hitTestsPerRender: renders ? r.total("series hitTest()") / renders : 0,
      selectionReadsPerRender: renders ? r.total("wasm SCRTGetSelectionInfo") / renders : 0,
      tooltipParsesPerRender: renders ? r.total("createContextualFragment (HTML/SVG parse)") / renders : 0,
      mousePointKept: tooltip.mousePoint ? 1 : 0,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Scatter: camera animation, pointer never entered…");
  const never = await animated("scatter, pointer never entered", false);
  P.status("Scatter: camera animation after the pointer left, as shipped…");
  const shipped = await animated("scatter, after pointer left, as shipped", true);
  P.status("Scatter: camera animation after the pointer left, with the leave override…");
  patchLeave(true);
  const fixed = await animated("scatter, after pointer left, with leave override", true);
  patchLeave(false);

  // ---- Part 2: same chart, surface mesh instead of the scatter series
  P.status("Replacing the scatter series with a surface mesh…");
  scs.renderableSeries.clear();
  scs.worldDimensions = new Vector3(200, 100, 200);
  scs.camera = new CameraController(wasm, { position: new Vector3(-250, 200, 250), target: new Vector3(0, 40, 0) });
  const grid = Array.from({ length: 50 }, (_, z) => Array.from({ length: 50 }, (_, x) => 0.5 + 0.5 * Math.sin(x / 8) * Math.cos(z / 8)));
  const mesh = new SurfaceMeshRenderableSeries3D(wasm, {
    dataSeries: new UniformGridDataSeries3D(wasm, { yValues: grid }), minimum: 0, maximum: 1,
    meshColorPalette: new GradientColorPalette(wasm, { gradientStops: [{ offset: 0, color: "#4e79a7" }, { offset: 1, color: "#e15759" }] }),
  });
  scs.renderableSeries.add(mesh);
  await P.sleep(600);
  const dpr = window.devicePixelRatio;
  let spot = null;
  P.quiet(() => {
    for (let fy = 0.3; fy <= 0.8 && !spot; fy += 0.05) {
      for (let fx = 0.3; fx <= 0.7 && !spot; fx += 0.05) {
        const hit = mesh.hitTest(new Point(fx * pointer.rect.width * dpr, fy * pointer.rect.height * dpr));
        if (hit && hit.isHit) spot = { fx, fy };
      }
    }
  });
  P.hookMethod(mesh, "hitTest", { name: "mesh hitTest()" });

  async function meshIdle(label) {
    pointer.enter(spot.fx, spot.fy);
    await P.idleFrames(5);
    pointer.leave();
    await P.idleFrames(10);
    const r = await P.during(() => P.sleep(WINDOW));
    const s = WINDOW / 1000;
    const res = { renders: r.total("3D render()") / s, hitTests: r.total("mesh hitTest()") / s, parses: r.total("createContextualFragment (HTML/SVG parse)") / s, mousePointKept: tooltip.mousePoint ? 1 : 0 };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }
  let meshBaseline = null, meshShipped = null, meshFixed = null;
  if (spot) {
    P.status("Mesh: no input, pointer never entered…");
    // mousePoint was cleared by the last (patched) leave, so this is a clean baseline
    const r0 = await P.during(() => P.sleep(WINDOW));
    meshBaseline = { renders: r0.total("3D render()") / (WINDOW / 1000), hitTests: r0.total("mesh hitTest()") / (WINDOW / 1000) };
    P.log(`mesh, idle before hover: ${JSON.stringify(meshBaseline)}`);
    P.status("Mesh: no input after the pointer left, as shipped…");
    meshShipped = await meshIdle("mesh, after pointer left, as shipped");
    P.status("Mesh: no input after the pointer left, with the leave override…");
    patchLeave(true);
    meshFixed = await meshIdle("mesh, after pointer left, with leave override");
    patchLeave(false);
  }

  const reproduced = never.hitTestsPerRender <= 0.1 && shipped.hitTestsPerRender >= SERIES * 0.8 && fixed.hitTestsPerRender <= 0.1 && shipped.rendersPerFrame >= 0.5;
  const rows = [
    ["Scatter: renders per animation frame", never.rendersPerFrame, shipped.rendersPerFrame, fixed.rendersPerFrame],
    [`Scatter: series.hitTest() calls per render (${SERIES} series)`, never.hitTestsPerRender, shipped.hitTestsPerRender, fixed.hitTestsPerRender],
    ["Scatter: wasm SCRTGetSelectionInfo calls per render", never.selectionReadsPerRender, shipped.selectionReadsPerRender, fixed.selectionReadsPerRender],
    ["Scatter: tooltip SVG parses per render", never.tooltipParsesPerRender, shipped.tooltipParsesPerRender, fixed.tooltipParsesPerRender],
    ["Scatter: mousePoint still set after the run (1 = yes)", never.mousePointKept, shipped.mousePointKept, fixed.mousePointKept],
  ];
  if (spot) {
    rows.push(["Mesh: renders per second, no input", meshBaseline.renders, meshShipped.renders, meshFixed.renders]);
    rows.push(["Mesh: mesh hit tests per second, no input", meshBaseline.hitTests, meshShipped.hitTests, meshFixed.hitTests]);
  }
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `After the pointer left, every animation render still ran ${shipped.hitTestsPerRender.toFixed(1)} hit tests (${SERIES} series) at the last in-chart position; with a leave override: ${fixed.hitTestsPerRender.toFixed(1)}.` +
        (spot ? ` Over a surface mesh the chart kept rendering ${meshShipped.renders.toFixed(0)} times per second with the pointer gone (with the override: ${meshFixed.renders.toFixed(1)}).` : "")
      : `Expected about ${SERIES} hit tests per render after the pointer left; measured ${shipped.hitTestsPerRender.toFixed(2)} (never entered: ${never.hitTestsPerRender.toFixed(2)}, with override: ${fixed.hitTestsPerRender.toFixed(2)}).`,
    columns: ["Pointer never entered", "After pointer left, as shipped", "After pointer left, leave override"],
    rows,
    notes: [
      "The camera animation stands in for any render source after the pointer has gone (streaming appends, ResetCamera3DModifier, an app-driven orbit). The pointer leaves with a mouseleave event and nothing else is sent, as in a browser.",
      spot ? "The mesh renders after leave are the issue 020 loop: the stale mousePoint keeps it running until the pointer comes back. The demo uses one chart for both parts because two 3D surfaces on one page keep redrawing each other (about 30 renders per second each with no input), which would hide the idle counts." : "No pointer position over the mesh was found, so the mesh rows are omitted.",
    ],
    metrics: { never, shipped, fixed, meshBaseline, meshShipped, meshFixed, spot },
  });
}
