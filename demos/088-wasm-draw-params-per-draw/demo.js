const META = {
  id: "088",
  title: "WebGlRenderContext2D constructs and deletes a wasm Draw*Params object on every draw call",
  issue: "issues/088-wasm-draw-params-allocated-per-draw-call.md",
  severity: "low",
  claim: "drawRect, drawLine, drawTexture and the other WebGlRenderContext2D entry points create a new SCRTDrawRectsParams / SCRTDrawLinesParams / SCRTDrawPrimitivesParams (an embind constructor: a wasm call, a C++ allocation and a JS handle) for each draw and delete it right after, where one cached instance per entry point would do.",
  method: "<p>One chart with 200 fill-only BoxAnnotations (drawRect), 100 LineAnnotations (drawLine), texture-rendered axis labels (useNativeText: false, so each label goes through drawTexture) and a streaming line series (one point per frame, so the chart redraws every frame). For 60 frames the demo counts embind handles created and deleted per class (the harness's native-object counter), and calls and time in the WebGlRenderContext2D draw methods. It then emulates the fix from the issue: wasmContext.SCRTDrawRectsParams, SCRTDrawLinesParams and SCRTDrawPrimitivesParams are replaced by constructors that return one cached instance each (its delete() is a no-op while cached; drawEllipses keeps the original constructor, as the issue requires), runs the same 60 frames, then restores the constructors and frees the cached instances.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, BoxAnnotation, LineAnnotation, NumberRange, EAutoRange, WebGlRenderContext2D } = P.SciChart;
  const BOXES = 200, LINES = 100, FRAMES = 60;
  const CLASSES = ["SCRTDrawRectsParams", "SCRTDrawLinesParams", "SCRTDrawPrimitivesParams"];

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  const xAxis = new NumericAxis(wasmContext, { visibleRange: new NumberRange(0, 100), autoRange: EAutoRange.Never, useNativeText: false });
  const yAxis = new NumericAxis(wasmContext, { visibleRange: new NumberRange(0, 10), autoRange: EAutoRange.Never, useNativeText: false });
  sciChartSurface.xAxes.add(xAxis);
  sciChartSurface.yAxes.add(yAxis);
  [xAxis, yAxis].forEach((a) => { if (a.labelProvider.useNativeText) a.labelProvider.useNativeText = false; });
  const ds = new XyDataSeries(wasmContext, { fifoCapacity: 400, isSorted: true, containsNaN: false });
  for (let x = 0; x < 400; x++) ds.append(x / 4, 5 + 3 * Math.sin(x / 30));
  sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries: ds, stroke: "#4e79a7", strokeThickness: 2 }));
  for (let i = 0; i < BOXES; i++) {
    const x1 = (i * 0.5) % 100, y1 = ((i * 13) % 90) / 10;
    sciChartSurface.annotations.add(new BoxAnnotation({ x1, x2: x1 + 0.4, y1, y2: y1 + 0.6, fill: "#f28e2b55", strokeThickness: 0 }));
  }
  for (let i = 0; i < LINES; i++) {
    const x1 = i % 100, y1 = ((i * 7) % 100) / 10;
    sciChartSurface.annotations.add(new LineAnnotation({ x1, x2: x1 + 3, y1, y2: (y1 + 2) % 10, stroke: "#59a14f", strokeThickness: 1 }));
  }
  await P.sleep(700);

  // Calls and time per draw entry point
  const proto = WebGlRenderContext2D.prototype;
  ["drawRect", "drawRects", "drawRotatedRect", "drawLine", "drawLines", "drawLinesNative", "drawTexture", "drawTriangleStrip"].forEach((m) => {
    P.hookMethod(proto, m, { name: `draw: ${m}`, time: true });
  });
  const drawMethods = ["drawRect", "drawRects", "drawRotatedRect", "drawLine", "drawLines", "drawLinesNative", "drawTexture", "drawTriangleStrip"];

  let x = 400;
  const step = () => { x++; ds.append(x / 4, 5 + 3 * Math.sin(x / 30)); };
  async function run(label) {
    await P.frames(8, step);
    P.native.reset(); P.native.start();
    const r = await P.frames(FRAMES, step);
    P.native.stop();
    const nat = P.native.snapshot();
    const per = (k, f) => (nat[k] ? nat[k][f] : 0) / FRAMES;
    let allCreated = 0;
    Object.keys(nat).forEach((k) => { allCreated += nat[k].created; });
    const res = { classes: {}, calls: {}, drawCalls: 0, drawMs: 0, allCreated: allCreated / FRAMES, p95: r.frameP95 };
    CLASSES.forEach((k) => { res.classes[k] = { created: per(k, "created"), deleted: per(k, "deleted") }; });
    drawMethods.forEach((m) => { const n = r.perFrame(`draw: ${m}`); res.calls[m] = n; res.drawCalls += n; res.drawMs += r.perFrame(`draw: ${m}`, "t"); });
    res.paramsCreated = CLASSES.reduce((s, k) => s + res.classes[k].created, 0);
    res.paramsDeleted = CLASSES.reduce((s, k) => s + res.classes[k].deleted, 0);
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Redrawing every frame, library as shipped…");
  const shipped = await run("as shipped");

  // Fix emulated: one cached params object per class; drawEllipses keeps the original constructor.
  const originals = {}, cached = {};
  CLASSES.forEach((k) => {
    const Orig = wasmContext[k];
    originals[k] = Orig;
    cached[k] = new Orig();
    cached[k].delete = function () {}; // no-op while cached
    wasmContext[k] = function CachedParams() { return cached[k]; };
  });
  const drawEllipses = proto.drawEllipses;
  proto.drawEllipses = function () {
    const c = wasmContext.SCRTDrawRectsParams;
    wasmContext.SCRTDrawRectsParams = originals.SCRTDrawRectsParams;
    try { return drawEllipses.apply(this, arguments); } finally { wasmContext.SCRTDrawRectsParams = c; }
  };
  P.status("Redrawing with one cached params object per entry point…");
  const fixed = await run("with cached params");
  CLASSES.forEach((k) => { wasmContext[k] = originals[k]; });
  proto.drawEllipses = drawEllipses;
  await P.idleFrames(2);
  CLASSES.forEach((k) => { delete cached[k].delete; cached[k].delete(); });

  const expectedDraws = shipped.calls.drawRect + shipped.calls.drawRects + shipped.calls.drawRotatedRect + shipped.calls.drawLine + shipped.calls.drawLines + shipped.calls.drawLinesNative + shipped.calls.drawTexture + shipped.calls.drawTriangleStrip;
  const reproduced = shipped.calls.drawRect >= 0.9 * BOXES && shipped.calls.drawLine >= 0.9 * LINES &&
    shipped.paramsCreated >= 0.9 * expectedDraws && shipped.paramsDeleted >= 0.9 * shipped.paramsCreated && fixed.paramsCreated <= 0.01 * shipped.paramsCreated;
  const c = (v, k) => `${v.classes[k].created.toFixed(1)} / ${v.classes[k].deleted.toFixed(1)}`;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each frame makes ${shipped.drawCalls.toFixed(0)} draw calls and constructs and deletes ${shipped.paramsCreated.toFixed(0)} Draw*Params objects, one per call (${shipped.classes.SCRTDrawRectsParams.created.toFixed(0)} rects, ${shipped.classes.SCRTDrawLinesParams.created.toFixed(0)} lines, ${shipped.classes.SCRTDrawPrimitivesParams.created.toFixed(0)} primitives). With one cached object per entry point: ${fixed.paramsCreated.toFixed(0)}.`
      : `Expected one Draw*Params construction per draw call; measured ${shipped.paramsCreated.toFixed(1)} constructions for ${shipped.drawCalls.toFixed(1)} draw calls per frame (cached: ${fixed.paramsCreated.toFixed(1)}).`,
    columns: ["As shipped", "With cached params"],
    rows: [
      ["drawRect calls per frame (fill-only BoxAnnotations)", shipped.calls.drawRect, fixed.calls.drawRect],
      ["drawLine calls per frame (LineAnnotations)", shipped.calls.drawLine, fixed.calls.drawLine],
      ["drawTexture calls per frame (texture axis labels)", shipped.calls.drawTexture, fixed.calls.drawTexture],
      ["Other draw calls per frame (drawRects, drawLinesNative, drawLines, ...)", shipped.drawCalls - shipped.calls.drawRect - shipped.calls.drawLine - shipped.calls.drawTexture, fixed.drawCalls - fixed.calls.drawRect - fixed.calls.drawLine - fixed.calls.drawTexture],
      ["SCRTDrawRectsParams created / deleted per frame", c(shipped, "SCRTDrawRectsParams"), c(fixed, "SCRTDrawRectsParams")],
      ["SCRTDrawLinesParams created / deleted per frame", c(shipped, "SCRTDrawLinesParams"), c(fixed, "SCRTDrawLinesParams")],
      ["SCRTDrawPrimitivesParams created / deleted per frame", c(shipped, "SCRTDrawPrimitivesParams"), c(fixed, "SCRTDrawPrimitivesParams")],
      ["All embind handles created per frame", shipped.allCreated, fixed.allCreated],
      ["Time in these draw methods per frame, ms", shipped.drawMs, fixed.drawMs],
      ["Frame interval p95, ms", shipped.p95, fixed.p95],
    ],
    notes: [
      "Counts do not depend on hardware; times do. Each construction is a JS-to-wasm call plus a C++ allocation and a JS handle; each delete() is another crossing and a free. The rest of each draw call (vertex vectors, brush, the draw itself) is unchanged by the fix, which is why the issue rates it low.",
      "The cached-params run is an emulation to count and time the constructions the fix removes; the chart keeps drawing during it, but the page does not compare pixels between the two runs.",
    ],
    metrics: { shipped, fixed },
  });
}
