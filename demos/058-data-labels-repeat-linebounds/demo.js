const META = {
  id: "058",
  title: "Data labels make 2-3 native GetLineBounds allocations per label per render, loop-invariant for text series",
  issue: "issues/058-data-labels-repeat-native-linebounds-per-label.md",
  severity: "medium",
  claim: "For every label on every render, the data-label providers ask the engine again for the first-line bounds of the text they just measured. Each TSRTextBounds.GetLineBounds call allocates a native TSRTextLineBounds plus a JS handle and frees it again; line labels do this 2-3 times per label, and TextDataLabelProvider twice per label although (with calculateTextBounds false, the default) the text is measured once per render.",
  method: "<p>Two charts. (a) FastTextRenderableSeries over an XyTextDataSeries of 5,000 visible points (default TextDataLabelProvider). (b) FastLineRenderableSeries with <code>dataLabels.style</code> set on 2,000 points (LineSeriesDataLabelProvider). Each run forces 30 renders of one chart with <code>invalidateElement()</code>, one per frame.</p><p>Counted per run, inside the provider's <code>generateDataLabels</code>: labels positioned (<code>getPosition</code> calls), wasm <code>TSRTextBounds.GetLineBounds</code> calls, text measurements (<code>CalculateStringBounds</code>), wasm <code>SCRTDoubleVector.get</code> calls, and over the whole run native <code>TSRTextLineBounds</code> handles created vs deleted; time in <code>generateDataLabels</code> as secondary evidence.</p><p>A/B: what the issue's fix does (read line 0 once per measurement), emulated at the binding: after a text measurement writes into a TSRTextBounds, the first <code>GetLineBounds(0)</code> goes to the engine and later calls for the same measurement get a plain copy of its four fields. The generated labels (text, position, rect) are compared between the two runs.</p>",
};

async function demo(P) {
  const { NumericAxis, NumberRange, FastTextRenderableSeries, XyTextDataSeries, FastLineRenderableSeries, XyDataSeries } = P.SciChart;
  const TEXT_POINTS = 5000, LINE_POINTS = 2000, FRAMES = 30;

  async function chart(div, build) {
    const { sciChartSurface, wasmContext } = await P.createSurface(div);
    const rs = build(sciChartSurface, wasmContext);
    sciChartSurface.renderableSeries.add(rs);
    let renders = 0;
    sciChartSurface.rendered.subscribe(() => { renders++; });
    return { sciChartSurface, wasmContext, rs, renders: () => renders };
  }
  const text = await chart("chart-text", (s, wasm) => {
    s.xAxes.add(new NumericAxis(wasm, { visibleRange: new NumberRange(-5, 105) }));
    s.yAxes.add(new NumericAxis(wasm, { visibleRange: new NumberRange(-2, 52) }));
    const xs = [], ys = [], ts = [];
    for (let i = 0; i < TEXT_POINTS; i++) { xs.push(i % 100); ys.push(Math.floor(i / 100)); ts.push(String(i % 97)); }
    return new FastTextRenderableSeries(wasm, {
      dataSeries: new XyTextDataSeries(wasm, { xValues: xs, yValues: ys, textValues: ts }),
      dataLabels: { style: { fontSize: 8 }, color: "#4e79a7" },
    });
  });
  const line = await chart("chart-line", (s, wasm) => {
    s.xAxes.add(new NumericAxis(wasm));
    s.yAxes.add(new NumericAxis(wasm, { growBy: new NumberRange(0.1, 0.1) }));
    const xs = Array.from({ length: LINE_POINTS }, (_, i) => i);
    return new FastLineRenderableSeries(wasm, {
      dataSeries: new XyDataSeries(wasm, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 9) * 10 + Math.sin(x / 2.3) * 3), isSorted: true, containsNaN: false }),
      stroke: "#f28e2b", strokeThickness: 1,
      dataLabels: { style: { fontFamily: "Arial", fontSize: 8 }, color: "#9c755f" },
    });
  });
  const wasmContext = text.wasmContext;
  await P.sleep(800);

  // ---- counters: everything below is attributed to label generation through the inGen flag
  let inGen = false, genMs = 0, capture = null;
  [text, line].forEach((c) => {
    const prov = c.rs.dataLabelProvider, gen = prov.generateDataLabels, pos = prov.getPosition;
    prov.generateDataLabels = function () {
      inGen = true;
      const t0 = P.now();
      try { return gen.apply(this, arguments); } finally {
        genMs += P.now() - t0;
        inGen = false;
        P.count("generateDataLabels calls");
        // labels are cleared after drawing, so copy them here when asked (outside the measured runs)
        if (capture && capture.provider === this) capture.labels = (this.dataLabels || []).map((l) => [l.text, l.position.x, l.position.y, l.rect.x, l.rect.y, l.rect.width, l.rect.height].join("|"));
      }
    };
    prov.getPosition = function () { P.count("labels positioned (getPosition)"); return pos.apply(this, arguments); };
  });
  const TB = wasmContext.TSRTextBounds.prototype;
  P.hookMethod(TB, "GetLineBounds", { name: "GetLineBounds (all)", onCall: () => { if (inGen) P.count("wasm GetLineBounds, label generation"); } });
  P.hookMethod(wasmContext.SCRTDoubleVector.prototype, "get", { name: "SCRTDoubleVector.get (all)", onCall: () => { if (inGen) P.count("wasm SCRTDoubleVector.get, label generation"); } });
  // Measurements: every writer of a TSRTextBounds bumps its version (used by the fix emulation below).
  const version = new Map();
  const bump = (bounds) => { if (bounds && bounds.$$) version.set(bounds.$$.ptr, (version.get(bounds.$$.ptr) || 0) + 1); };
  let fontProto = null;
  for (const k of ["SCRTFont", "TSRFont"]) {
    let p = wasmContext[k] && wasmContext[k].prototype;
    while (p && !Object.prototype.hasOwnProperty.call(p, "CalculateStringBounds")) p = Object.getPrototypeOf(p);
    if (p) { fontProto = p; break; }
  }
  if (fontProto) P.hookMethod(fontProto, "CalculateStringBounds", { name: "CalculateStringBounds (all)", onCall: (a) => { bump(a[1]); if (inGen) P.count("text measurements, label generation"); } });
  P.hookMethod(wasmContext, "SCRTMeasureStringFromDict", { name: "SCRTMeasureStringFromDict", onCall: (a) => bump(a[3]) });

  // ---- fix emulation: one native GetLineBounds(0) per measurement, later reads of the same measurement get a copy
  const countedGetLineBounds = TB.GetLineBounds;
  const cache = new Map();
  let useFix = false;
  TB.GetLineBounds = function (i) {
    if (!useFix || i !== 0 || !this.$$) return countedGetLineBounds.call(this, i);
    const ptr = this.$$.ptr, v = version.get(ptr) || 0, hit = cache.get(ptr);
    if (hit && hit.v === v) return hit.copy;
    const lb = countedGetLineBounds.call(this, 0);
    cache.set(ptr, { v, copy: { m_fWidth: lb.m_fWidth, m_fHeight: lb.m_fHeight, m_fOffsetX: lb.m_fOffsetX, m_fOffsetY: lb.m_fOffsetY, delete() {}, isDeleted() { return false; } } });
    return lb;
  };

  async function snapshotLabels(c) {
    capture = { provider: c.rs.dataLabelProvider, labels: null };
    c.sciChartSurface.invalidateElement();
    for (let i = 0; i < 10 && !capture.labels; i++) await P.nextFrame();
    const labels = capture.labels || [];
    capture = null;
    return labels;
  }
  async function run(label, c, other) {
    await P.idleFrames(3);
    const r0 = c.renders(), o0 = other.renders();
    genMs = 0;
    P.native.reset();
    P.native.start();
    const r = await P.frames(FRAMES, () => c.sciChartSurface.invalidateElement());
    P.native.stop();
    const tl = P.native.snapshot().TSRTextLineBounds || { created: 0, deleted: 0 };
    const renders = c.renders() - r0, labels = r.total("labels positioned (getPosition)");
    const perLabel = (v) => v / Math.max(1, labels);
    const res = {
      renders, otherRenders: other.renders() - o0, generations: r.total("generateDataLabels calls"),
      labelsPerRender: labels / Math.max(1, renders),
      glbPerLabel: perLabel(r.total("wasm GetLineBounds, label generation")),
      glbPerRender: r.total("wasm GetLineBounds, label generation") / Math.max(1, renders),
      measuresPerLabel: perLabel(r.total("text measurements, label generation")),
      getPerLabel: perLabel(r.total("wasm SCRTDoubleVector.get, label generation")),
      created: tl.created, deleted: tl.deleted, createdPerRender: tl.created / Math.max(1, renders),
      genMsPerRender: genMs / Math.max(1, renders),
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    res.labels = await snapshotLabels(c);
    return res;
  }

  P.status("(a) Text series, 5,000 labels, as shipped…");
  const textShipped = await run("(a) text series, as shipped", text, line);
  P.status("(b) Line series labels, as shipped…");
  const lineShipped = await run("(b) line series labels, as shipped", line, text);
  useFix = true;
  P.status("(a) Text series, line bounds read once per measurement…");
  const textFixed = await run("(a) text series, with fix", text, line);
  P.status("(b) Line series labels, line bounds read once per measurement…");
  const lineFixed = await run("(b) line series labels, with fix", line, text);
  useFix = false;
  TB.GetLineBounds = countedGetLineBounds;

  const same = (a, b) => a.labels.length > 0 && a.labels.length === b.labels.length && a.labels.every((s, i) => s === b.labels[i]);
  const textSame = same(textShipped, textFixed), lineSame = same(lineShipped, lineFixed);
  const valid = textShipped.labelsPerRender >= TEXT_POINTS * 0.9 && lineShipped.labelsPerRender >= 100 && !!fontProto;
  const reproduced = valid && textShipped.glbPerLabel >= 1.9 && lineShipped.glbPerLabel >= 1.9 &&
    textFixed.glbPerRender <= 2 && lineFixed.glbPerLabel <= 1.05 && textSame && lineSame;
  P.report({
    verdict: !valid ? "inconclusive" : reproduced ? "reproduced" : "not-reproduced",
    headline: !valid
      ? `The labels were not generated as intended (text labels per render: ${textShipped.labelsPerRender.toFixed(0)}, line labels per render: ${lineShipped.labelsPerRender.toFixed(0)}, font hook: ${!!fontProto}).`
      : reproduced
        ? `Text series: ${textShipped.glbPerLabel.toFixed(2)} native GetLineBounds calls per label (${Math.round(textShipped.glbPerRender).toLocaleString("en-US")} per render) for text measured ${textShipped.measuresPerLabel < 0.01 ? "once per render" : textShipped.measuresPerLabel.toFixed(2) + " times per label"}; line labels: ${lineShipped.glbPerLabel.toFixed(2)} per label. Read once per measurement: ${Math.round(textFixed.glbPerRender)} per render and ${lineFixed.glbPerLabel.toFixed(2)} per label, identical labels.`
        : `Expected 2 or more GetLineBounds calls per label; measured ${textShipped.glbPerLabel.toFixed(2)} (text series) and ${lineShipped.glbPerLabel.toFixed(2)} (line labels); with the fix ${textFixed.glbPerRender.toFixed(1)} per render and ${lineFixed.glbPerLabel.toFixed(2)} per label; labels identical: ${textSame} / ${lineSame}.`,
    columns: ["(a) Text, as shipped", "(a) Text, read once", "(b) Line labels, as shipped", "(b) Line labels, read once"],
    rows: [
      ["Renders", textShipped.renders, textFixed.renders, lineShipped.renders, lineFixed.renders],
      ["Labels positioned per render", textShipped.labelsPerRender, textFixed.labelsPerRender, lineShipped.labelsPerRender, lineFixed.labelsPerRender],
      ["Text measurements per label", textShipped.measuresPerLabel, textFixed.measuresPerLabel, lineShipped.measuresPerLabel, lineFixed.measuresPerLabel],
      ["wasm GetLineBounds calls per label", textShipped.glbPerLabel, textFixed.glbPerLabel, lineShipped.glbPerLabel, lineFixed.glbPerLabel],
      ["wasm GetLineBounds calls per render", textShipped.glbPerRender, textFixed.glbPerRender, lineShipped.glbPerRender, lineFixed.glbPerRender],
      ["Native TSRTextLineBounds allocated (and freed) per render", textShipped.createdPerRender, textFixed.createdPerRender, lineShipped.createdPerRender, lineFixed.createdPerRender],
      ["wasm SCRTDoubleVector.get calls per label", textShipped.getPerLabel, textFixed.getPerLabel, lineShipped.getPerLabel, lineFixed.getPerLabel],
      ["Time in generateDataLabels per render, ms", textShipped.genMsPerRender, textFixed.genMsPerRender, lineShipped.genMsPerRender, lineFixed.genMsPerRender],
    ],
    notes: [
      `Generated labels (text, position, rect) identical between the two runs: text series ${textSame ? "yes" : "no"} (${textShipped.labels.length} labels), line series ${lineSame ? "yes" : "no"} (${lineShipped.labels.length} labels kept after overlap skipping).`,
      `Every allocation is freed again (TSRTextLineBounds created ${textShipped.created + lineShipped.created}, deleted ${textShipped.deleted + lineShipped.deleted} as shipped): this is churn, not a leak. Each call is a JS-to-wasm call, a native malloc, a JS handle and a delete() (wasm free).`,
      "Line labels: 1 read in getPosition, 1 more in getTextHeightToBaseline when the line rises (label drawn below), and 1 in generateDataLabels. Text series: 1 in getPosition and 1 in generateDataLabels, both on bounds measured once before the loop. The text series also reads indexes.get() through embind once per label (the SCRTDoubleVector.get row).",
      "Counts do not depend on hardware; the time row includes the counting hooks. The fix column is an emulation at the binding level of the provider-level cache in the issue; the native call counts are what that fix would leave.",
    ],
    metrics: {
      textShipped: { ...textShipped, labels: undefined }, textFixed: { ...textFixed, labels: undefined },
      lineShipped: { ...lineShipped, labels: undefined }, lineFixed: { ...lineFixed, labels: undefined }, textSame, lineSame,
    },
  });
}
