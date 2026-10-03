const META = {
  id: "064",
  title: "The 3D tooltip tears down and re-parses its SVG on every pointer move over the same point",
  issue: "issues/064-3d-tooltip-svg-reparsed-every-pointer-move.md",
  severity: "medium",
  claim: "TooltipSvgAnnotation3D.update() removes the tooltip SVG and parses a new one whenever any property changed, including x1/y1 on a plain pointer move. The default template also embeds Date.now() in a filter id, so the markup never repeats and could not be reused anyway.",
  method: "<p>One ScatterRenderableSeries3D with a single large sphere marker in the middle of the chart, and a default TooltipModifier3D. The pointer enters over the sphere and then jitters by a few pixels for 120 frames (one pointermove per frame), staying on the same data point. Per frame the demo counts tooltip SVG parses (Range.createContextualFragment), DOM node insertions and removals, renders, and frames whose tooltip shows the same point.</p><p>Three runs: as shipped; with the issue's update() fix only (rebuild the DOM only when the template output changed, patched onto TooltipSvgAnnotation3D.prototype); and with that fix plus a stable filter id in the template (the issue's id_${svgAnnotation.id}, applied by wrapping the modifier's tooltipSvgTemplate). Patches are removed afterwards.</p>",
};

async function demo(P) {
  const { NumericAxis3D, ScatterRenderableSeries3D, XyzDataSeries3D, SpherePointMarker3D, TooltipModifier3D, TooltipSvgAnnotation3D, NumberRange, Vector3, Point } = P.SciChart;
  const FRAMES = 120;

  const { sciChart3DSurface: scs, wasmContext: wasm } = await P.createSurface3D("chart", { worldDimensions: new Vector3(200, 200, 200) });
  for (const k of ["xAxis", "yAxis", "zAxis"]) scs[k] = new NumericAxis3D(wasm, { visibleRange: new NumberRange(0, 1) });
  const rs = new ScatterRenderableSeries3D(wasm, {
    dataSeries: new XyzDataSeries3D(wasm, { xValues: [0.5], yValues: [0.5], zValues: [0.5] }),
    pointMarker: new SpherePointMarker3D(wasm, { size: 200, fill: "#4e79a7" }),
  });
  scs.renderableSeries.add(rs);
  const tooltip = new TooltipModifier3D();
  scs.chartModifiers.add(tooltip);
  await P.sleep(800);

  // Find the sphere's footprint on screen with series.hitTest() and aim at its centre.
  const pointer = P.pointer(scs);
  const dpr = window.devicePixelRatio, rect = pointer.rect;
  const hits = [];
  for (let fy = 0.2; fy <= 0.8; fy += 0.01) {
    for (let fx = 0.3; fx <= 0.7; fx += 0.005) {
      const hit = rs.hitTest(new Point(fx * rect.width * dpr, fy * rect.height * dpr));
      if (hit && hit.isHit) hits.push([fx, fy]);
    }
  }
  const spot = hits.length ? { fx: hits.reduce((a, h) => a + h[0], 0) / hits.length, fy: hits.reduce((a, h) => a + h[1], 0) / hits.length } : null;
  if (!spot) {
    P.report({ verdict: "inconclusive", headline: "No pointer position over the marker was found with series.hitTest(), so the scenario could not start.", rows: [] });
    return;
  }
  const footprint = { w: (Math.max(...hits.map((h) => h[0])) - Math.min(...hits.map((h) => h[0]))) * rect.width, h: (Math.max(...hits.map((h) => h[1])) - Math.min(...hits.map((h) => h[1]))) * rect.height };
  P.log(`marker footprint about ${footprint.w.toFixed(0)} x ${footprint.h.toFixed(0)} CSS px, aiming at (${spot.fx.toFixed(3)}, ${spot.fy.toFixed(3)})`);

  P.watch.domWrites();
  P.hookMethod(scs.sciChart3DRenderer, "render", { name: "3D render()" });
  P.hookMethod(TooltipSvgAnnotation3D.prototype, "create", { name: "tooltip create()", time: true });

  async function jitter(label) {
    pointer.enter(spot.fx, spot.fy);
    await P.idleFrames(5);
    let samePoint = 0;
    const px = 1 / rect.width, py = 1 / rect.height; // one CSS pixel as a fraction of the canvas
    const r = await P.frames(FRAMES, (i) => {
      pointer.move(spot.fx + px * 3 * Math.sin(i * 0.9), spot.fy + py * 3 * Math.cos(i * 0.7));
      const si = tooltip.tooltipAnnotation.seriesInfo;
      if (si && si.isHit && si.dataSeriesIndex === 0) samePoint++;
    });
    pointer.leave();
    await P.idleFrames(5);
    const res = {
      parses: r.perFrame("createContextualFragment (HTML/SVG parse)"),
      inserts: r.perFrame("DOM appendChild") + r.perFrame("DOM insertBefore"),
      removes: r.perFrame("DOM removeChild"),
      renders: r.perFrame("3D render()"),
      samePointFrames: samePoint,
      createMs: r.perFrame("tooltip create()", "t"),
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Pointer jittering over one point, library as shipped…");
  const shipped = await jitter("as shipped");

  // The issue's update() fix: run the template, rebuild the DOM only if its output changed.
  const proto = TooltipSvgAnnotation3D.prototype;
  const origUpdate = proto.update, origClear = proto.clear;
  proto.update = function (xCalc, yCalc, xCoordSvgTrans, yCoordSvgTrans) {
    if (!this.isDirty) return;
    this.isDirty = false;
    if (!this.tooltipSvgTemplate) throw Error("Please provide a tooltipSvgTemplate for CursorTooltipSvgAnnotation");
    const svgString = this.applySvgClipping(this.tooltipSvgTemplate(this.seriesInfo, this), this.clipping);
    if (!this.svg || svgString !== this.lastSvgString) {
      if (this.svg) this.clear();
      this.lastSvgString = svgString;
      this.create(xCalc, yCalc, xCoordSvgTrans, yCoordSvgTrans);
    }
    if (this.placementDivId) {
      this.updateExternalLegendTooltip();
    } else {
      this.updateTooltip(xCoordSvgTrans, yCoordSvgTrans);
      this.updateLegendTooltip();
    }
  };
  proto.clear = function () { this.lastSvgString = undefined; return origClear.apply(this, arguments); };
  P.status("Same jitter, update() fix only (template still embeds Date.now())…");
  const updateOnly = await jitter("update() fix, Date.now() filter id");

  // Plus the stable filter id from the issue (id_${svgAnnotation.id} instead of id_${Date.now()}).
  const template = tooltip.tooltipSvgTemplate;
  tooltip.tooltipSvgTemplate = (seriesInfo, annotation) => template(seriesInfo, annotation).replace(/id_\d+/g, "id_" + annotation.id);
  P.status("Same jitter, update() fix + stable filter id…");
  const fixed = await jitter("update() fix + stable filter id");

  tooltip.tooltipSvgTemplate = template;
  proto.update = origUpdate;
  proto.clear = origClear;

  const onPoint = shipped.samePointFrames >= FRAMES * 0.9 && fixed.samePointFrames >= FRAMES * 0.9;
  const reproduced = onPoint && shipped.parses >= 0.8 && updateOnly.parses >= 0.8 && fixed.parses <= 0.1;
  P.report({
    verdict: !onPoint ? "inconclusive" : reproduced ? "reproduced" : "not-reproduced",
    headline: !onPoint
      ? `The pointer did not stay on the same point (${shipped.samePointFrames}/${FRAMES} frames), so the runs are not comparable.`
      : reproduced
        ? `Moving a few pixels over the same point re-parses the tooltip SVG ${shipped.parses.toFixed(2)} times per frame. Comparing the markup alone does not help (${updateOnly.parses.toFixed(2)}/frame, the Date.now() filter id changes every time); with a stable id too: ${fixed.parses.toFixed(3)}/frame.`
        : `Expected about one tooltip parse per frame as shipped; measured ${shipped.parses.toFixed(2)} (update fix only ${updateOnly.parses.toFixed(2)}, full fix ${fixed.parses.toFixed(3)}).`,
    columns: ["As shipped", "update() fix only", "update() fix + stable filter id"],
    rows: [
      ["Pointer moves per frame", 1, 1, 1],
      [`Frames showing the same data point (of ${FRAMES})`, shipped.samePointFrames, updateOnly.samePointFrames, fixed.samePointFrames],
      ["Renders per frame", shipped.renders, updateOnly.renders, fixed.renders],
      ["Tooltip SVG parses per frame", shipped.parses, updateOnly.parses, fixed.parses],
      ["DOM insertions per frame", shipped.inserts, updateOnly.inserts, fixed.inserts],
      ["DOM removals per frame", shipped.removes, updateOnly.removes, fixed.removes],
      ["Time in TooltipSvgAnnotation3D.create() per frame, ms", shipped.createMs, updateOnly.createMs, fixed.createMs],
    ],
    notes: [
      "The tooltip shows the same point and the same values in every frame; only x1/y1 change. With both parts of the fix the existing SVG is moved by updateTooltip()'s x/y attribute writes. Each parse also creates a new <filter> with feGaussianBlur, which the browser has to style, lay out and paint. Counts do not depend on hardware; the time row does.",
      "A tooltipLegendTemplate, when set, adds a second parse per update (updateLegendTooltip); this demo uses the default tooltip only.",
    ],
    metrics: { spot, shipped, updateOnly, fixed },
  });
}
