const META = {
  id: "038",
  title: "Pie legend DOM is torn down and rebuilt on every pie redraw: 11 times per segment click",
  issue: "issues/038-pie-legend-rebuilt-on-every-pie-invalidate.md",
  severity: "medium",
  claim: "SciChartPieLegend.update() drops the base class's isDirty check, so every pie redraw removes the legend, re-parses its HTML, re-inserts it and re-attaches its listeners. An animated segment click redraws the pie 11 times (isSelected, then 10 timer steps of shift), and 10 of those 11 legend rebuilds produce identical markup.",
  method: "<p>Pie A: 8 segments, default <code>animate: true</code>, legend with checkboxes. The demo dispatches 6 clicks on segment paths and 3 clicks on legend checkboxes, and waits for each 10-step selection animation to finish before the next click. Pie B: the same segments with <code>animate: false</code>; on each of 20 frames all 8 values are set in one task (a data tick).</p><p>Counted: pie <code>update()</code> calls; legend rebuilds (<code>SciChartLegendBase.create</code> calls: each parses the legend HTML, appends it and attaches one listener per checkbox); rebuilds whose markup equals the legend already on screen (<code>getInnerHTML()</code> compared before each update); legend <code>&lt;div&gt;</code> insertions seen by a MutationObserver on the pie's div container; listeners attached during legend updates; time in legend <code>update()</code>.</p><p>Then each legend's <code>update</code> is replaced with the fix from the issue (keep the DOM when <code>getInnerHTML()</code> is unchanged, re-sync checkbox state) and the same clicks and ticks run again. The patch goes on the legend instances, because the SciChartLegendBase constructor binds <code>update</code> per instance. The pie is SVG/HTML only; the WebGL/WebGPU selector does not affect it.</p>",
};

async function demo(P) {
  const { PieSegment, SciChartPieSurface, SciChartPieLegend } = P.SciChart;
  // The UMD bundle does not export SciChartLegendBase: take the prototype that owns create().
  const ownerOf = (proto, method) => { while (proto && !Object.prototype.hasOwnProperty.call(proto, method)) proto = Object.getPrototypeOf(proto); return proto; };
  const legendBaseProto = ownerOf(SciChartPieLegend.prototype, "create");
  const N = 8, CLICKS = 6, BOX_CLICKS = 3, TICKS = 20;
  const ROUNDS = 10; // shift steps per animated click (helpers/addEventListenerToPieSegment.js)
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7"];
  const NAMES = ["North", "South", "East", "West", "Online", "Retail", "Partners", "Other"];
  const VALUES = [24, 18, 15, 12, 10, 9, 7, 5];
  const makeSegments = () => VALUES.map((value, i) => new PieSegment({ value, text: NAMES[i], color: COLORS[i] }));

  async function waitFor(cond, ms) {
    const t0 = P.now();
    while (!cond()) { if (P.now() - t0 > ms) return false; await P.nextFrame(); }
    return true;
  }

  const pieA = await P.createPie("pieA", { animate: true, showLegend: true, showLegendCheckBoxes: true });
  const segsA = makeSegments();
  pieA.pieSegments.add(...segsA);
  const pieB = await P.createPie("pieB", { animate: false, showLegend: true, showLegendCheckBoxes: true });
  const segsB = makeSegments();
  pieB.pieSegments.add(...segsB);
  P.status("Waiting for the initial sweep animation…");
  await waitFor(() => pieA.sweepAnimationDone === true, 8000);
  await P.idleFrames(5);

  // ---- instrumentation
  const tagOf = (legend) => (legend === pieA.legend ? "A" : "B");
  P.hookMethod(SciChartPieSurface.prototype, "update", { name: "pie update() (all)", onCall: (a, self) => P.count(self === pieA ? "pie A update()" : "pie B update()") });

  // The fix from the issue, as a plain function used with legend instances.
  function fixedUpdate() {
    const html = this.showLegend ? this.getInnerHTML() : "";
    if (this.div && html === this.lastHtml) {
      if (this.showCheckboxes) {
        this.pieSegmentArray.forEach((ps) => {
          const el = this.div.querySelector(`#check${ps.id}`);
          if (el && el.checked !== ps.isSelected) el.checked = ps.isSelected;
        });
      }
      return;
    }
    this.lastHtml = html;
    this.clear();
    if (this.showLegend) this.create();
  }

  let useFix = false, inLegend = null, unchanged = false;
  const legendMs = { A: 0, B: 0 };
  const restores = [];
  for (const pie of [pieA, pieB]) {
    const legend = pie.legend, tag = tagOf(legend);
    const shipped = legend.update; // bound in the SciChartLegendBase constructor
    let prevHtml = legend.getInnerHTML();
    legend.update = function () {
      const html = this.showLegend ? this.getInnerHTML() : "";
      unchanged = !!this.div && html === prevHtml; // same markup as the legend on screen
      prevHtml = html;
      P.count(`legend ${tag} update()`);
      inLegend = tag;
      const t0 = P.now();
      try { return useFix ? fixedUpdate.call(this) : shipped(); } finally {
        legendMs[tag] += P.now() - t0;
        inLegend = null; unchanged = false;
      }
    };
    restores.push(() => { legend.update = shipped; });
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) {
        if (n.nodeType === 1 && n.classList.contains("scichart__legend")) P.count(`legend ${tag} DOM insertions (MutationObserver)`);
      }
    }).observe(pie.domDivContainer, { childList: true });
  }
  P.hookMethod(legendBaseProto, "create", {
    name: "legend create() (all)",
    onCall: (a, self) => {
      const tag = tagOf(self);
      P.count(`legend ${tag} rebuilds`);
      if (unchanged) P.count(`legend ${tag} rebuilds with unchanged markup`);
    },
  });
  P.hookMethod(EventTarget.prototype, "addEventListener", { name: "addEventListener (all)", onCall: () => { if (inLegend) P.count(`legend ${inLegend} listeners attached`); } });

  // ---- scenario
  const pathOf = (ps) => pieA.domChartRoot.querySelector(`[id='${ps.id}']`);
  const boxOf = (ps) => pieA.domDivContainer.querySelector(`#check${ps.id}`);
  const settled = (ps) => Math.abs(ps.shift - (ps.isSelected ? ps.delta : 0)) < 1e-6;
  async function clickAndSettle(el, ps, viaClickMethod) {
    const before = ps.isSelected;
    if (viaClickMethod) el.click(); // checkbox: toggles, then dispatches click
    else el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => settled(ps), 4000);
    await P.idleFrames(3);
    return ps.isSelected !== before;
  }

  async function clicks(count, pick, viaClickMethod) {
    let effective = 0;
    const ms0 = legendMs.A;
    const r = await P.during(async () => {
      for (let i = 0; i < count; i++) {
        const ps = pick(i);
        const el = viaClickMethod ? boxOf(ps) : pathOf(ps);
        if (el && (await clickAndSettle(el, ps, viaClickMethod))) effective++;
      }
    });
    const per = (name) => (effective ? r.total(name) / effective : 0);
    return {
      effective,
      redraws: per("pie A update()"),
      rebuilds: per("legend A rebuilds"),
      unchanged: per("legend A rebuilds with unchanged markup"),
      inserted: per("legend A DOM insertions (MutationObserver)"),
      listeners: per("legend A listeners attached"),
      ms: effective ? (legendMs.A - ms0) / effective : 0,
    };
  }

  async function run(label) {
    P.status(`Clicking pie segments, ${label}…`);
    const click = await clicks(CLICKS, (i) => segsA[i % N], false);
    P.status(`Clicking legend checkboxes, ${label}…`);
    const box = await clicks(BOX_CLICKS, (i) => segsA[N - 2 + (i % 2)], true);
    P.status(`Data ticks on the animate: false pie, ${label}…`);
    const ms0 = legendMs.B;
    const t = await P.frames(TICKS, (i) => {
      segsB.forEach((s, k) => { s.value = +(VALUES[k] * (1 + 0.3 * Math.sin(i * 0.9 + k))).toFixed(2); });
    });
    const tick = {
      redraws: t.perFrame("pie B update()"),
      rebuilds: t.perFrame("legend B rebuilds"),
      unchanged: t.perFrame("legend B rebuilds with unchanged markup"),
      inserted: t.perFrame("legend B DOM insertions (MutationObserver)"),
      listeners: t.perFrame("legend B listeners attached"),
      ms: (legendMs.B - ms0) / TICKS,
    };
    const res = { click, box, tick };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  const shipped = await run("library as shipped");
  useFix = true;
  for (const pie of [pieA, pieB]) pie.legend.lastHtml = pie.legend.getInnerHTML(); // the legend on screen
  const fixed = await run("with the markup check");
  useFix = false;
  restores.forEach((f) => f());

  const EXPECT_CLICK = 1 + ROUNDS;
  const allClicked = shipped.click.effective === CLICKS && fixed.click.effective === CLICKS && shipped.box.effective === BOX_CLICKS && fixed.box.effective === BOX_CLICKS;
  const clickRepro = shipped.click.rebuilds >= 0.8 * EXPECT_CLICK && shipped.click.unchanged >= 0.8 * ROUNDS && fixed.click.rebuilds <= 1.5;
  const tickRepro = shipped.tick.rebuilds >= 0.8 * N && fixed.tick.rebuilds <= 0.5;
  const verdict = !allClicked ? "inconclusive" : clickRepro && tickRepro ? "reproduced" : "not-reproduced";
  const f = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  P.report({
    verdict,
    headline: verdict === "reproduced"
      ? `One animated segment click rebuilt the legend ${f(shipped.click.rebuilds)} times (${f(shipped.click.unchanged)} with unchanged markup); a checkbox click ${f(shipped.box.rebuilds)} times. With the markup check: ${f(fixed.click.rebuilds)} and ${f(fixed.box.rebuilds)}. With animate: false, setting ${N} values rebuilt it ${f(shipped.tick.rebuilds)} times per tick (fix: ${f(fixed.tick.rebuilds)}).`
      : verdict === "inconclusive"
        ? `Some synthetic clicks did not toggle a segment (segment clicks ${shipped.click.effective}/${CLICKS}, checkbox clicks ${shipped.box.effective}/${BOX_CLICKS}), so per-click numbers are not reliable here.`
        : `Expected about ${EXPECT_CLICK} legend rebuilds per click and ${N} per ${N}-value tick; measured ${f(shipped.click.rebuilds)} per click (fix ${f(fixed.click.rebuilds)}) and ${f(shipped.tick.rebuilds)} per tick (fix ${f(fixed.tick.rebuilds)}).`,
    columns: ["As shipped", "With markup check (fix)"],
    rows: [
      ["Segment click (animate on): pie redraws per click", shipped.click.redraws, fixed.click.redraws],
      ["Segment click: legend rebuilds per click", shipped.click.rebuilds, fixed.click.rebuilds],
      ["Segment click: rebuilds with unchanged markup", shipped.click.unchanged, fixed.click.unchanged],
      ["Segment click: legend <div> insertions (MutationObserver)", shipped.click.inserted, fixed.click.inserted],
      ["Segment click: listeners attached by the legend", shipped.click.listeners, fixed.click.listeners],
      ["Legend checkbox click: legend rebuilds per click", shipped.box.rebuilds, fixed.box.rebuilds],
      ["Legend checkbox click: rebuilds with unchanged markup", shipped.box.unchanged, fixed.box.unchanged],
      [`Data tick, animate: false, ${N} values set in one task: pie redraws`, shipped.tick.redraws, fixed.tick.redraws],
      ["Data tick: legend rebuilds (all but the last are never painted)", shipped.tick.rebuilds, fixed.tick.rebuilds],
      ["Data tick: rebuilds with unchanged markup", shipped.tick.unchanged, fixed.tick.unchanged],
      ["Time in legend update() per segment click, ms", shipped.click.ms, fixed.click.ms],
      ["Time in legend update() per data tick, ms", shipped.tick.ms, fixed.tick.ms],
    ],
    notes: [
      "Counts do not depend on hardware; times do. A rebuild with unchanged markup means getInnerHTML() returned the same string as for the legend already on screen: the DOM was removed, parsed again and re-wired for nothing. Legend markup holds names, colours and checked state, not values or shift, so with the fix a click rebuilds once (the checked state changes) and a value tick not at all.",
      "The pie redraws themselves (SVG re-parse, label divs, path listeners) still run once per setter with the fix: that part is issue 065.",
      "The pie surface draws with SVG and HTML only, so the renderer selector has no effect here and both renderers should give the same counts.",
    ],
    metrics: { shipped, fixed, segments: N, clicks: CLICKS, checkboxClicks: BOX_CLICKS, ticks: TICKS },
  });
}
