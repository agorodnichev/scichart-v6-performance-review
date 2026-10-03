const META = {
  id: "049",
  title: "Pie label placement forces one synchronous layout per labelled segment on every draw",
  issue: "issues/049-pie-label-forced-layout-per-segment.md",
  severity: "medium",
  claim: "SciChartPieSurface.drawSegmentLabel writes a label's styles and innerHTML, reads offsetWidth/offsetHeight, then writes left/top before moving to the next label. Every read follows a write, so the browser runs style and layout synchronously once per labelled segment on every pie draw instead of once per draw.",
  method: "<p>A 12-segment pie with <code>animate: false</code> (each property set is one synchronous draw) and default labels. For 60 frames one segment value is set per frame. The harness counts every layout read (offsetWidth, getBoundingClientRect, …) and flags a read as a forced layout when a DOM or style write (appendChild, innerHTML, style.left/top, …) happened before it in the same frame. The demo also counts the offsetWidth/offsetHeight reads made inside label placement and times the offsetWidth/offsetHeight getters, which is where the forced style and layout runs.</p><p>Then the fix from the issue is applied at runtime: <code>drawSegmentLabel</code> only writes the label (lines 706-726) and queues it; after the pie's <code>drawChart</code> the queued labels are measured in one pass and then positioned with the original <code>calcTitlePosition</code> arithmetic (lines 729-751). The same 60 frames run again, and the final label positions of both runs are compared.</p>",
};

async function demo(P) {
  const { PieSegment, SciChartPieSurface, getFontFamily } = P.SciChart;
  const N = 12, FRAMES = 60;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac", "#86bcb6", "#d37295"];
  const VALUES = [18, 15, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3];

  const pie = await P.createPie("chart", { animate: false, showLegend: false });
  const segs = VALUES.map((value, i) => new PieSegment({ value, text: `S${i + 1}`, color: COLORS[i] }));
  pie.pieSegments.add(...segs);
  await P.idleFrames(10);

  P.watch.layout();
  const proto = SciChartPieSurface.prototype;
  const shippedLabel = proto.drawSegmentLabel;
  let inLabel = false;
  P.hookMethod(proto, "draw", { name: "pie draw()", time: true });
  ["offsetWidth", "offsetHeight"].forEach((p) => P.hookAccessor(HTMLElement.prototype, p, { name: `${p} (attribution)`, onGet: () => { if (inLabel) P.count("label size reads"); } }));

  // Wrapper used in both runs: counts labels and attributes the size reads to label code.
  const counted = (impl) => function () {
    P.count("labels drawn");
    inLabel = true;
    try { return impl.apply(this, arguments); } finally { inLabel = false; }
  };

  // ---- the fix from the issue: writeSegmentLabel / placeSegmentLabel, measured in one pass
  function writeLabel(el, index, totalValue) { // SciChartPieSurface.js:706-726
    if (el.showLabel === false) return undefined;
    const labelDivId = "segment" + index;
    let div = this.titleDivs.find((d) => d.id === labelDivId);
    if (!div) {
      div = document.createElement("div");
      div.className = "scichart-pie-text-container";
      div.id = labelDivId;
      div.style.position = "absolute";
      div.style.pointerEvents = "none";
      div.style.padding = "5px";
      div.style.borderRadius = "3px";
      this.titleDivs.push(div);
      this.domDivContainer.appendChild(div);
      div.style.display = "block";
    }
    const style = el.labelStyle; // one spread instead of four
    div.style.color = style.color;
    div.style.fontWeight = style.fontWeight;
    div.style.fontFamily = getFontFamily(style.fontFamily, false);
    div.style.fontSize = style.fontSize.toString() + "px";
    div.innerHTML = el.getLabelText(totalValue);
    return div;
  }
  function placeLabel(div, divWidth, divHeight, el, angleFrom, angleTo, xCoord, yCoord, outerRadius, innerRadius) { // :729-751
    let leftShift = 0, topShift = 0;
    const pad = this.padding, border = this.canvasBorder;
    if (pad && pad.left) leftShift += pad.left;
    if (pad && pad.top) topShift += pad.top;
    if (border && border.border) { leftShift += border.border; topShift += border.border; }
    else {
      if (border && border.borderLeft) leftShift += border.borderLeft;
      if (border && border.borderTop) leftShift += border.borderTop; // sic, as in the library
    }
    const position = this.calcTitlePosition(xCoord + leftShift, yCoord + topShift, outerRadius, innerRadius, angleFrom, angleTo, el.shift + this.seriesSpacing, divWidth, divHeight);
    div.style.left = `${position.left + el.labelOffset.x}px`;
    div.style.top = `${position.top + el.labelOffset.y}px`;
  }
  let queue = null;
  function batchedLabel(el, index, totalValue, angleFrom, angleTo, xCoord, yCoord, outerRadius, innerRadius) {
    const div = writeLabel.call(this, el, index, totalValue);
    if (!div) return;
    if (queue) queue.push([div, el, angleFrom, angleTo, xCoord, yCoord, outerRadius, innerRadius]);
    else { const w = div.offsetWidth, h = div.offsetHeight; placeLabel.call(this, div, w, h, el, angleFrom, angleTo, xCoord, yCoord, outerRadius, innerRadius); }
  }
  const boundDrawChart = pie.drawChart; // bound per instance in the constructor
  function batchedDrawChart(progress) {
    queue = [];
    try { return boundDrawChart(progress); } finally {
      const jobs = queue; queue = null;
      inLabel = true;
      const sizes = jobs.map(([div]) => [div.offsetWidth, div.offsetHeight]); // one read pass
      inLabel = false;
      jobs.forEach(([div, ...rest], i) => placeLabel.call(pie, div, sizes[i][0], sizes[i][1], ...rest));
    }
  }

  const labelState = () => pie.titleDivs.map((d) => `${d.id}:${d.style.left},${d.style.top},${d.textContent}`).join("|");
  async function run(label) {
    P.status(`Setting one segment value per frame, ${label}…`);
    const r = await P.frames(FRAMES, (i) => { const s = segs[i % N]; s.value = VALUES[i % N] * (i % 2 ? 1.6 : 0.7); });
    const draws = r.total("pie draw()") || 1;
    const res = {
      draws: r.total("pie draw()"),
      labelsPerDraw: r.total("labels drawn") / draws,
      sizeReadsPerDraw: r.total("label size reads") / draws,
      forcedPerDraw: r.total("layout reads after a DOM write (forced layout)") / draws,
      readsPerDraw: r.total("layout reads") / draws,
      getterMsPerDraw: (r.total("offsetWidth", "t") + r.total("offsetHeight", "t")) / draws,
      drawMs: r.total("pie draw()", "t") / draws,
    };
    segs.forEach((s, k) => { s.value = VALUES[k]; }); // same final state for both runs
    await P.idleFrames(2);
    res.final = labelState();
    P.log(`${label}: ${JSON.stringify({ ...res, final: undefined })}`);
    return res;
  }

  proto.drawSegmentLabel = counted(shippedLabel);
  const shipped = await run("library as shipped");
  proto.drawSegmentLabel = counted(batchedLabel);
  pie.drawChart = batchedDrawChart;
  const fixed = await run("with one read pass per draw");
  pie.drawChart = boundDrawChart;
  proto.drawSegmentLabel = shippedLabel;

  const samePositions = shipped.final === fixed.final && shipped.final.length > 0;
  const labelled = shipped.labelsPerDraw;
  const reproduced = shipped.draws >= FRAMES * 0.9 && labelled >= N * 0.9 && shipped.forcedPerDraw >= 0.8 * labelled && fixed.forcedPerDraw <= 1.5;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each pie draw placed ${labelled.toFixed(0)} labels and caused ${shipped.forcedPerDraw.toFixed(1)} forced layouts (a size read right after a write). Measuring all labels in one pass: ${fixed.forcedPerDraw.toFixed(1)} per draw${samePositions ? ", with identical label positions" : ""}.`
      : `Expected about ${N} forced layouts per draw (one per label); measured ${shipped.forcedPerDraw.toFixed(1)} as shipped and ${fixed.forcedPerDraw.toFixed(1)} with one read pass, over ${shipped.draws} draws.`,
    columns: ["As shipped", "One read pass (fix)"],
    rows: [
      ["Pie draws (one per value set)", shipped.draws, fixed.draws],
      ["Labels placed per draw", shipped.labelsPerDraw, fixed.labelsPerDraw],
      ["offsetWidth/offsetHeight reads in label placement per draw", shipped.sizeReadsPerDraw, fixed.sizeReadsPerDraw],
      ["Layout reads after a DOM write (forced layouts) per draw, whole page", shipped.forcedPerDraw, fixed.forcedPerDraw],
      ["Time in offsetWidth/offsetHeight getters per draw, ms", shipped.getterMsPerDraw, fixed.getterMsPerDraw],
      ["Time in pie draw() per draw, ms", shipped.drawMs, fixed.drawMs],
      ["Final label positions equal in both runs", samePositions ? "yes" : "no", samePositions ? "yes" : "no"],
    ],
    notes: [
      "Counts do not depend on hardware; times do. A forced layout here means a layout read that the harness saw after a DOM or style write in the same frame. In the shipped code each label's offsetWidth follows that label's innerHTML write and the previous label's left/top writes, so every label pays for a style and layout pass; offsetHeight right after it is free. The getter time is where those passes run.",
      "Every pie draw also removes and re-parses the SVG, recreates the label divs and rebuilds the legend (issues 065 and 038). With animate on, a click runs 11 draws and a value change up to 31, each paying this per-label cost.",
      "The pie surface draws with SVG and HTML only, so the renderer selector has no effect here and both renderers should give the same counts.",
    ],
    metrics: { shipped: { ...shipped, final: undefined }, fixed: { ...fixed, final: undefined }, samePositions, segments: N, frames: FRAMES },
  });
}
