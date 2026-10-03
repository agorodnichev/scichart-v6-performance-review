const META = {
  id: "060",
  title: "A selected annotation deletes and re-parses its adorner SVG on every render, even when it has not moved",
  issue: "issues/060-selected-annotation-adorner-reparsed-every-render.md",
  severity: "medium",
  claim: "updateAdornerInner() removes the selection adorner and parses a new <svg> for it every time a selected annotation is drawn. Annotations are drawn on every render, so a selected annotation on a streaming chart rebuilds identical grips once per frame.",
  method: "<p>A line series on a fixed X range (autoRange Never) gets one point per frame appended beyond the visible range, so the chart renders every frame while nothing on screen moves. Four editable annotations are selected programmatically (<code>isSelected = true</code>): BoxAnnotation, LineAnnotation and NativeTextAnnotation (drawn through the render context) and TextAnnotation (an SVG annotation). Over 120 frames the demo counts, per chart render: updateAdornerInner() calls, adorner SVG parses (annotationHelpers.createSvg called from them), parses whose markup equals that annotation's previous adorner, and the nodes added to and removed from the adorner layer (<code>domSvgAdornerLayer</code>) seen by a MutationObserver.</p><p>A/B: the run is repeated with the library fix from the issue applied at runtime: each annotation's adorner is replaced only when its clipped markup changed (the original updateAdornerInner runs with deleteAdorner deferred, and an unchanged markup string returns the existing node instead of parsing). The patch is removed afterwards. The app-side workaround (clear isSelected when editing ends) is shown as a third column.</p>",
};

async function demo(P) {
  const {
    NumericAxis, NumberRange, EAutoRange, FastLineRenderableSeries, XyDataSeries,
    BoxAnnotation, LineAnnotation, NativeTextAnnotation, TextAnnotation, annotationHelpers,
  } = P.SciChart;
  const FRAMES = 120, POINTS = 1000;

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Never, visibleRange: new NumberRange(0, POINTS) }));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Never, visibleRange: new NumberRange(-2, 2) }));
  const xs = Array.from({ length: POINTS }, (_, i) => i);
  const dataSeries = new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 70)), isSorted: true, containsNaN: false });
  sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries, stroke: "#4e79a7", strokeThickness: 2 }));
  let nextX = POINTS;
  const appendOutside = () => { dataSeries.append(nextX, Math.sin(nextX / 70)); nextX++; };

  const annotations = [
    new BoxAnnotation({ x1: 120, x2: 320, y1: -1.2, y2: -0.2, fill: "#f28e2b33", stroke: "#f28e2b", strokeThickness: 2, isEditable: true }),
    new LineAnnotation({ x1: 420, y1: -1.5, x2: 620, y2: -0.4, stroke: "#e15759", strokeThickness: 2, isEditable: true }),
    new NativeTextAnnotation({ x1: 700, y1: 1.4, text: "NativeTextAnnotation", fontSize: 16, textColor: "#59a14f", isEditable: true }),
    new TextAnnotation({ x1: 380, y1: 1.6, text: "TextAnnotation", fontSize: 16, textColor: "#b07aa1", isEditable: true }),
  ];
  const NAMES = ["BoxAnnotation", "LineAnnotation", "NativeTextAnnotation", "TextAnnotation"];
  annotations.forEach((a) => sciChartSurface.annotations.add(a));
  sciChartSurface.rendered.subscribe(() => P.count("chart renders"));
  await P.sleep(400);
  annotations.forEach((a) => { a.isSelected = true; });
  await P.idleFrames(5);
  const SELECTED = annotations.length;

  // ---- counters: per-instance wrapper of updateAdornerInner, parses through annotationHelpers.createSvg
  let owner = null, fixCtx = null, adornerMs = 0;
  const lastMarkup = new WeakMap();
  const origCreateSvg = annotationHelpers.createSvg;
  annotationHelpers.createSvg = function (svgString) {
    if (owner && fixCtx && fixCtx.ann === owner) {
      const reused = fixCtx.tryReuse(svgString);
      if (reused) return reused;
    }
    if (owner) {
      P.count("adorner parses");
      P.count(`adorner parses: ${owner.__demoName}`);
      if (lastMarkup.get(owner) === svgString) P.count("adorner parses with unchanged markup");
      lastMarkup.set(owner, svgString);
    }
    return origCreateSvg.apply(this, arguments);
  };
  let fixOn = false;
  annotations.forEach((ann, i) => {
    ann.__demoName = NAMES[i];
    const orig = Object.getPrototypeOf(ann).updateAdornerInner; // the class's own implementation
    ann.updateAdornerInner = function () {
      const t0 = P.now();
      owner = this;
      try {
        if (!fixOn) return orig.apply(this, arguments);
        // Fix from the issue, for every annotation class: replace the adorner only when its markup changed.
        const realDelete = Object.getPrototypeOf(this).deleteAdorner;
        let pendingDelete = false;
        this.deleteAdorner = function () { pendingDelete = true; };
        fixCtx = {
          ann: this,
          tryReuse: (svgString) => {
            if (this.svgAdorner && svgString === this.__fixLastAdorner) { pendingDelete = false; return this.svgAdorner; }
            if (pendingDelete) { pendingDelete = false; realDelete.call(this); }
            this.__fixLastAdorner = svgString;
            return null;
          },
        };
        try { return orig.apply(this, arguments); } finally {
          fixCtx = null;
          delete this.deleteAdorner;
          if (pendingDelete) this.deleteAdorner();
        }
      } finally {
        owner = null;
        adornerMs += P.now() - t0;
        P.count("updateAdornerInner()");
      }
    };
  });
  const layer = sciChartSurface.domSvgAdornerLayer;
  const observer = new MutationObserver((records) => records.forEach((r) => {
    if (r.addedNodes.length) P.count("adorner layer: nodes added", r.addedNodes.length);
    if (r.removedNodes.length) P.count("adorner layer: nodes removed", r.removedNodes.length);
  }));
  observer.observe(layer, { childList: true });

  async function run(label) {
    adornerMs = 0;
    const r = await P.frames(FRAMES, appendOutside);
    const renders = Math.max(1, r.total("chart renders"));
    const res = {
      rendersPerFrame: r.total("chart renders") / FRAMES,
      selected: annotations.filter((a) => a.isSelected).length,
      calls: r.total("updateAdornerInner()") / renders,
      parses: r.total("adorner parses") / renders,
      sameParses: r.total("adorner parses with unchanged markup") / renders,
      added: r.total("adorner layer: nodes added") / renders,
      removed: r.total("adorner layer: nodes removed") / renders,
      perClass: NAMES.map((n) => r.total(`adorner parses: ${n}`) / renders),
      ms: adornerMs / renders,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Four selected annotations on a chart rendering every frame, as shipped…");
  const shipped = await run("as shipped");
  P.status("Same, with the fix applied at runtime…");
  fixOn = true;
  const fixed = await run("with fix");
  fixOn = false;
  P.status("Same, with the workaround (isSelected = false)…");
  annotations.forEach((a) => { a.isSelected = false; });
  await P.idleFrames(3);
  const unselected = await run("workaround: isSelected = false");
  observer.disconnect();
  annotationHelpers.createSvg = origCreateSvg;
  annotations.forEach((a) => { delete a.updateAdornerInner; });

  const all = [shipped, fixed, unselected];
  const rendered = all.every((s) => s.rendersPerFrame >= 0.8);
  const shippedOk = shipped.selected === SELECTED && shipped.parses >= SELECTED * 0.8 && shipped.sameParses >= SELECTED * 0.8 && shipped.added >= SELECTED * 0.8 && shipped.removed >= SELECTED * 0.8;
  const fixOk = fixed.selected === SELECTED && fixed.parses <= SELECTED * 0.1;
  const reproduced = rendered && shippedOk && fixOk;
  const verdict = !rendered ? "inconclusive" : reproduced ? "reproduced" : "not-reproduced";
  P.report({
    verdict,
    headline: !rendered
      ? `The chart did not render every frame in all runs (renders per frame: ${all.map((s) => s.rendersPerFrame.toFixed(2)).join(", ")}), so the counts cannot be compared.`
      : reproduced
        ? `With ${SELECTED} selected annotations that do not move, every render parses ${shipped.parses.toFixed(2)} adorner SVGs (${shipped.sameParses.toFixed(2)} identical to the previous one) and swaps ${shipped.removed.toFixed(2)} nodes out of and ${shipped.added.toFixed(2)} into the adorner layer. With the fix: ${fixed.parses.toFixed(2)} parses and ${fixed.added.toFixed(2)} inserted nodes per render.`
        : `Expected about ${SELECTED} identical adorner re-parses per render; measured ${shipped.parses.toFixed(2)} parses (${shipped.sameParses.toFixed(2)} identical), ${shipped.added.toFixed(2)} nodes added per render; with the fix ${fixed.parses.toFixed(2)}.`,
    columns: ["As shipped", "With fix", "Workaround: deselected"],
    rows: [
      ["Selected annotations", ...all.map((s) => s.selected)],
      ["Chart renders per frame", ...all.map((s) => s.rendersPerFrame)],
      ["updateAdornerInner() calls per render", ...all.map((s) => s.calls)],
      ["Adorner SVG parses per render", ...all.map((s) => s.parses)],
      ["...with markup identical to that annotation's previous adorner", ...all.map((s) => s.sameParses)],
      ...NAMES.map((n, i) => [`...${n}`, ...all.map((s) => s.perClass[i])]),
      ["Adorner layer nodes removed per render (MutationObserver)", ...all.map((s) => s.removed)],
      ["Adorner layer nodes added per render (MutationObserver)", ...all.map((s) => s.added)],
      ["Time in updateAdornerInner() per render, ms", ...all.map((s) => s.ms)],
      ["Frame interval p95, ms", ...all.map((s) => s.p95)],
    ],
    notes: [
      "The annotations are selected with isSelected = true, which is what a click on an editable annotation sets. Usually only one annotation is selected; four are used here to cover both drawing paths (render-context and SVG annotations).",
      "While an annotation is dragged its adorner markup changes on every move, so the fixed version still re-parses then; the saving is on renders where the annotation stands still (streaming, other overlays).",
      "Counts do not depend on hardware; the time rows do, and other pages share this machine's CPU.",
    ],
    metrics: { shipped, fixed, unselected, selected: SELECTED },
  });
}
