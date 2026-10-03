const META = {
  id: "073",
  title: "NativeTextAnnotation with wrapTo re-wraps its text on every frame, one wasm LineBounds per word",
  issue: "issues/073-nativetext-wraps-and-remeasures-every-frame.md",
  severity: "medium",
  claim: "With wrapTo set, NativeTextAnnotation.drawWithContext() calls wrapNativeText() on every render: it measures every word again in wasm (CalculateStringBounds over all words, then GetLineBounds per word, each returning a native object that is deleted at once), even when the text, font and wrap width have not changed.",
  method: "<p>48 NativeTextAnnotations, each with a 20-word text and <code>wrapTo: EWrapTo.Annotation</code> (x1..x2 sets the wrap width), on a chart whose X range is fixed. One point per frame is appended outside the visible range, so the chart renders every frame and the wrap width stays constant. Over 90 frames the demo counts, per render, NativeTextAnnotation.drawWithContext() calls, calls into wasm (<code>SCRTFont.CalculateStringBounds</code>, <code>TSRTextBounds.GetLineBounds</code>) and native TSRTextLineBounds objects created and deleted (embind handles).</p><p>A/B: the issue's app-side workaround. The wrapped string each annotation drew (captured from its DrawStringAdvanced call) is assigned to <code>text</code> and <code>wrapTo</code> is cleared, so the same lines are drawn without wrapping, and the same 90 frames are counted again. The difference is the per-frame cost of wrapTo.</p>",
};

async function demo(P) {
  const { NumericAxis, NumberRange, EAutoRange, FastLineRenderableSeries, XyDataSeries, NativeTextAnnotation, EWrapTo } = P.SciChart;
  const FRAMES = 90, COLS = 8, ROWS = 6, WORDS = 20, POINTS = 800;
  const ANNOTATIONS = COLS * ROWS;
  const VOCAB = ["sensor", "drift", "is", "within", "the", "expected", "band", "after", "the", "last", "calibration", "and", "no", "operator", "action", "is", "needed", "for", "this", "channel", "today", "check", "again", "later"];

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Never, visibleRange: new NumberRange(0, POINTS) }));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Never, visibleRange: new NumberRange(0, ROWS) }));
  const xs = Array.from({ length: POINTS }, (_, i) => i);
  const dataSeries = new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => ROWS / 2 + Math.sin(x / 50)), isSorted: true, containsNaN: false });
  sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries, stroke: "#4e79a744", strokeThickness: 2 }));
  let nextX = POINTS;
  const appendOutside = () => { dataSeries.append(nextX, ROWS / 2); nextX++; };

  const colWidth = POINTS / COLS;
  const notes = [];
  for (let i = 0; i < ANNOTATIONS; i++) {
    const c = i % COLS, r = Math.floor(i / COLS);
    const words = Array.from({ length: WORDS }, (_, k) => VOCAB[(i * 7 + k * 3) % VOCAB.length]);
    const a = new NativeTextAnnotation({
      x1: c * colWidth + 4, x2: (c + 1) * colWidth - 6, y1: ROWS - r - 0.05,
      text: words.join(" "), fontSize: 9, textColor: "#e15759", wrapTo: EWrapTo.Annotation,
    });
    sciChartSurface.annotations.add(a);
    notes.push(a);
  }
  sciChartSurface.rendered.subscribe(() => P.count("chart renders"));
  await P.sleep(800); // let the native font load

  // ---- counters
  P.watchEmbind(wasmContext, ["SCRTFont.CalculateStringBounds", "TSRTextBounds.GetLineBounds"]);
  const proto = NativeTextAnnotation.prototype;
  const origDraw = proto.drawWithContext;
  let cur = null, drawMs = 0;
  const drawn = new Map(); // annotation -> last string passed to DrawStringAdvanced
  proto.drawWithContext = function () {
    const t0 = P.now();
    cur = this;
    try { return origDraw.apply(this, arguments); } finally {
      cur = null;
      drawMs += P.now() - t0;
      P.count("NativeTextAnnotation.drawWithContext()");
    }
  };
  const fontProto = wasmContext.SCRTFont.prototype;
  const origDrawString = fontProto.DrawStringAdvanced;
  fontProto.DrawStringAdvanced = function (text) {
    if (cur) drawn.set(cur, text);
    return origDrawString.apply(this, arguments);
  };

  async function run(label) {
    drawMs = 0;
    P.native.reset();
    P.native.start();
    const r = await P.frames(FRAMES, appendOutside);
    P.native.stop();
    const lb = P.native.snapshot().TSRTextLineBounds || { created: 0, deleted: 0, live: 0 };
    const renders = Math.max(1, r.total("chart renders"));
    const draws = Math.max(1, r.total("NativeTextAnnotation.drawWithContext()"));
    const res = {
      rendersPerFrame: r.total("chart renders") / FRAMES,
      drawsPerRender: r.total("NativeTextAnnotation.drawWithContext()") / renders,
      measurePerAnn: r.total("wasm SCRTFont.CalculateStringBounds") / draws,
      lineBoundsCallsPerAnn: r.total("wasm TSRTextBounds.GetLineBounds") / draws,
      lineBoundsCreatedPerRender: lb.created / renders,
      lineBoundsDeletedPerRender: lb.deleted / renders,
      lineBoundsLive: lb.live,
      measurePerRender: r.total("wasm SCRTFont.CalculateStringBounds") / renders,
      lineBoundsCallsPerRender: r.total("wasm TSRTextBounds.GetLineBounds") / renders,
      msPerRender: drawMs / renders,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("48 wrapped notes, chart rendering every frame, as shipped…");
  const shipped = await run("as shipped (wrapTo: EWrapTo.Annotation)");

  // Workaround from the issue: insert the line breaks once and leave wrapTo unset.
  const sameLines = notes.every((a) => typeof drawn.get(a) === "string" && drawn.get(a).indexOf("\n") > 0);
  const wrappedLines = notes.reduce((n, a) => n + ((drawn.get(a) || "").split("\n").length), 0) / ANNOTATIONS;
  notes.forEach((a) => { a.text = drawn.get(a); a.wrapTo = undefined; });
  await P.idleFrames(5);
  P.status("Same notes with pre-wrapped text and wrapTo unset (workaround)…");
  const workaround = await run("workaround: pre-wrapped text, wrapTo unset");
  proto.drawWithContext = origDraw;
  fontProto.DrawStringAdvanced = origDrawString;

  const both = [shipped, workaround];
  const rendered = both.every((s) => s.rendersPerFrame >= 0.8 && s.drawsPerRender >= ANNOTATIONS * 0.8);
  const extraCalls = shipped.lineBoundsCallsPerAnn - workaround.lineBoundsCallsPerAnn;
  const extraObjects = (shipped.lineBoundsCreatedPerRender - workaround.lineBoundsCreatedPerRender) / ANNOTATIONS;
  const reproduced = rendered && sameLines && extraCalls >= WORDS * 0.8 && extraObjects >= WORDS * 0.8 && shipped.measurePerAnn - workaround.measurePerAnn >= 0.8;
  const verdict = !rendered || !sameLines ? "inconclusive" : reproduced ? "reproduced" : "not-reproduced";
  P.report({
    verdict,
    headline: verdict === "inconclusive"
      ? `The scenario did not run as intended (renders per frame ${shipped.rendersPerFrame.toFixed(2)} / ${workaround.rendersPerFrame.toFixed(2)}, annotation draws per render ${shipped.drawsPerRender.toFixed(1)}, wrapped text captured: ${sameLines}).`
      : reproduced
        ? `With nothing changing, each wrapped note makes ${shipped.lineBoundsCallsPerAnn.toFixed(1)} GetLineBounds and ${shipped.measurePerAnn.toFixed(1)} CalculateStringBounds calls per render: ${shipped.lineBoundsCreatedPerRender.toFixed(0)} native LineBounds objects created and deleted per frame for ${ANNOTATIONS} notes of ${WORDS} words. Pre-wrapped without wrapTo: ${workaround.lineBoundsCallsPerAnn.toFixed(1)}, ${workaround.measurePerAnn.toFixed(1)} and ${workaround.lineBoundsCreatedPerRender.toFixed(0)}.`
        : `Expected about ${WORDS} extra wasm word measurements per note per render from wrapTo; measured ${extraCalls.toFixed(1)} extra GetLineBounds calls and ${extraObjects.toFixed(1)} extra LineBounds objects per note.`,
    columns: ["As shipped (wrapTo)", "Workaround (pre-wrapped)"],
    rows: [
      ["Chart renders per frame", shipped.rendersPerFrame, workaround.rendersPerFrame],
      ["NativeTextAnnotation.drawWithContext() per render", shipped.drawsPerRender, workaround.drawsPerRender],
      ["wasm CalculateStringBounds per note per render", shipped.measurePerAnn, workaround.measurePerAnn],
      ["wasm GetLineBounds per note per render", shipped.lineBoundsCallsPerAnn, workaround.lineBoundsCallsPerAnn],
      ["Native TSRTextLineBounds created per render (all notes)", shipped.lineBoundsCreatedPerRender, workaround.lineBoundsCreatedPerRender],
      ["Native TSRTextLineBounds deleted per render (all notes)", shipped.lineBoundsDeletedPerRender, workaround.lineBoundsDeletedPerRender],
      ["Lines per note (same output in both columns)", wrappedLines, wrappedLines],
      ["Time in drawWithContext() per render, ms (all notes)", shipped.msPerRender, workaround.msPerRender],
      ["Frame interval p95, ms", shipped.p95, workaround.p95],
    ],
    notes: [
      "The created and deleted counts match, so nothing leaks: the cost is the JS-to-wasm calls, the string splitting and joining, and one short-lived native object per word on every frame.",
      "Here the wrap width is constant. With EWrapTo.Annotation on a moving X range, or EWrapTo.ViewRect with a moving anchor, the width changes and wrapping is needed, but the word widths still do not change; the fix in the issue caches them.",
      "Counts do not depend on hardware; the time rows do, and other pages share this machine's CPU.",
    ],
    metrics: { shipped, workaround, annotations: ANNOTATIONS, words: WORDS, wrappedLines },
  });
}
