const META = {
  id: "020",
  title: "A 3D tooltip resting over a surface mesh re-renders the chart on every frame, forever",
  issue: "issues/020-mesh-tooltip-hittest-equality-render-loop.md",
  severity: "high",
  claim: "HitTestInfo3D.isEqual compares selectionIjIndices by reference, and every mesh hit test allocates a new Point for it. Each render's tooltip update therefore sees a 'new' hit, invalidates the tooltip, which requests the next render: the chart redraws on every display frame with no input.",
  method: "<p>One SurfaceMeshRenderableSeries3D (50 x 50 UniformGridDataSeries3D) with a default TooltipModifier3D. The demo first finds a pointer position over the mesh with series.hitTest(), then sends one pointer move there and stops. With no further input it counts, over 2-second windows: SciChart3DRenderer.render() calls, engine draw requests (wasm TSRRequestCanvasDraw), mesh hit tests, HitTestInfo3D.isEqual results, tooltip SVG parses (Range.createContextualFragment) and the JS time spent in the surface's drawing loop.</p><p>Windows: before the pointer enters (baseline), pointer resting as shipped, and pointer resting at the same position after HitTestInfo3D.isEqual is patched with the issue's app-side workaround (selectionIjIndices compared by value). The patch is removed afterwards.</p>",
};

async function demo(P) {
  const { NumericAxis3D, SurfaceMeshRenderableSeries3D, UniformGridDataSeries3D, GradientColorPalette, TooltipModifier3D, Vector3, Point, HitTestInfo3D } = P.SciChart;
  const GRID = 50, WINDOW = 2000;

  const { sciChart3DSurface: scs, wasmContext } = await P.createSurface3D("chart", {
    worldDimensions: new Vector3(200, 100, 200),
    cameraOptions: { position: new Vector3(-250, 200, 250), target: new Vector3(0, 40, 0) },
  });
  scs.xAxis = new NumericAxis3D(wasmContext);
  scs.yAxis = new NumericAxis3D(wasmContext);
  scs.zAxis = new NumericAxis3D(wasmContext);
  const yValues = Array.from({ length: GRID }, (_, z) => Array.from({ length: GRID }, (_, x) => 0.5 + 0.5 * Math.sin(x / 8) * Math.cos(z / 8)));
  const mesh = new SurfaceMeshRenderableSeries3D(wasmContext, {
    dataSeries: new UniformGridDataSeries3D(wasmContext, { yValues, xStep: 1, zStep: 1 }),
    minimum: 0, maximum: 1,
    meshColorPalette: new GradientColorPalette(wasmContext, { gradientStops: [{ offset: 0, color: "#4e79a7" }, { offset: 1, color: "#e15759" }] }),
  });
  scs.renderableSeries.add(mesh);
  scs.chartModifiers.add(new TooltipModifier3D());
  await P.sleep(800);

  P.status("Measuring the display refresh rate…");
  let frames = 0; const tr = P.now();
  while (P.now() - tr < 1000) { await P.nextFrame(); frames++; }
  const refresh = frames / ((P.now() - tr) / 1000);

  // Find a pointer position over the mesh (before any counter is installed).
  const pointer = P.pointer(scs);
  const dpr = window.devicePixelRatio, rect = pointer.rect;
  let spot = null;
  for (let fy = 0.3; fy <= 0.8 && !spot; fy += 0.05) {
    for (let fx = 0.3; fx <= 0.7 && !spot; fx += 0.05) {
      const hit = mesh.hitTest(new Point(fx * rect.width * dpr, fy * rect.height * dpr));
      if (hit && hit.isHit) spot = { fx, fy };
    }
  }
  if (!spot) {
    P.report({ verdict: "inconclusive", headline: "No pointer position over the mesh was found with series.hitTest(), so the scenario could not start.", rows: [] });
    return;
  }
  P.log(`pointer position over the mesh: (${spot.fx.toFixed(2)}, ${spot.fy.toFixed(2)}) of the canvas`);

  // Counters
  P.watch.domWrites();
  P.watchEmbind(wasmContext, ["TSRRequestCanvasDraw"]);
  P.hookMethod(scs.sciChart3DRenderer, "render", { name: "3D render()" });
  P.hookMethod(scs, "doDrawingLoop", { name: "doDrawingLoop()", time: true });
  P.hookMethod(mesh, "hitTest", { name: "mesh hitTest()" });
  const shippedIsEqual = HitTestInfo3D.isEqual;
  const countingIsEqual = (impl) => function (a, b) {
    const r = impl(a, b);
    P.count(r ? "isEqual true" : "isEqual false");
    return r;
  };
  HitTestInfo3D.isEqual = countingIsEqual(shippedIsEqual);

  async function idleWindow(label) {
    const r = await P.during(() => P.sleep(WINDOW));
    const s = WINDOW / 1000;
    const res = {
      renders: r.total("3D render()") / s,
      drawRequests: r.total("wasm TSRRequestCanvasDraw") / s,
      hitTests: r.total("mesh hitTest()") / s,
      notEqual: r.total("isEqual false") / s,
      parses: r.total("createContextualFragment (HTML/SVG parse)") / s,
      drawMs: r.total("doDrawingLoop()", "t") / s,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Baseline: chart idle, pointer outside…");
  const baseline = await idleWindow("baseline, no pointer");

  P.status("Pointer resting over the mesh, library as shipped…");
  pointer.enter(spot.fx, spot.fy);
  await P.idleFrames(10);
  const shipped = await idleWindow("pointer resting, as shipped");

  P.status("Pointer resting at the same spot, with HitTestInfo3D.isEqual comparing selectionIjIndices by value…");
  // App-side workaround from the issue: compare selectionIjIndices by value.
  const byValue = (a, b) => shippedIsEqual(a, b) || (!!a && !!b &&
    (a.selectionIjIndices && a.selectionIjIndices.x) === (b.selectionIjIndices && b.selectionIjIndices.x) &&
    (a.selectionIjIndices && a.selectionIjIndices.y) === (b.selectionIjIndices && b.selectionIjIndices.y) &&
    shippedIsEqual(Object.assign({}, a, { selectionIjIndices: undefined }), Object.assign({}, b, { selectionIjIndices: undefined })));
  HitTestInfo3D.isEqual = countingIsEqual(byValue);
  await P.idleFrames(10);
  const fixed = await idleWindow("pointer resting, isEqual by value");
  HitTestInfo3D.isEqual = shippedIsEqual;
  pointer.leave();

  const perFrame = (v) => v / refresh;
  const reproduced = perFrame(shipped.renders) >= 0.8 && perFrame(baseline.renders) <= 0.05 && perFrame(fixed.renders) <= 0.05 && shipped.notEqual >= shipped.renders * 0.8;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `With the pointer resting over the mesh and no input, the chart renders ${shipped.renders.toFixed(0)} times per second (display ${refresh.toFixed(0)} Hz) and re-parses the tooltip SVG ${shipped.parses.toFixed(0)} times per second. With selectionIjIndices compared by value: ${fixed.renders.toFixed(1)} renders per second.`
      : `Expected about one render per display frame while the pointer rests over the mesh; measured ${shipped.renders.toFixed(1)}/s at ${refresh.toFixed(0)} Hz (baseline ${baseline.renders.toFixed(1)}/s, with fix ${fixed.renders.toFixed(1)}/s).`,
    columns: ["Idle, no pointer", "Pointer resting, as shipped", "Pointer resting, isEqual by value"],
    rows: [
      ["3D renders per second (SciChart3DRenderer.render)", baseline.renders, shipped.renders, fixed.renders],
      ["Engine draw requests per second (TSRRequestCanvasDraw)", baseline.drawRequests, shipped.drawRequests, fixed.drawRequests],
      ["Mesh hit tests per second", baseline.hitTests, shipped.hitTests, fixed.hitTests],
      ["HitTestInfo3D.isEqual returning false, per second", baseline.notEqual, shipped.notEqual, fixed.notEqual],
      ["Tooltip SVG parses per second", baseline.parses, shipped.parses, fixed.parses],
      ["JS time in doDrawingLoop per second, ms", baseline.drawMs, shipped.drawMs, fixed.drawMs],
      ["Display refresh rate, frames per second", refresh, refresh, refresh],
    ],
    notes: [
      "Nothing changes between the two 'pointer resting' windows except the equality check: same pointer position, same data, no input. Each render runs the hit test, finds a new Point in selectionIjIndices, sets tooltipAnnotation.seriesInfo, and that setter invalidates the surface for the next frame.",
      "Each iteration is a full surface render: the JS render pass, the native scene draw with the selection pass (whose cost grows with mesh size and series count), the hit test and the tooltip SVG rebuild. It stops only when the pointer moves off the mesh (or, with issue 051, never, if it leaves the chart from over the mesh). Counts do not depend on hardware; the time row does.",
    ],
    metrics: { refresh, spot, baseline, shipped, fixed },
  });
}
