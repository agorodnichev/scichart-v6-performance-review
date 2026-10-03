const META = {
  id: "001",
  title: "At devicePixelRatio != 1 every render rewrites the SVG clip-path defs of three SVG layers per surface",
  issue: "issues/001-svg-clip-path-defs-rewritten-every-frame-on-hidpi.md",
  severity: "high",
  claim: "SciChartRenderer.resizeAnnotationRootElements stores the scaled viewRect as prevSurfaceRect but compares it with the unscaled rect, so when DPR != 1 its 'layout unchanged' early return never fires. Each render of each surface and sub-chart then re-runs setSvgClipPathDefinitions on three SVG roots: 4 querySelector and 8 setAttribute calls per root.",
  method: "<p>A parent surface with 6 sub-charts (relative positions, nothing moves) and one SVG TextAnnotation. One point is appended to each sub-chart per frame for 60 frames, so every surface renders every frame while its layout stays the same. Per frame the demo counts resizeAnnotationRootElements calls (one per rendered surface), setSvgClipPathDefinitions calls, the querySelector and setAttribute calls made inside them, and, independently, the attribute mutations a MutationObserver sees on the clip-path &lt;rect&gt; elements of the three shared SVG roots. It then wraps SciChartRenderer.prototype.resizeAnnotationRootElements with the workaround from the issue (store the unscaled rect as prevSurfaceRect after the original runs) and repeats the run.</p><p>The defect needs devicePixelRatio != 1. At DPR 1 the guard works, the page shows the measured counts as a control and reports inconclusive: open it on a HiDPI screen or set the browser zoom to 150-200% and run it again.</p>",
};

async function demo(P) {
  const { SciChartSubSurface, NumericAxis, FastLineRenderableSeries, XyDataSeries, TextAnnotation, SciChartRenderer,
    Rect, translateToNotScaledRect, DpiHelper, ESubSurfacePositionCoordinateMode } = P.SciChart;
  const SUBCHARTS = 6, FRAMES = 60;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948"];

  const { sciChartSurface: parent, wasmContext } = await P.createSurface("chart");
  parent.xAxes.add(new NumericAxis(wasmContext));
  parent.yAxes.add(new NumericAxis(wasmContext));
  parent.annotations.add(new TextAnnotation({ x1: 0.5, y1: 9.5, text: "SVG annotation (clipped by the defs)", fontSize: 13, textColor: "#888888" }));

  const dataSeries = [];
  for (let i = 0; i < SUBCHARTS; i++) {
    const col = i % 3, row = Math.floor(i / 3);
    const sub = SciChartSubSurface.createSubSurface(parent, {
      position: new Rect(0.04 + col * 0.32, 0.05 + row * 0.47, 0.29, 0.42),
      coordinateMode: ESubSurfacePositionCoordinateMode.Relative,
      isTransparent: false,
    });
    sub.xAxes.add(new NumericAxis(wasmContext, { drawMinorGridLines: false }));
    sub.yAxes.add(new NumericAxis(wasmContext, { drawMinorGridLines: false }));
    const ds = new XyDataSeries(wasmContext, { fifoCapacity: 300, isSorted: true, containsNaN: false });
    for (let x = 0; x < 300; x++) ds.append(x, Math.sin(x / 20 + i));
    sub.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries: ds, stroke: COLORS[i], strokeThickness: 2 }));
    dataSeries.push(ds);
  }
  await P.sleep(600);

  // --- counters -----------------------------------------------------------------------
  let inDefs = false, defsMs = 0;
  P.hookMethod(SciChartRenderer.prototype, "resizeAnnotationRootElements", { name: "resizeAnnotationRootElements" });
  // SciChartSurfaceBase is not on the UMD namespace: find the prototype that owns the method.
  let baseProto = parent;
  while (baseProto && !Object.prototype.hasOwnProperty.call(baseProto, "setSvgClipPathDefinitions")) baseProto = Object.getPrototypeOf(baseProto);
  const setDefs = baseProto.setSvgClipPathDefinitions;
  baseProto.setSvgClipPathDefinitions = function () {
    inDefs = true;
    const t0 = P.now();
    try { return setDefs.apply(this, arguments); } finally {
      inDefs = false;
      defsMs += P.now() - t0;
      P.count("setSvgClipPathDefinitions");
    }
  };
  P.hookMethod(Element.prototype, "querySelector", { name: "querySelector (all)", onCall: () => { if (inDefs) P.count("querySelector inside setSvgClipPathDefinitions"); } });
  P.hookMethod(Element.prototype, "setAttribute", { name: "setAttribute (all)", onCall: () => { if (inDefs) P.count("setAttribute inside setSvgClipPathDefinitions"); } });

  // Independent check: what the browser sees on the clip-path rects of the three shared SVG roots.
  const roots = [parent.domSvgContainer, parent.domBackgroundSvgContainer, parent.domSvgAdornerLayer].filter(Boolean);
  const mo = new MutationObserver((records) => {
    let n = 0;
    for (const r of records) if (r.target.parentNode && r.target.parentNode.nodeName.toLowerCase() === "clippath") n++;
    if (n) P.count("clip-path rect attribute mutations (MutationObserver)", n);
  });
  roots.forEach((r) => mo.observe(r, { attributes: true, subtree: true }));

  let x = 300;
  async function stream(label) {
    await P.frames(10, () => { x++; dataSeries.forEach((ds, i) => ds.append(x, Math.sin(x / 20 + i))); }); // warm-up
    defsMs = 0;
    const r = await P.frames(FRAMES, () => { x++; dataSeries.forEach((ds, i) => ds.append(x, Math.sin(x / 20 + i))); });
    const res = {
      renders: r.perFrame("resizeAnnotationRootElements"),
      defs: r.perFrame("setSvgClipPathDefinitions"),
      qs: r.perFrame("querySelector inside setSvgClipPathDefinitions"),
      attrs: r.perFrame("setAttribute inside setSvgClipPathDefinitions"),
      mutations: r.perFrame("clip-path rect attribute mutations (MutationObserver)"),
      ms: defsMs / FRAMES,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  const ratio = DpiHelper.PIXEL_RATIO;
  P.status(`Streaming into ${SUBCHARTS} sub-charts at DPR ${ratio}, library as shipped…`);
  const shipped = await stream("as shipped");

  // Workaround from the issue: after the original runs, store the rect the next comparison expects.
  const proto = SciChartRenderer.prototype;
  const resize = proto.resizeAnnotationRootElements;
  proto.resizeAnnotationRootElements = function () {
    const ret = resize.apply(this, arguments);
    const s = this.sciChartSurface;
    this.prevSurfaceRect = Rect.intersect(translateToNotScaledRect(s.viewRect), translateToNotScaledRect(s.clipRect));
    return ret;
  };
  P.status("Streaming again with the workaround (prevSurfaceRect stored unscaled)…");
  const fixed = await stream("with workaround");
  proto.resizeAnnotationRootElements = resize;
  mo.disconnect();

  const perRender = (v) => (v.renders ? v.defs / v.renders : 0);
  const rows = [
    ["Surfaces rendered per frame (resizeAnnotationRootElements calls)", shipped.renders, fixed.renders],
    ["setSvgClipPathDefinitions calls per frame", shipped.defs, fixed.defs],
    ["  per rendered surface (3 = all SVG roots rewritten)", perRender(shipped), perRender(fixed)],
    ["querySelector calls inside them, per frame", shipped.qs, fixed.qs],
    ["setAttribute calls inside them, per frame", shipped.attrs, fixed.attrs],
    ["Clip-path rect attribute mutations seen by a MutationObserver, per frame", shipped.mutations, fixed.mutations],
    ["Time in setSvgClipPathDefinitions per frame, ms", shipped.ms, fixed.ms],
    ["Frame interval p95, ms", shipped.p95, fixed.p95],
  ];
  const notes = [
    `devicePixelRatio ${window.devicePixelRatio}, DpiHelper.PIXEL_RATIO ${ratio}. Layout does not change during the run (relative sub-chart positions, fixed page size), so a working guard skips every call after the first render.`,
    "Counts do not depend on hardware; times do. Per the DOM spec every setAttribute queues a mutation record even when the value is unchanged, which is what the MutationObserver row shows.",
    "The time row covers only the script inside setSvgClipPathDefinitions. Whether the browser also re-runs style and re-clips the SVG layers after these same-value writes happens later in its rendering step and is not measured here.",
  ];
  const expected = 3 * shipped.renders;
  if (ratio === 1) {
    P.report({
      verdict: "inconclusive",
      headline: `This page runs at devicePixelRatio 1, where the guard works (${shipped.defs.toFixed(1)} setSvgClipPathDefinitions calls per frame). The defect needs DPR != 1: open the page on a HiDPI screen, or set the browser zoom to 150-200%, and run it again.`,
      columns: ["As shipped", "With workaround"], rows, notes,
      metrics: { dpr: window.devicePixelRatio, pixelRatio: ratio, shipped, fixed },
    });
    return;
  }
  const reproduced = shipped.renders >= 1 && shipped.defs >= 0.8 * expected && shipped.mutations >= 0.8 * 8 * shipped.defs && fixed.defs <= 0.1 * expected;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `At DPR ${ratio} each frame runs setSvgClipPathDefinitions ${shipped.defs.toFixed(0)} times (3 SVG roots x ${shipped.renders.toFixed(0)} rendered surfaces): ${shipped.qs.toFixed(0)} querySelector and ${shipped.attrs.toFixed(0)} setAttribute calls, ${shipped.mutations.toFixed(0)} DOM mutations, with no layout change. With the workaround: ${fixed.defs.toFixed(1)} calls.`
      : `Expected about ${expected.toFixed(0)} clip-path rewrites per frame at DPR ${ratio}; measured ${shipped.defs.toFixed(1)} (with workaround ${fixed.defs.toFixed(1)}).`,
    columns: ["As shipped", "With workaround"], rows, notes,
    metrics: { dpr: window.devicePixelRatio, pixelRatio: ratio, shipped, fixed },
  });
}
