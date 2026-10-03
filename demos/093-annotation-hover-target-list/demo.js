const META = {
  id: "093",
  title: "AnnotationHoverModifier rebuilds the z-ordered annotation list (14 filter passes) twice per pointer move",
  issue: "issues/093-annotation-hover-rebuilds-target-list-twice.md",
  severity: "low",
  claim: "On every pointer move, performHoverAction gets the included targets (which falls back to getAllTargets()) and then calls getAllTargets() again for the default AbsoluteTopmost mode. Each call runs 14 filter() passes over the annotation list and spreads the 9 layer lists into a new array.",
  method: "<p>500 annotations (300 BoxAnnotation and 100 NativeTextAnnotation drawn in the render context, 70 SVG TextAnnotation, 30 HtmlTextAnnotation, spread over the three annotation layers) and an AnnotationHoverModifier with its defaults. The pointer sweeps the plot for 120 frames, one pointermove per frame. The demo counts, per move: getAllTargets() builds, filter() passes made inside a build and the elements their predicates visit (each filter visits the whole input array), annotation hit tests (checkIsWithinBounds) and the find() predicate calls that look up the hovered annotation. It also times the target-list builds and the whole performHoverAction.</p><p>Then it applies the issue's fix at runtime: the list is built once per move and reused for the include list, with the single-pass getAllTargets() from the issue (one loop into 9 layer buckets). It checks that the single-pass list equals the shipped one element by element, and that every move hovers the same annotation in both runs. The diff's replacement of find() by an identity check is not applied, so that row stays the same.</p>",
};

async function demo(P) {
  const { NumericAxis, NumberRange, FastLineRenderableSeries, XyDataSeries, AnnotationHoverModifier, BoxAnnotation, NativeTextAnnotation, TextAnnotation, HtmlTextAnnotation, EAnnotationLayer } = P.SciChart;
  const FRAMES = 120;
  const KINDS = [["box", 300], ["native text", 100], ["svg text", 70], ["html text", 30]];
  const LAYERS = [EAnnotationLayer.Background, EAnnotationLayer.BelowChart, EAnnotationLayer.AboveChart];

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { visibleRange: new NumberRange(0, 1000) }));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { visibleRange: new NumberRange(0, 10) }));
  const xs = Array.from({ length: 1000 }, (_, i) => i);
  sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, {
    dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => 5 + 3 * Math.sin(x / 90)), isSorted: true, containsNaN: false }),
    stroke: "#4e79a7", strokeThickness: 2,
  }));
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const index = new Map();
  let n = 0;
  for (const [kind, count] of KINDS) {
    for (let i = 0; i < count; i++, n++) {
      const x = rnd() * 960, y = rnd() * 9.4, layer = LAYERS[n % 3];
      const a = kind === "box" ? new BoxAnnotation({ x1: x, x2: x + 8 + rnd() * 20, y1: y, y2: y + 0.3 + rnd() * 0.6, fill: "#4e79a744", stroke: "#4e79a7", strokeThickness: 1, annotationLayer: layer })
        : kind === "native text" ? new NativeTextAnnotation({ x1: x, y1: y, text: `N${i}`, fontSize: 10, textColor: "#9c755f", annotationLayer: layer })
        : kind === "svg text" ? new TextAnnotation({ x1: x, y1: y, text: `S${i}`, fontSize: 10, textColor: "#e15759", annotationLayer: layer })
        : new HtmlTextAnnotation({ x1: x, y1: y, text: `H${i}`, textContainerStyle: { fontSize: "10px", color: "#59a14f" }, annotationLayer: layer });
      sciChartSurface.annotations.add(a);
      index.set(a, n);
    }
  }
  const hover = new AnnotationHoverModifier();
  sciChartSurface.chartModifiers.add(hover);
  await P.sleep(800);

  // ---- counters
  const hoverProto = AnnotationHoverModifier.prototype;
  const mediatorProto = Object.getPrototypeOf(hoverProto); // PointerEventsMediatorModifier (not exported by the UMD bundle)
  let owner = BoxAnnotation.prototype;
  while (owner && !Object.prototype.hasOwnProperty.call(owner, "checkIsWithinBounds")) owner = Object.getPrototypeOf(owner);
  P.hookMethod(owner, "checkIsWithinBounds", { name: "hit tests (checkIsWithinBounds)" });

  const shippedGetAll = hoverProto.getAllTargets;
  let impl = shippedGetAll, inBuild = 0, inHover = 0, buildMs = 0, hoverMs = 0;
  hoverProto.getAllTargets = function () {
    inBuild++;
    const t0 = P.now();
    try { return impl.call(this); } finally { inBuild--; buildMs += P.now() - t0; P.count("target-list builds"); }
  };
  const performHoverAction = mediatorProto.performHoverAction;
  mediatorProto.performHoverAction = function (args) {
    inHover++;
    const t0 = P.now();
    try { return performHoverAction.call(this, args); } finally { inHover--; hoverMs += P.now() - t0; P.count("hover actions"); }
  };
  // filter() visits every element of its input once, so the visit count is the input length.
  const AP = Array.prototype, filter = AP.filter, find = AP.find;
  AP.filter = function (cb, thisArg) {
    if (inBuild) P.count("filter passes", 1, this.length);
    return filter.call(this, cb, thisArg);
  };
  AP.find = function (cb, thisArg) {
    if (!inHover || inBuild) return find.call(this, cb, thisArg);
    return find.call(this, function (v, i, a) { P.count("find() predicate calls"); return cb.call(thisArg, v, i, a); });
  };

  // ---- the single-pass build from the issue's fix (output order: htmlBg, svgBg, rcBg, rcBelow, rcAbove, svgBelow, htmlBelow, svgAbove, htmlAbove)
  const SVG_BUCKET = [1, 5, 7], RC_BUCKET = [2, 3, 4], HTML_BUCKET = [0, 6, 8];
  function singlePassGetAllTargets() {
    const b = [[], [], [], [], [], [], [], [], []];
    const anns = this.parentSurface.annotations.asArray();
    P.count("single-pass visits", anns.length);
    for (let i = 0; i < anns.length; i++) {
      const a = anns[i];
      if (a.isHidden) continue;
      const l = a.annotationLayer;
      const li = l === EAnnotationLayer.Background ? 0 : l === EAnnotationLayer.BelowChart ? 1 : l === EAnnotationLayer.AboveChart ? 2 : -1;
      if (li < 0) continue;
      if (a.isSvgAnnotation) {
        if (a.isDomAnnotation) b[SVG_BUCKET[li]].push(a);
      } else {
        b[RC_BUCKET[li]].push(a); // the render-context bucket keeps HTML annotations too, as the shipped filters do
        if (a.isDomAnnotation) b[HTML_BUCKET[li]].push(a);
      }
    }
    const out = [];
    for (let k = 0; k < 9; k++) for (let j = 0; j < b[k].length; j++) out.push(b[k][j]);
    return out;
  }
  const listShipped = P.quiet(() => shippedGetAll.call(hover));
  const listSingle = P.quiet(() => singlePassGetAllTargets.call(hover));
  const sameList = listShipped.length === listSingle.length && listShipped.every((a, i) => a === listSingle[i]);

  const pointer = P.pointer(sciChartSurface);
  async function sweep(label) {
    pointer.enter(0.5, 0.5);
    await P.idleFrames(5);
    buildMs = 0; hoverMs = 0;
    const hovered = [];
    const r = await P.frames(FRAMES, (i) => {
      pointer.move(pointer.sweepX(i, 60), 0.5);
      const h = hover.previousHoveredEntities[0];
      hovered.push(h ? index.get(h) : -1);
    });
    const moves = r.total("hover actions");
    const res = {
      movesPerFrame: moves / FRAMES,
      buildsPerMove: r.total("target-list builds") / moves,
      filterPassesPerMove: r.total("filter passes") / moves,
      filterVisitsPerMove: r.total("filter passes", "bytes") / moves,
      singlePassVisitsPerMove: r.total("single-pass visits") / moves,
      hitTestsPerMove: r.total("hit tests (checkIsWithinBounds)") / moves,
      findCallsPerMove: r.total("find() predicate calls") / moves,
      buildMsPerMove: buildMs / moves,
      hoverMsPerMove: hoverMs / moves,
      hoveredMoves: hovered.filter((h) => h >= 0).length,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    pointer.leave();
    await P.idleFrames(5);
    return { res, hovered };
  }

  P.status("Sweeping the pointer, library as shipped…");
  const shipped = await sweep("as shipped");

  // The fix: build once per move (reused for the include list), single pass.
  const countedPerform = mediatorProto.performHoverAction, countedGetAll = hoverProto.getAllTargets;
  mediatorProto.performHoverAction = function (args) {
    this.cacheTargetsThisMove = true;
    try { return countedPerform.call(this, args); } finally { this.cacheTargetsThisMove = false; this.targetsThisMove = undefined; }
  };
  hoverProto.getAllTargets = function () {
    if (!this.cacheTargetsThisMove) return countedGetAll.call(this);
    return this.targetsThisMove || (this.targetsThisMove = countedGetAll.call(this));
  };
  impl = singlePassGetAllTargets;
  P.status("Sweeping the pointer, with one single-pass build per move…");
  const fixed = await sweep("with fix");
  hoverProto.getAllTargets = shippedGetAll;
  mediatorProto.performHoverAction = performHoverAction;
  AP.filter = filter;
  AP.find = find;

  const sameHover = shipped.hovered.length === fixed.hovered.length && shipped.hovered.every((h, i) => h === fixed.hovered[i]);
  const S = shipped.res, F = fixed.res, N = listShipped.length;
  const reproduced = S.buildsPerMove >= 1.9 && S.filterPassesPerMove >= 26 && F.buildsPerMove <= 1.05 && F.filterPassesPerMove === 0 && sameList && sameHover;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each pointer move builds the target list of ${index.size} annotations ${S.buildsPerMove.toFixed(1)} times: ${S.filterPassesPerMove.toFixed(0)} filter() passes visiting ${S.filterVisitsPerMove.toFixed(0)} elements. One single-pass build: ${F.singlePassVisitsPerMove.toFixed(0)} visits, same list, same hovered annotation on all ${FRAMES} moves. Target-list time ${S.buildMsPerMove.toFixed(3)} -> ${F.buildMsPerMove.toFixed(3)} ms per move.`
      : `Expected 2 target-list builds (28 filter passes) per move; measured ${S.buildsPerMove.toFixed(2)} builds and ${S.filterPassesPerMove.toFixed(1)} passes (fixed: ${F.buildsPerMove.toFixed(2)}, list identical: ${sameList}, hover identical: ${sameHover}).`,
    columns: ["As shipped", "With fix"],
    rows: [
      ["getAllTargets() builds per move", S.buildsPerMove, F.buildsPerMove],
      ["filter() passes per move", S.filterPassesPerMove, F.filterPassesPerMove],
      ["Elements visited by filter predicates per move", S.filterVisitsPerMove, F.filterVisitsPerMove],
      ["Elements visited by the single-pass build per move", S.singlePassVisitsPerMove, F.singlePassVisitsPerMove],
      ["Annotation hit tests (checkIsWithinBounds) per move", S.hitTestsPerMove, F.hitTestsPerMove],
      ["find() predicate calls per move (hovered-annotation lookup, unchanged here)", S.findCallsPerMove, F.findCallsPerMove],
      ["Target list and hovered annotation per move", "reference", sameList && sameHover ? "identical" : "differs"],
      ["Time building the target list per move, ms", S.buildMsPerMove, F.buildMsPerMove],
      ["Time in performHoverAction per move, ms", S.hoverMsPerMove, F.hoverMsPerMove],
      ["Frame interval p95, ms", S.p95, F.p95],
    ],
    notes: [
      `Counts do not depend on hardware; times do. ${S.hoveredMoves} of ${FRAMES} moves were over an annotation. The list has ${N} entries for ${index.size} annotations because HTML annotations sit in both the HTML and the render-context bucket, in the shipped code and in the fix. Each shipped build also allocates 14 filter results and one 9-way spread (15 arrays, 30 per move); the single pass allocates 9 buckets and one output array.`,
      "Severity is low: the per-annotation hit test that follows (checkIsWithinBounds) is heavier per item than these predicates, so the rebuilds add a constant factor to hover cost and GC pressure, and matter with hundreds of annotations.",
    ],
    metrics: { shipped: S, fixed: F, annotations: N, sameList, sameHover },
  });
}
