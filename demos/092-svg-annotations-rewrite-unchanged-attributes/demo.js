const META = {
  id: "092",
  title: "Every SVG annotation rewrites its x/y (line: x1..y2) attributes on every render, even when unchanged",
  issue: "issues/092-svg-annotations-rewrite-unchanged-attributes-every-frame.md",
  severity: "low",
  claim: "SvgAnnotationBase.update() calls setAttribute('x'/'y') and SvgLineAnnotation.update() calls setAttribute on x1/y1/x2/y2 on every render, with the same values when the axes did not move. Whether that costs anything depends on the browser: the issue's hypothesis is that Chromium runs the SVG attribute-changed steps and marks the element for style and layout even for an identical value.",
  method: "<p>Part 1 (library behaviour, counts): 200 static TextAnnotations and 50 SvgLineAnnotations on a chart with fixed axes; one point per frame is appended outside the visible range, so the chart renders every frame and no annotation moves. For 90 frames the demo counts setAttribute calls made inside the annotations' update(), split by whether the new value equals the current one, and the attribute mutation records a MutationObserver sees on the annotation layer. After every render it reads the layer's getBoundingClientRect() and times it: that read pays for whatever style and layout work the render left pending.</p><p>A/B: the run is repeated with the fix from the issue at runtime (setSvgAttribute and the line's x1..y2 writes skip a value equal to getAttribute()).</p><p>Part 2 (browser probe, timing): outside SciChart, 200 nested &lt;svg&gt; labels and 50 &lt;line&gt;s with the same structure. Interleaved over 15 rounds of 20 iterations, it times a layout read after (a) no writes, (b) rewriting the same x/y/x1..y2 values and (c) writing changed values, and subtracts the cost of the writes alone. If (b) costs a noticeable fraction of (c), same-value writes dirty layout in this browser.</p>",
};

async function demo(P) {
  const { NumericAxis, NumberRange, EAutoRange, FastLineRenderableSeries, XyDataSeries, TextAnnotation, SvgLineAnnotation } = P.SciChart;
  const FRAMES = 90, TEXTS = 200, LINES = 50, POINTS = 1000;
  const EXPECTED_SAME = TEXTS * 2 + LINES * 4; // x,y per label; x1,y1,x2,y2 per line

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Never, visibleRange: new NumberRange(0, POINTS) }));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Never, visibleRange: new NumberRange(0, 10) }));
  const xs = Array.from({ length: POINTS }, (_, i) => i);
  const dataSeries = new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => 5 + 3 * Math.sin(x / 80)), isSorted: true, containsNaN: false });
  sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries, stroke: "#4e79a7", strokeThickness: 2 }));
  let nextX = POINTS;
  const appendOutside = () => { dataSeries.append(nextX, 5); nextX++; };
  for (let i = 0; i < TEXTS; i++) {
    sciChartSurface.annotations.add(new TextAnnotation({ x1: 10 + (i % 20) * 49, y1: 9.6 - Math.floor(i / 20) * 0.95, text: `T${i + 1}`, fontSize: 10, textColor: "#9c755f" }));
  }
  const lines = [];
  for (let i = 0; i < LINES; i++) {
    const vertical = i % 2 === 0;
    const k = Math.floor(i / 2);
    const l = vertical
      ? new SvgLineAnnotation({ x1: 20 + k * 39, x2: 20 + k * 39, y1: 0.3, y2: 1.3, stroke: "#59a14f", strokeThickness: 1 })
      : new SvgLineAnnotation({ x1: 20 + k * 39, x2: 50 + k * 39, y1: 0.2, y2: 0.2, stroke: "#e15759", strokeThickness: 1 });
    sciChartSurface.annotations.add(l);
    lines.push(l);
  }
  sciChartSurface.rendered.subscribe(() => P.count("chart renders"));
  await P.sleep(800);

  // ---- Part 1 counters
  const TA = TextAnnotation.prototype, SL = SvgLineAnnotation.prototype;
  let inAnn = 0, annMs = 0;
  const wrapUpdate = (proto) => {
    const own = Object.prototype.hasOwnProperty.call(proto, "update");
    const orig = proto.update;
    proto.update = function () {
      const t0 = P.now();
      inAnn++;
      try { return orig.apply(this, arguments); } finally { inAnn--; annMs += P.now() - t0; }
    };
    return () => { if (own) proto.update = orig; else delete proto.update; };
  };
  const restoreTA = wrapUpdate(TA), restoreSL = wrapUpdate(SL);
  const origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (inAnn) P.count(this.getAttribute(name) === String(value) ? "setAttribute, same value" : "setAttribute, new value");
    return origSetAttribute.apply(this, arguments);
  };
  const layer = sciChartSurface.domSvgContainer;
  const observer = new MutationObserver((records) => records.forEach((r) => {
    P.count("attribute mutation records");
    if (r.oldValue === r.target.getAttribute(r.attributeName)) P.count("attribute mutation records, value unchanged");
  }));
  observer.observe(layer, { attributes: true, subtree: true, attributeOldValue: true });
  let readMs = 0, reads = 0;
  sciChartSurface.rendered.subscribe(() => { // pays for the style/layout work the render left pending
    const t0 = performance.now();
    layer.getBoundingClientRect();
    readMs += performance.now() - t0;
    reads++;
  });

  // ---- the fix from the issue: skip writes of an unchanged value
  let setSvgOwner = Object.getPrototypeOf(TA);
  while (setSvgOwner && !Object.prototype.hasOwnProperty.call(setSvgOwner, "setSvgAttribute")) setSvgOwner = Object.getPrototypeOf(setSvgOwner);
  const origSetSvgAttribute = setSvgOwner.setSvgAttribute;
  const guardedSetSvgAttribute = function (attributeName, value) {
    const strValue = value.toString(10);
    const el = this.svg.firstElementChild;
    if (el.getAttribute(attributeName) !== strValue) el.setAttribute(attributeName, strValue);
  };
  const guardLineEls = (on) => lines.forEach((l) => {
    if (!l.lineEl) return;
    if (on) l.lineEl.setAttribute = function (n, v) { const s = String(v); if (this.getAttribute(n) !== s) Element.prototype.setAttribute.call(this, n, s); };
    else delete l.lineEl.setAttribute;
  });

  async function run(label) {
    annMs = 0; readMs = 0; reads = 0;
    const r = await P.frames(FRAMES, appendOutside);
    observer.takeRecords().forEach(() => P.count("attribute mutation records")); // (none expected here)
    const renders = Math.max(1, r.total("chart renders"));
    const res = {
      rendersPerFrame: r.total("chart renders") / FRAMES,
      same: r.total("setAttribute, same value") / renders,
      changed: r.total("setAttribute, new value") / renders,
      records: r.total("attribute mutation records") / renders,
      recordsSame: r.total("attribute mutation records, value unchanged") / renders,
      readMs: readMs / Math.max(1, reads),
      annMs: annMs / renders,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Part 1: 250 static SVG annotations, chart rendering every frame, as shipped…");
  const shipped = await run("as shipped");
  P.status("Part 1: same, with unchanged values skipped…");
  setSvgOwner.setSvgAttribute = guardedSetSvgAttribute;
  guardLineEls(true);
  const fixed = await run("with fix");
  setSvgOwner.setSvgAttribute = origSetSvgAttribute;
  guardLineEls(false);
  observer.disconnect();
  Element.prototype.setAttribute = origSetAttribute;
  restoreTA(); restoreSL();

  // ---- Part 2: browser probe, independent of SciChart
  P.status("Part 2: does this browser do layout work for same-value SVG attribute writes?…");
  const probe = await browserProbe(P, TEXTS, LINES);
  P.log(`browser probe: ${JSON.stringify(probe)}`);

  const rendered = [shipped, fixed].every((s) => s.rendersPerFrame >= 0.8);
  const countsOk = shipped.same >= EXPECTED_SAME * 0.8 && fixed.same <= EXPECTED_SAME * 0.05;
  const sensitive = probe.changedLayout >= 0.05 && probe.changedLayout >= 3 * probe.readOnly;
  const ratio = probe.changedLayout > 0 ? probe.sameLayout / probe.changedLayout : 0;
  let verdict, headline;
  if (!rendered || !countsOk || !sensitive) {
    verdict = "inconclusive";
    headline = !rendered || !countsOk
      ? `The scenario did not run as intended: ${shipped.same.toFixed(1)} same-value writes per render (expected ${EXPECTED_SAME}), ${fixed.same.toFixed(1)} with the fix, renders per frame ${shipped.rendersPerFrame.toFixed(2)} / ${fixed.rendersPerFrame.toFixed(2)}.`
      : `The library rewrites ${shipped.same.toFixed(0)} unchanged attributes per render, but the browser probe could not measure layout work reliably (changed-value layout ${probe.changedLayout.toFixed(3)} ms vs read-only ${probe.readOnly.toFixed(3)} ms). Run it again on a quieter machine.`;
  } else if (ratio >= 0.3) {
    verdict = "reproduced";
    headline = `Every render rewrites ${shipped.same.toFixed(0)} SVG attributes with unchanged values (${EXPECTED_SAME} expected: 2 per label, 4 per line), and in this browser that is not free: a layout read after same-value writes costs ${probe.sameLayout.toFixed(3)} ms vs ${probe.changedLayout.toFixed(3)} ms for changed values (${(ratio * 100).toFixed(0)}%). On the chart, the read after each render takes ${shipped.readMs.toFixed(3)} ms as shipped and ${fixed.readMs.toFixed(3)} ms with unchanged values skipped.`;
  } else if (ratio <= 0.1) {
    verdict = "not-reproduced";
    headline = `The library does rewrite ${shipped.same.toFixed(0)} unchanged SVG attributes per render, but this browser skips the work: a layout read after same-value writes costs ${probe.sameLayout.toFixed(3)} ms vs ${probe.changedLayout.toFixed(3)} ms after changed values (${(ratio * 100).toFixed(0)}%). Per the issue's own verify step, the finding should be dropped for this browser.`;
  } else {
    verdict = "inconclusive";
    headline = `The library rewrites ${shipped.same.toFixed(0)} unchanged SVG attributes per render; the probe puts same-value layout cost at ${(ratio * 100).toFixed(0)}% of a real change (${probe.sameLayout.toFixed(3)} vs ${probe.changedLayout.toFixed(3)} ms), between the "skipped" (<= 10%) and "costs" (>= 30%) thresholds.`;
  }
  P.report({
    verdict,
    headline,
    columns: ["As shipped", "With fix (unchanged values skipped)"],
    rows: [
      ["Chart renders per frame", shipped.rendersPerFrame, fixed.rendersPerFrame],
      ["setAttribute with an unchanged value, per render (inside annotation update)", shipped.same, fixed.same],
      ["setAttribute with a new value, per render", shipped.changed, fixed.changed],
      ["Attribute mutation records per render (MutationObserver)", shipped.records, fixed.records],
      ["...whose value did not change", shipped.recordsSame, fixed.recordsSame],
      ["Layout read right after each render, ms (timing)", shipped.readMs, fixed.readMs],
      ["Time in annotation update() per render, ms (timing)", shipped.annMs, fixed.annMs],
      ["Frame interval p95, ms", shipped.p95, fixed.p95],
      [`Probe: layout cost after rewriting ${probe.attrs} unchanged attributes, ms (fix column: no writes)`, probe.sameLayout, probe.readOnly],
      [`Probe control: layout cost after writing ${probe.attrs} changed attributes, ms`, probe.changedLayout, "–"],
      ["Probe: time of the writes alone (same / changed values), ms", probe.sameWrites, probe.changedWrites],
    ],
    notes: [
      "The write counts are exact. Whether a same-value write costs anything is decided inside the browser engine, which has no counter for it, so Part 2 uses timing: medians of interleaved rounds, with changed values as a positive control. Other pages share this machine's CPU, so treat the milliseconds as approximate.",
      "MutationObserver records appear for same-value writes in every browser (the DOM specification queues them), so the records row shows that the attribute-changed steps run; the layout rows show what they cost here.",
    ],
    metrics: { shipped, fixed, probe, ratio, expectedSame: EXPECTED_SAME },
  });
}

// Times a forced layout after writing unchanged vs changed SVG geometry attributes (no SciChart involved).
async function browserProbe(P, labels, lineCount) {
  const NS = "http://www.w3.org/2000/svg", ROUNDS = 15, ITER = 20;
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:-10000px;top:0;width:900px;height:500px;overflow:hidden";
  const root = document.createElementNS(NS, "svg");
  root.setAttribute("width", "900"); root.setAttribute("height", "500");
  const inner = [], lineEls = [];
  for (let i = 0; i < labels; i++) {
    const clip = document.createElementNS(NS, "svg");
    const s = document.createElementNS(NS, "svg");
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", "2"); t.setAttribute("y", "12"); t.setAttribute("font-size", "10");
    t.textContent = `T${i + 1}`;
    s.appendChild(t); clip.appendChild(s); root.appendChild(clip);
    s.setAttribute("x", String(10 + (i % 20) * 44.37)); s.setAttribute("y", String(5 + Math.floor(i / 20) * 47.11));
    inner.push(s);
  }
  for (let i = 0; i < lineCount; i++) {
    const l = document.createElementNS(NS, "line");
    l.setAttribute("x1", String(10 + i * 17)); l.setAttribute("y1", "480"); l.setAttribute("x2", String(10 + i * 17)); l.setAttribute("y2", "495");
    l.setAttribute("stroke", "#e15759");
    root.appendChild(l); lineEls.push(l);
  }
  host.appendChild(root);
  P.quiet(() => document.body.appendChild(host));
  const base = inner.map((s) => [s.getAttribute("x"), s.getAttribute("y")]);
  const lineBase = lineEls.map((l) => ["x1", "y1", "x2", "y2"].map((a) => l.getAttribute(a)));
  const write = (delta) => {
    for (let i = 0; i < inner.length; i++) {
      inner[i].setAttribute("x", delta ? String(+base[i][0] + delta) : base[i][0]);
      inner[i].setAttribute("y", delta ? String(+base[i][1] + delta) : base[i][1]);
    }
    for (let i = 0; i < lineEls.length; i++) {
      const v = lineBase[i];
      lineEls[i].setAttribute("x1", delta ? String(+v[0] + delta) : v[0]);
      lineEls[i].setAttribute("y1", v[1]);
      lineEls[i].setAttribute("x2", delta ? String(+v[2] + delta) : v[2]);
      lineEls[i].setAttribute("y2", v[3]);
    }
  };
  const read = () => root.getBoundingClientRect();
  let flip = 0;
  const modes = {
    readOnly: () => read(),
    sameWrites: () => write(0),
    sameTotal: () => { write(0); read(); },
    changedWrites: () => { flip ^= 1; write(flip ? 0.5 : 0); },
    changedTotal: () => { flip ^= 1; write(flip ? 0.5 : 0); read(); },
  };
  const samples = {};
  Object.keys(modes).forEach((k) => { samples[k] = []; });
  for (let r = 0; r < ROUNDS; r++) {
    for (const k of Object.keys(modes)) {
      write(0); read(); // start each window from a clean layout
      flip = 0;
      const t0 = performance.now();
      for (let i = 0; i < ITER; i++) modes[k]();
      samples[k].push((performance.now() - t0) / ITER);
      write(0); read();
    }
    await P.nextFrame(); // keep the page responsive between rounds
  }
  P.quiet(() => host.remove());
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const m = {};
  Object.keys(samples).forEach((k) => { m[k] = med(samples[k]); });
  return {
    attrs: labels * 2 + lineCount * 4,
    readOnly: m.readOnly,
    sameWrites: m.sameWrites,
    changedWrites: m.changedWrites,
    sameLayout: Math.max(0, m.sameTotal - m.sameWrites - m.readOnly),
    changedLayout: Math.max(0, m.changedTotal - m.changedWrites - m.readOnly),
    raw: m,
  };
}
