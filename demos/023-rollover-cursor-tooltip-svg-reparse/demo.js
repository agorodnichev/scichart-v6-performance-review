const META = {
  id: "023",
  title: "Rollover and Cursor tooltip SVGs are re-parsed on every render, hidden or unchanged",
  issue: "issues/023-rollover-cursor-tooltip-svg-reparsed-every-render.md",
  severity: "high",
  claim: "While the pointer is over the series area, RolloverTooltipSvgAnnotation.update() removes each series' tooltip <svg> and parses a new one (with a feGaussianBlur filter) on every render, including tooltips that are hidden and tooltips whose content did not change. The filter id contains Date.now(), so identical content still produces new markup; CursorModifier's tooltip (showTooltip: true) does the same.",
  method: "<p>10 line series on a fixed X range (autoRange Never). Series 1-6 span the whole range, series 7-10 end at 40% of it, so with the pointer at 70% six tooltips are shown and four are rebuilt but kept hidden (their series is not hit). Scenario A: default <code>new RolloverModifier()</code>, pointer held still, one point per frame appended beyond the visible range (a full render per frame, nothing under the pointer changes). Scenario B: the same modifier, a hover sweep (one pointermove per frame, no data changes). Scenario C: <code>new CursorModifier({ showTooltip: true })</code> instead, pointer still, same stream. 90 frames each.</p><p>Per chart render the demo counts tooltip update() calls and tooltip SVG parses (annotationHelpers.createSvg called from a tooltip update), how many of those parses were for a hidden tooltip, and how many produced the same markup as that tooltip's previous parse once the time-based filter id is masked. RolloverMarkerSvgAnnotation (issue 012) is not counted.</p><p>A/B: each scenario runs again with the library fix from the issue patched in at runtime (RolloverTooltipSvgAnnotation update/create keep an attached node when it is hidden or its markup is unchanged and use a stable filter id; CursorTooltipSvgAnnotation.update re-creates only when the markup changes, with the default template's Date.now() id made stable). Patches are removed afterwards.</p>",
};

async function demo(P) {
  const {
    NumericAxis, NumberRange, EAutoRange, FastLineRenderableSeries, XyDataSeries, RolloverModifier, CursorModifier,
    RolloverTooltipSvgAnnotation, CursorTooltipSvgAnnotation, annotationHelpers, EMousePosition,
  } = P.SciChart;
  const FRAMES = 90, SERIES = 10, LONG = 6, POINTS = 1000, SHORT_POINTS = 400, POINTER_X = 0.7;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"];

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Never, visibleRange: new NumberRange(0, POINTS) }));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Never, visibleRange: new NumberRange(-1.5, SERIES * 0.6 + 1) }));
  const series = [];
  for (let s = 0; s < SERIES; s++) {
    const n = s < LONG ? POINTS : SHORT_POINTS;
    const xs = Array.from({ length: n }, (_, i) => i);
    const ds = new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 60 + s) + s * 0.6), isSorted: true, containsNaN: false });
    const rs = new FastLineRenderableSeries(wasmContext, { dataSeries: ds, stroke: COLORS[s], strokeThickness: 2, seriesName: `Series ${s + 1}` });
    sciChartSurface.renderableSeries.add(rs);
    series.push(rs);
  }
  let nextX = POINTS;
  const appendOutside = () => { series[0].dataSeries.append(nextX, Math.sin(nextX / 60)); nextX++; }; // beyond the visible range
  sciChartSurface.rendered.subscribe(() => P.count("chart renders"));
  const rollover = new RolloverModifier();
  sciChartSurface.chartModifiers.add(rollover);
  await P.sleep(500);

  // ---- attribute parses to tooltip updates
  const RT = RolloverTooltipSvgAnnotation.prototype, CT = CursorTooltipSvgAnnotation.prototype;
  const baseUpdate = Object.getPrototypeOf(RT).update; // SvgAnnotationBase.prototype.update (the class is not on the UMD namespace)
  let tooltip = null, tooltipMs = 0;
  const wrapUpdate = (proto) => {
    const orig = proto.update;
    let impl = orig;
    proto.update = function () {
      const t0 = P.now();
      tooltip = this;
      try { return impl.apply(this, arguments); } finally {
        tooltip = null;
        tooltipMs += P.now() - t0;
        P.count("tooltip update()");
      }
    };
    return { orig, set: (f) => { impl = f || orig; }, restore: () => { proto.update = orig; } };
  };
  const rtUpdate = wrapUpdate(RT), ctUpdate = wrapUpdate(CT);
  const maskId = (s) => { const m = /<filter id="([^"]+)"/.exec(s); return m ? s.split(m[1]).join("#ID#") : s; };
  const lastMasked = new WeakMap();
  const origCreateSvg = annotationHelpers.createSvg;
  annotationHelpers.createSvg = function (svgString) {
    if (tooltip) {
      P.count("tooltip SVG parses");
      if (tooltip.isHidden) P.count("parses for a hidden tooltip");
      if (svgString.indexOf("<filter") >= 0) P.count("new <filter> elements");
      const masked = maskId(svgString);
      if (lastMasked.get(tooltip) === masked) P.count("parses with unchanged markup (id masked)");
      lastMasked.set(tooltip, masked);
    }
    return origCreateSvg.apply(this, arguments);
  };

  // ---- the library fix from the issue, as runtime patches
  const origRtCreate = RT.create, origGenerate = RT.generateSvgString;
  const fixedRtUpdate = function (xCalc, yCalc, xT, yT) {
    const pos = this.tooltipProps.rolloverModifier.getMousePosition();
    if (this.previousMousePosition === pos && pos !== EMousePosition.SeriesArea) return;
    this.previousMousePosition = pos;
    if (this.placementDivId) {
      if (this.svg) this.clear();
      this.updateExternalLegendTooltip();
    } else {
      if (this.svgLegend) { this.svgLegend.remove(); this.svgLegend = undefined; }
      baseUpdate.call(this, xCalc, yCalc, xT, yT);
      this.updateLegendTooltip(xT, yT);
    }
  };
  const fixedRtCreate = function () {
    const attached = !!this.svg && this.svg.parentNode === this.svgRoot;
    if (attached && this.isHidden) return; // hidden: keep the node, skip template and parse
    const svgString = this.seriesInfo ? this.generateSvgString() : "<svg></svg>";
    const clipped = this.applyClipping(svgString, this.clipping);
    if (attached && clipped === this.__fixLastSvg) return; // same markup: update() only moves it
    if (attached) this.svgRoot.removeChild(this.svg);
    this.__fixLastSvg = clipped;
    this.setSvg(annotationHelpers.createSvg(clipped, this.svgRoot, this.nextSibling));
  };
  const fixedGenerate = function () { // stable filter id per annotation instead of Date.now()
    const s = origGenerate.call(this);
    const m = /<filter id="([^"]+)"/.exec(s);
    const idTitle = ("" + this.tooltipProps.tooltipTitle).replace(/\s/g, "");
    return m ? s.split(m[1]).join(`id_${this.id}_${idTitle}`) : s;
  };
  const fixedCtUpdate = function (xCalc, yCalc, xT, yT) {
    const pos = this.cursorModifier.getMousePosition();
    if (this.previousMousePosition === pos && pos !== EMousePosition.SeriesArea) return;
    this.previousMousePosition = pos;
    const svgString = this.svgString != null ? this.svgString : this.tooltipSvgTemplate(this.seriesInfos, this);
    const key = this.applyClipping(svgString, this.clipping);
    if (!this.svg || this.placementDivId || key !== this.__fixLastKey) {
      if (this.svg) this.clear();
      this.__fixLastKey = key;
      this.create(xCalc, yCalc, xT, yT);
    }
    if (this.placementDivId) this.updateExternalLegendTooltip();
    else { this.updateTooltip(xT, yT); this.updateLegendTooltip(xT, yT); }
  };
  const fixRollover = (on) => {
    rtUpdate.set(on ? fixedRtUpdate : null);
    RT.create = on ? fixedRtCreate : origRtCreate;
    RT.generateSvgString = on ? fixedGenerate : origGenerate;
  };

  // ---- scenarios
  const pointer = P.pointer(sciChartSurface);
  async function run(label, perFrame) {
    tooltipMs = 0;
    const r = await P.frames(FRAMES, perFrame);
    const renders = Math.max(1, r.total("chart renders"));
    const res = {
      rendersPerFrame: r.total("chart renders") / FRAMES,
      updates: r.total("tooltip update()") / renders,
      parses: r.total("tooltip SVG parses") / renders,
      hiddenParses: r.total("parses for a hidden tooltip") / renders,
      sameParses: r.total("parses with unchanged markup (id masked)") / renders,
      filters: r.total("new <filter> elements") / renders,
      ms: tooltipMs / renders,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("A: RolloverModifier, pointer still, streaming outside the visible range…");
  pointer.enter(POINTER_X, 0.5);
  await P.idleFrames(10);
  const aShipped = await run("A rollover, still pointer + stream, as shipped", () => appendOutside());
  fixRollover(true);
  const aFixed = await run("A rollover, still pointer + stream, with fix", () => appendOutside());
  fixRollover(false);

  P.status("B: RolloverModifier, hover sweep…");
  const sweep = (i) => pointer.move(0.45 + 0.4 * Math.abs(((i % 40) / 20) - 1), 0.5); // stays right of the short series
  const bShipped = await run("B rollover, hover sweep, as shipped", sweep);
  fixRollover(true);
  const bFixed = await run("B rollover, hover sweep, with fix", sweep);
  fixRollover(false);
  pointer.leave();
  await P.idleFrames(5);

  P.status("C: CursorModifier({ showTooltip: true }), pointer still, streaming…");
  sciChartSurface.chartModifiers.remove(rollover);
  const cursor = new CursorModifier({ showTooltip: true });
  sciChartSurface.chartModifiers.add(cursor);
  await P.idleFrames(5);
  pointer.enter(POINTER_X, 0.5);
  await P.idleFrames(10);
  const cShipped = await run("C cursor tooltip, still pointer + stream, as shipped", () => appendOutside());
  const ann = cursor.tooltipAnnotation;
  const origTemplate = ann.tooltipSvgTemplate;
  ann.tooltipSvgTemplate = (infos, a) => origTemplate(infos, a).replace(/id_\d{10,}/g, `id_${a.id}`); // stable id, as in the fix
  ctUpdate.set(fixedCtUpdate);
  await P.idleFrames(3);
  const cFixed = await run("C cursor tooltip, still pointer + stream, with fix", () => appendOutside());
  ctUpdate.set(null);
  ann.tooltipSvgTemplate = origTemplate;
  pointer.leave();

  rtUpdate.restore();
  ctUpdate.restore();
  annotationHelpers.createSvg = origCreateSvg;

  const HIDDEN = SERIES - LONG;
  const all = [aShipped, aFixed, bShipped, bFixed, cShipped, cFixed];
  const rendered = all.every((s) => s.rendersPerFrame >= 0.8);
  const aOk = aShipped.parses >= SERIES * 0.8 && aShipped.hiddenParses >= HIDDEN * 0.8 && aShipped.sameParses >= SERIES * 0.8;
  const cOk = cShipped.parses >= 0.8 && cShipped.sameParses >= 0.8;
  const fixOk = aFixed.parses <= SERIES * 0.1 && cFixed.parses <= 0.1;
  const reproduced = rendered && aOk && cOk && fixOk;
  const verdict = !rendered ? "inconclusive" : reproduced ? "reproduced" : "not-reproduced";
  P.report({
    verdict,
    headline: !rendered
      ? `The chart stopped rendering in at least one run (renders per frame: ${all.map((s) => s.rendersPerFrame.toFixed(2)).join(", ")}), so the counts cannot be compared. See the console.`
      : reproduced
      ? `With the pointer still on a streaming chart, every render re-parses ${aShipped.parses.toFixed(1)} rollover tooltip SVGs (${aShipped.hiddenParses.toFixed(1)} of them hidden, ${aShipped.sameParses.toFixed(1)} with unchanged content) and the cursor tooltip ${cShipped.parses.toFixed(2)} times. With the fix: ${aFixed.parses.toFixed(2)} and ${cFixed.parses.toFixed(2)}; hover sweep ${bShipped.parses.toFixed(1)} -> ${bFixed.parses.toFixed(1)}.`
      : `Expected ${SERIES} rollover tooltip parses per render (${HIDDEN} hidden, all unchanged) and 1 cursor tooltip parse with a still pointer; measured ${aShipped.parses.toFixed(2)} (${aShipped.hiddenParses.toFixed(2)} hidden, ${aShipped.sameParses.toFixed(2)} unchanged) and ${cShipped.parses.toFixed(2)}; with the fix ${aFixed.parses.toFixed(2)} and ${cFixed.parses.toFixed(2)}.`,
    columns: ["A rollover, still: as shipped", "with fix", "B rollover sweep: as shipped", "with fix", "C cursor, still: as shipped", "with fix"],
    rows: [
      ["Chart renders per frame", ...all.map((s) => s.rendersPerFrame)],
      ["Tooltip update() calls per render", ...all.map((s) => s.updates)],
      ["Tooltip SVG parses per render", ...all.map((s) => s.parses)],
      ["...for a hidden tooltip", ...all.map((s) => s.hiddenParses)],
      ["...with the same markup as that tooltip's last parse (filter id masked)", ...all.map((s) => s.sameParses)],
      ["New <filter> (feGaussianBlur) elements per render", ...all.map((s) => s.filters)],
      ["Time in tooltip update() per render, ms", ...all.map((s) => s.ms)],
      ["Frame interval p95, ms", ...all.map((s) => s.p95)],
    ],
    notes: [
      "In the sweep the values under the pointer change every frame, so the fixed version still re-parses the six shown tooltips; it skips the four hidden ones.",
      "Each parse also inserts a new <filter> with feGaussianBlur, which the browser has to style and rasterize again on the next paint. Counts do not depend on hardware; the time rows do, and other pages share this machine's CPU.",
      "The rollover markers re-parse too (issue 012); they are not part of these counts.",
    ],
    metrics: { aShipped, aFixed, bShipped, bFixed, cShipped, cFixed, series: SERIES, hidden: HIDDEN },
  });
}
