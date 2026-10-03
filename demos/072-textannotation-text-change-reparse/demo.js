const META = {
  id: "072",
  title: "TextAnnotation re-parses its whole SVG and calls getBBox once or twice on every text change",
  issue: "issues/072-textannotation-text-change-reparses-and-measures-twice.md",
  severity: "medium",
  claim: "Setting textAnnotation.text marks the annotation dirty, so the next render removes its <svg>, builds a new one through the HTML fragment parser and measures it with getBBox right after inserting it; with a background it measures twice (once before inserting the background rect). Labels that show a live value pay this on every update.",
  method: "<p>20 TextAnnotations on a chart (fixed axes, no data changes): 10 plain, 10 with <code>background</code>. Every frame for 90 frames each annotation gets a new text (a live value), which triggers one SVG-only render per frame. The demo counts per text change: SVG parses (annotationHelpers.createSvg called while a TextAnnotation updates), getBBox() calls inside TextAnnotation update(), and how many of those reads came right after a DOM write (the harness's forced-layout counter), separately for plain and background annotations.</p><p>A/B: the run is repeated with the library fix from the issue patched into the <code>text</code> setter at runtime: when the annotation already has its SVG, is not dirty, has no background and the text has no markup, the setter writes the &lt;text&gt; node's textContent in place, clears the cached size and invalidates SVG-only. Annotations with a background keep the old path, as in the fix. The original setter is restored afterwards.</p>",
};

async function demo(P) {
  const { NumericAxis, NumberRange, EAutoRange, FastLineRenderableSeries, XyDataSeries, TextAnnotation, annotationHelpers } = P.SciChart;
  const FRAMES = 90, LABELS = 20, POINTS = 500;

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Never, visibleRange: new NumberRange(0, POINTS) }));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Never, visibleRange: new NumberRange(-2, 2) }));
  const xs = Array.from({ length: POINTS }, (_, i) => i);
  sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, {
    dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 40) * 0.5), isSorted: true, containsNaN: false }),
    stroke: "#4e79a7", strokeThickness: 2,
  }));
  const labels = [];
  for (let i = 0; i < LABELS; i++) {
    const withBg = i % 2 === 1;
    const a = new TextAnnotation({
      x1: 20 + (i % 5) * 95, y1: 1.7 - Math.floor(i / 5) * 0.9,
      text: `L${i + 1}: 0.00`, fontSize: 14,
      textColor: withBg ? "#ffffff" : "#e15759",
      background: withBg ? "#4e79a7" : undefined,
    });
    a.__withBg = withBg;
    sciChartSurface.annotations.add(a);
    labels.push(a);
  }
  sciChartSurface.rendered.subscribe(() => P.count("chart renders"));
  await P.sleep(500);

  // ---- counters attributed to TextAnnotation updates
  P.watch.layout();
  const FORCED = "layout reads after a DOM write (forced layout)";
  const forcedNow = () => { const r = P.snap()[FORCED]; return r ? r.n : 0; };
  const proto = TextAnnotation.prototype;
  const ownUpdate = Object.prototype.hasOwnProperty.call(proto, "update");
  const origUpdate = proto.update;
  let cur = null, updateMs = 0;
  proto.update = function () {
    const t0 = P.now(), f0 = forcedNow();
    cur = this;
    try { return origUpdate.apply(this, arguments); } finally {
      cur = null;
      updateMs += P.now() - t0;
      const df = forcedNow() - f0;
      if (df) P.count(`forced layouts (${this.__withBg ? "bg" : "plain"})`, df);
    }
  };
  P.hookMethod(SVGGraphicsElement.prototype, "getBBox", { name: "getBBox (all)", onCall: () => { if (cur) P.count(`getBBox (${cur.__withBg ? "bg" : "plain"})`); } });
  const origCreateSvg = annotationHelpers.createSvg;
  annotationHelpers.createSvg = function () {
    if (cur) P.count(`SVG parses (${cur.__withBg ? "bg" : "plain"})`);
    return origCreateSvg.apply(this, arguments);
  };

  // ---- the library fix from the issue: in-place text update for plain labels
  const textDesc = Object.getOwnPropertyDescriptor(proto, "text");
  const fixedDesc = {
    configurable: true, enumerable: textDesc.enumerable, get: textDesc.get,
    set(text) {
      if (this.textProperty === text) return;
      const textEl = this.svg && !this.isDirty && !this.background && !/[<&]/.test(text) && this.svg.querySelector("text");
      if (textEl) {
        this.textProperty = text;
        textEl.textContent = text; // in place: no parse, no node swap
        this.svgDOMRect = undefined; // one lazy re-measure in the next update
        if (this.invalidateParentCallback) this.invalidateParentCallback({ svgOnly: !this.reDrawChartOnChange });
      } else {
        textDesc.set.call(this, text);
      }
    },
  };

  let frame = 0;
  const setTexts = () => {
    frame++;
    labels.forEach((a, i) => {
      a.text = `L${i + 1}: ${(1000 + frame * 1.37 + i * 3.1).toFixed(2)}`;
      P.count(`text changes (${a.__withBg ? "bg" : "plain"})`);
    });
  };
  async function run(label) {
    updateMs = 0;
    const r = await P.frames(FRAMES, setTexts);
    const renders = r.total("chart renders");
    const per = (kind, what) => r.total(`${what} (${kind})`) / Math.max(1, r.total(`text changes (${kind})`));
    const res = {
      rendersPerFrame: renders / FRAMES,
      plain: { parses: per("plain", "SVG parses"), bbox: per("plain", "getBBox"), forced: per("plain", "forced layouts") },
      bg: { parses: per("bg", "SVG parses"), bbox: per("bg", "getBBox"), forced: per("bg", "forced layouts") },
      parsesPerFrame: (r.total("SVG parses (plain)") + r.total("SVG parses (bg)")) / FRAMES,
      bboxPerFrame: (r.total("getBBox (plain)") + r.total("getBBox (bg)")) / FRAMES,
      forcedPerFrame: (r.total("forced layouts (plain)") + r.total("forced layouts (bg)")) / FRAMES,
      msPerFrame: updateMs / FRAMES,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Setting 20 label texts every frame, as shipped…");
  const shipped = await run("as shipped");
  P.status("Same, with the in-place text fix…");
  Object.defineProperty(proto, "text", fixedDesc);
  const fixed = await run("with fix");
  Object.defineProperty(proto, "text", textDesc);
  if (ownUpdate) proto.update = origUpdate; else delete proto.update;
  annotationHelpers.createSvg = origCreateSvg;

  const both = [shipped, fixed];
  const rendered = both.every((s) => s.rendersPerFrame >= 0.8);
  const shippedOk = shipped.plain.parses >= 0.8 && shipped.bg.parses >= 0.8 && shipped.plain.bbox >= 0.8 && shipped.bg.bbox >= 1.6;
  const fixOk = fixed.plain.parses <= 0.1;
  const reproduced = rendered && shippedOk && fixOk;
  const verdict = !rendered ? "inconclusive" : reproduced ? "reproduced" : "not-reproduced";
  P.report({
    verdict,
    headline: !rendered
      ? `The chart did not render once per frame (renders per frame: ${both.map((s) => s.rendersPerFrame.toFixed(2)).join(", ")}), so the counts cannot be compared.`
      : reproduced
        ? `Each text change re-parses the label's SVG (${shipped.plain.parses.toFixed(2)} parses per change) and calls getBBox ${shipped.plain.bbox.toFixed(2)} times, ${shipped.bg.bbox.toFixed(2)} times with a background; 20 live labels cost ${shipped.parsesPerFrame.toFixed(1)} parses and ${shipped.forcedPerFrame.toFixed(1)} forced layouts per frame. With the in-place fix, plain labels: ${fixed.plain.parses.toFixed(2)} parses and ${fixed.plain.bbox.toFixed(2)} getBBox per change.`
        : `Expected 1 parse and 1 (plain) or 2 (background) getBBox calls per text change; measured plain ${shipped.plain.parses.toFixed(2)} / ${shipped.plain.bbox.toFixed(2)}, background ${shipped.bg.parses.toFixed(2)} / ${shipped.bg.bbox.toFixed(2)}; with the fix plain parses ${fixed.plain.parses.toFixed(2)}.`,
    columns: ["As shipped", "With fix"],
    rows: [
      ["Chart renders per frame", shipped.rendersPerFrame, fixed.rendersPerFrame],
      ["Plain label: SVG parses per text change", shipped.plain.parses, fixed.plain.parses],
      ["Plain label: getBBox() per text change", shipped.plain.bbox, fixed.plain.bbox],
      ["Plain label: ...right after a DOM write (forced layout)", shipped.plain.forced, fixed.plain.forced],
      ["Label with background: SVG parses per text change", shipped.bg.parses, fixed.bg.parses],
      ["Label with background: getBBox() per text change", shipped.bg.bbox, fixed.bg.bbox],
      ["Label with background: ...right after a DOM write (forced layout)", shipped.bg.forced, fixed.bg.forced],
      ["All 20 labels: SVG parses per frame", shipped.parsesPerFrame, fixed.parsesPerFrame],
      ["All 20 labels: getBBox() per frame", shipped.bboxPerFrame, fixed.bboxPerFrame],
      ["All 20 labels: forced layouts per frame", shipped.forcedPerFrame, fixed.forcedPerFrame],
      ["Time in TextAnnotation update() per frame, ms", shipped.msPerFrame, fixed.msPerFrame],
      ["Frame interval p95, ms", shipped.p95, fixed.p95],
    ],
    notes: [
      "The fix covers plain text only: labels with a background, or text that contains markup, keep the rebuild, and one getBBox per change remains because the new text has to be measured.",
      "Whether this dominates a frame depends on how many labels change per frame; the counts scale linearly with that number. Counts do not depend on hardware; the time rows do, and other pages share this machine's CPU.",
    ],
    metrics: { shipped, fixed, labels: LABELS },
  });
}
