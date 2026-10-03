const META = {
  id: "065",
  title: "Pie redraws its whole DOM on every property set; its animations are setTimeout chains that delete() never stops",
  issue: "issues/065-pie-sync-redraw-per-setter-and-timer-animations.md",
  severity: "medium",
  claim: "Every PieSegment setter calls SciChartPieSurface.invalidateElement, which redraws at once: the SVG is re-parsed and the label divs and legend are rebuilt. Setting N values in one task redraws N times, and the value setter has no equality check. Value changes and clicks animate through chains of 30 and 10 setTimeout(20) steps, each one a full redraw, and delete() keeps no handle to stop them.",
  method: "<p>Three 10-segment pies with legends. A uses <code>animate: false</code>, B and C the default <code>animate: true</code>. A full redraw is one call of the pie's <code>drawChart</code> (SVG string built and parsed with <code>createContextualFragment</code>, label divs written); <code>setTimeout</code> calls are counted page-wide (nothing else on the page uses timers).</p><ul><li>Pie A, 5 frames: all 10 values set in one task; then the same values set again; then the issue's workaround: build new segments and swap them with <code>pieSegments.clear()</code> + one <code>pieSegments.add(...)</code>.</li><li>Pie B: one value change, one re-set of an unchanged value and two segment clicks, each waited out to the end of its animation. The same value change and clicks run on pie A (animate: false) for the workaround column.</li><li>Pie C: a value change, <code>delete()</code> 100 ms later, then 900 ms of waiting; redraws after <code>delete()</code> and pie paths left in the page are counted. Pie A is deleted right after a value set for comparison.</li><li>During B's value animation, rAF timestamps and redraw timestamps are recorded to see how the 20 ms steps fall on display frames (timing-dependent).</li></ul><p>The pie is SVG/HTML only; the WebGL/WebGPU selector does not affect it.</p>",
};

async function demo(P) {
  const { PieSegment, SciChartPieSurface } = P.SciChart;
  const N = 10, TICKS = 5, SWEEP_STEPS = 30, CLICK_STEPS = 10;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"];
  const VALUES = [20, 16, 14, 12, 10, 8, 7, 6, 4, 3];
  const makeSegments = (names) => VALUES.map((value, i) => new PieSegment({ value, text: names ? names[i] : `Item ${i + 1}`, color: COLORS[i] }));
  async function waitFor(cond, ms) {
    const t0 = P.now();
    while (!cond()) { if (P.now() - t0 > ms) return false; await P.nextFrame(); }
    return true;
  }

  const pieA = await P.createPie("pieA", { animate: false, showLegend: true });
  let segsA = makeSegments();
  pieA.pieSegments.add(...segsA);
  const pieB = await P.createPie("pieB", { animate: true, showLegend: true });
  const segsB = makeSegments();
  pieB.pieSegments.add(...segsB);
  const pieC = await P.createPie("pieC", { animate: true, showLegend: true });
  const segsC = makeSegments();
  pieC.pieSegments.add(...segsC);
  P.status("Waiting for the initial sweep animations…");
  await waitFor(() => pieB.sweepAnimationDone && pieC.sweepAnimationDone, 8000);
  await P.idleFrames(5);

  // ---- instrumentation
  P.watch.timers();
  P.watch.domWrites();
  const tagOf = (s) => (s === pieA ? "A" : s === pieB ? "B" : s === pieC ? "C" : "?");
  P.hookMethod(SciChartPieSurface.prototype, "draw", { name: "pie draw() (all)", onCall: (a, self) => P.count(`draw() ${tagOf(self)}`) });
  let stepLog = null;
  const lastRedraw = { A: 0, B: 0, C: 0 };
  for (const pie of [pieA, pieB, pieC]) {
    const tag = tagOf(pie);
    // drawChart is bound per instance in the constructor, so hook the instance. Sweeps started later capture this wrapper.
    P.hookMethod(pie, "drawChart", {
      name: `full redraws ${tag}`, time: true,
      onCall: () => { lastRedraw[tag] = P.now(); if (stepLog && pie === pieB) stepLog.push(lastRedraw[tag]); },
    });
  }

  // ---- 1. synchronous redraw per setter (pie A, animate: false)
  const vary = (i, j) => +(VALUES[j] * (1 + 0.4 * Math.sin(i * 1.3 + j))).toFixed(2);
  async function ticks(label, perTick) {
    P.status(`Pie A: ${label}…`);
    const r = await P.frames(TICKS, perTick);
    const res = {
      redraws: r.total("full redraws A") / TICKS,
      parses: r.total("createContextualFragment (HTML/SVG parse)") / TICKS,
      draws: r.total("draw() A") / TICKS,
      msPerTick: r.total("full redraws A", "t") / TICKS,
    };
    P.log(`pie A, ${label}: ${JSON.stringify(res)}`);
    return res;
  }
  const batch = await ticks("10 values set in one task", (i) => segsA.forEach((s, j) => { s.value = vary(i, j); }));
  const same = await ticks("the same 10 values set again", () => segsA.forEach((s) => { s.value = s.value; }));

  // The issue's workaround as written: clear() + one add(). Check what the legend shows afterwards.
  const renamed = makeSegments(VALUES.map((v, i) => `New ${i + 1}`));
  pieA.pieSegments.clear();
  pieA.pieSegments.add(...renamed);
  await P.nextFrame();
  const legendText = () => { const el = pieA.domDivContainer.querySelector(".scichart__legend"); return el ? el.textContent : ""; };
  const staleLegend = !legendText().includes("New 1") && legendText().includes("Item 1");
  P.log(`after clear() + add(): legend shows ${staleLegend ? "the old segments" : "the new segments"} ("${legendText().slice(0, 40)}…")`);
  segsA = renamed;
  // ObservableArray.clear() replaces its array, and the legend keeps the old one: re-point it after clear().
  const swap = await ticks("workaround: clear() + legend.setPieSegmentArray + one add()", (i) => {
    const next = segsA.map((s, j) => new PieSegment({ value: vary(i + 50, j), text: s.text, color: s.color }));
    pieA.pieSegments.clear();
    pieA.legend.setPieSegmentArray(pieA.pieSegments.asArray());
    pieA.pieSegments.add(...next);
    segsA = next;
  });
  const legendFollows = legendText().includes("New 1") && pieA.legend.pieSegmentArray === pieA.pieSegments.asArray();

  // ---- 2. timer-driven animations (pie B), same actions on pie A for the workaround column
  async function valueChange(pie, seg, value, label) {
    const tag = tagOf(pie);
    let t0 = 0;
    const r = await P.during(async () => {
      t0 = P.now();
      seg.value = value;
      await waitFor(() => !pie.animate || pie.sweepAnimationDone, 6000);
      await P.idleFrames(3);
    });
    const res = { timeouts: r.total("setTimeout"), redraws: r.total(`full redraws ${tag}`), ms: lastRedraw[tag] - t0 };
    P.log(`pie ${tag}, ${label}: ${JSON.stringify(res)}`);
    return res;
  }
  async function click(pie, seg, label) {
    const tag = tagOf(pie);
    const el = pie.domChartRoot.querySelector(`[id='${seg.id}']`);
    const before = seg.isSelected;
    let t0 = 0;
    const r = await P.during(async () => {
      t0 = P.now();
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await waitFor(() => !pie.animate || Math.abs(seg.shift - (seg.isSelected ? seg.delta : 0)) < 1e-6, 4000);
      await P.idleFrames(3);
    });
    const res = { effective: seg.isSelected !== before, timeouts: r.total("setTimeout"), redraws: r.total(`full redraws ${tag}`), ms: lastRedraw[tag] - t0 };
    P.log(`pie ${tag}, ${label}: ${JSON.stringify(res)}`);
    return res;
  }
  const frameRecorder = () => {
    const times = []; let on = true;
    (async () => { while (on) { await P.nextFrame(); times.push(P.now()); } })();
    return () => { on = false; return times; };
  };
  // Steps that run between two rAF callbacks are painted by the later frame.
  function alignment(steps, frames) {
    if (steps.length < 2) return { frames: 0, empty: 0, unpainted: 0 };
    const first = steps[0], last = steps[steps.length - 1];
    let used = 0, empty = 0, unpainted = 0;
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1], b = frames[i];
      if (b <= first || a >= last) continue;
      const n = steps.filter((t) => t > a && t <= b).length;
      used++;
      if (n === 0) empty++;
      if (n > 1) unpainted += n - 1;
    }
    return { frames: used, empty, unpainted };
  }

  P.status("Pie B: value change animation…");
  stepLog = [];
  const stopFrames = frameRecorder();
  const sweep = await valueChange(pieB, segsB[0], 34, "value change");
  const align = alignment(stepLog, stopFrames());
  stepLog = null;
  P.log(`pie B sweep vs display frames: ${JSON.stringify(align)}`);
  P.status("Pie B: re-setting an unchanged value…");
  const resetSame = await valueChange(pieB, segsB[1], segsB[1].value, "unchanged value re-set");
  P.status("Pie B: segment clicks…");
  const clickB1 = await click(pieB, segsB[2], "click (select)");
  const clickB2 = await click(pieB, segsB[2], "click (deselect)");
  P.status("Pie A (animate: false): the same value change and clicks…");
  const sweepA = await valueChange(pieA, segsA[0], 34, "value change");
  const clickA1 = await click(pieA, segsA[2], "click (select)");
  const clickA2 = await click(pieA, segsA[2], "click (deselect)");
  const avg = (a, b) => ({ timeouts: (a.timeouts + b.timeouts) / 2, redraws: (a.redraws + b.redraws) / 2, ms: (a.ms + b.ms) / 2 });
  const clickB = avg(clickB1, clickB2), clickA = avg(clickA1, clickA2);

  // ---- 3. delete() during an animation (pie C) vs a pie without animation (pie A)
  async function deleteDuring(pie, seg, waitMs) {
    const tag = tagOf(pie);
    seg.value = seg.value * 1.8;
    if (waitMs) await P.sleep(waitMs);
    pie.delete();
    const r = await P.during(() => P.sleep(900));
    const res = {
      redrawsAfter: r.total(`full redraws ${tag}`),
      timeoutsAfter: r.total("setTimeout"),
      pathsLeft: pie.domSvgContainer.isConnected ? pie.domSvgContainer.querySelectorAll("path").length : 0,
      labelsLeft: pie.domDivContainer.isConnected ? pie.domDivContainer.querySelectorAll(".scichart-pie-text-container").length : 0,
    };
    P.log(`pie ${tag}, delete() ${waitMs} ms after a value change: ${JSON.stringify(res)}`);
    return res;
  }
  P.status("Pie C: delete() during a value animation…");
  const delC = await deleteDuring(pieC, segsC[0], 100);
  const delA = await deleteDuring(pieA, segsA[0], 0);

  // ---- verdict (as-shipped numbers only; the workaround column is shown for comparison)
  const syncRepro = batch.redraws >= 0.8 * N;
  const timerRepro = sweep.timeouts >= 0.8 * SWEEP_STEPS && clickB.timeouts >= 0.8 * CLICK_STEPS && clickB1.effective && clickB2.effective;
  const deleteRepro = delC.redrawsAfter >= 1;
  const reproduced = syncRepro && timerRepro && deleteRepro;
  const f = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Setting ${N} values in one task redrew the pie ${f(batch.redraws)} times (swapping the segments: ${f(swap.redraws)}). One animated value change ran ${sweep.timeouts} setTimeout steps and ${sweep.redraws} full redraws, a click ${f(clickB.timeouts)} and ${f(clickB.redraws)}. A pie deleted mid-animation redrew ${delC.redrawsAfter} more times and left ${delC.pathsLeft} segment paths in the page.`
      : `Measured: ${f(batch.redraws)} redraws per ${N}-value task (expected ${N}), ${sweep.timeouts} setTimeout steps per value change (expected ${SWEEP_STEPS}), ${f(clickB.timeouts)} per click (expected ${CLICK_STEPS}), ${delC.redrawsAfter} redraws after delete() (expected > 0).`,
    columns: ["As shipped", "With workaround"],
    rows: [
      [`${N} values set in one task (animate: false): full redraws`, batch.redraws, swap.redraws],
      ["… SVG parses (createContextualFragment)", batch.parses, swap.parses],
      ["Same values set again: full redraws (setter has no equality check)", same.redraws, null],
      ["One value change (animate on): setTimeout(20) steps", sweep.timeouts, sweepA.timeouts],
      ["One value change: full redraws", sweep.redraws, sweepA.redraws],
      ["One value change: time from the set to the last redraw, ms", sweep.ms, sweepA.ms],
      ["Re-setting a segment to its current value (animate on): setTimeout(20) steps", resetSame.timeouts, null],
      ["… full redraws", resetSame.redraws, null],
      ["One segment click: setTimeout(20) steps", clickB.timeouts, clickA.timeouts],
      ["One segment click: full redraws", clickB.redraws, clickA.redraws],
      ["One segment click: time from the click to the last redraw, ms", clickB.ms, clickA.ms],
      ["delete() during a value animation: full redraws after delete()", delC.redrawsAfter, delA.redrawsAfter],
      ["… segment paths left in the page after delete()", delC.pathsLeft, delA.pathsLeft],
      ["Value animation: display frames it spanned (timing)", align.frames, null],
      ["… frames that got no animation step (timing)", align.empty, null],
      ["… redraws never painted, 2+ in one frame (timing)", align.unpainted, null],
      [`Time in full redraws per ${N}-value update, ms`, batch.msPerTick, swap.msPerTick],
    ],
    notes: [
      "Workaround column: animate: false (pie A); values changed by building new segments and swapping them with pieSegments.clear() + one pieSegments.add(...); unchanged values not re-set (rows marked – have nothing to measure). Counts do not depend on hardware; durations, frame alignment and times do.",
      `The swap as written in the issue leaves the legend on the old segments: ObservableArray.clear() replaces its internal array and SciChartPieLegend keeps the array it got at construction. Measured here: after clear() + add() the legend showed ${staleLegend ? "the old segment names" : "the new segment names"}. The workaround column also calls pie.legend.setPieSegmentArray(pie.pieSegments.asArray()) between clear() and add(); the legend then ${legendFollows ? "followed the new segments" : "still did not follow the new segments"}.`,
      `SciChartPieSurface.delete() does not stop pending animation timers and does not remove its SVG and label containers from the page, so a pie deleted mid-animation keeps redrawing until the chain ends and its last full redraw stays visible: pie C ran ${delC.timeoutsAfter} more timer steps after delete() and still shows ${delC.pathsLeft} segment paths and ${delC.labelsLeft} labels.`,
      "The pie surface draws with SVG and HTML only, so the renderer selector has no effect here and both renderers should give the same counts.",
    ],
    metrics: { batch, same, swap, staleLegend, legendFollows, sweep, resetSame, clickB, sweepA, clickA, delC, delA, align },
  });
}
