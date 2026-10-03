const META = {
  id: "053",
  title: "Off-screen charts render every frame by default; the opt-in freeze drops the redraw on return, and tab return force-renders frozen charts",
  issue: "issues/053-offscreen-charts-render-by-default-freeze-drops-redraw.md",
  severity: "medium",
  claim: "freezeWhenOutOfView defaults to false, so a chart scrolled out of view renders (and, under WebGL, is copied to its canvas) on every invalidation. With the freeze on, invalidations raised while frozen are dropped and the unlock on scroll-back does not invalidate, so the chart shows stale data; the visibilitychange handler force-renders every surface, frozen or not.",
  method: "<p>Two create() charts in a scrollable panel: chart A at the top (in view) and chart B 700 px further down (out of view; an IntersectionObserver in the page confirms it). Both receive one appended point per frame. The demo counts each chart's rendered events (and, under WebGL, the 2D copies into chart B's canvas) in five steps: (1) 60 frames with the default options; (2) 60 frames after chart B.freezeWhenOutOfView = true (the issue's workaround); (3) streaming stops, the panel scrolls chart B into view, and the demo counts renders for 20 frames and compares the point count of chart B's last render with its data; (4) the same scroll-back with the app-side workaround from the issue (an app IntersectionObserver calls invalidateElement on re-entry); (5) with chart B frozen again, a synthetic visibilitychange event (document.visibilityState is 'visible') stands in for returning to the tab, and renders of the frozen chart are counted.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, EAutoRange } = P.SciChart;
  const FRAMES = 60;
  const scroller = document.getElementById("scroller");

  async function makeChart(id, color) {
    const { sciChartSurface, wasmContext } = await P.createSurface(id);
    sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
    sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
    const ds = new XyDataSeries(wasmContext, { fifoCapacity: 2000, isSorted: true, containsNaN: false });
    for (let x = 0; x < 300; x++) ds.append(x, Math.sin(x / 30));
    sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries: ds, stroke: color, strokeThickness: 2 }));
    const chart = { surface: sciChartSurface, ds, x: 300, appended: 300, lastRenderedPoints: 0 };
    sciChartSurface.rendered.subscribe(() => { P.count(`rendered ${id}`); chart.lastRenderedPoints = chart.appended; });
    return chart;
  }
  const A = await makeChart("chartA", "#4e79a7");
  const B = await makeChart("chartB", "#e15759");
  const append = (c) => { c.x++; c.appended++; c.ds.append(c.x, Math.sin(c.x / 30)); };
  const streamBoth = () => { append(A); append(B); };

  // Ground truth for "is chart B on screen": the page's own IntersectionObserver.
  let bVisible = null;
  new IntersectionObserver((es) => es.forEach((e) => { bVisible = e.isIntersecting; }), { threshold: 0.01 }).observe(B.surface.domChartRoot);
  // WebGL copy step: drawImage into chart B's 2D canvas
  P.hookMethod(CanvasRenderingContext2D.prototype, "drawImage", { name: "drawImage (all)", onCall: (a, self) => { if (self.canvas === B.surface.domCanvas2D) P.count("2D copies into chart B"); } });
  // Time spent rendering chart B (doDrawingLoop is a prototype method, attributed by `this`)
  let bMs = 0;
  let sp = B.surface; while (sp && !Object.prototype.hasOwnProperty.call(sp, "doDrawingLoop")) sp = Object.getPrototypeOf(sp);
  const doDrawingLoop = sp.doDrawingLoop;
  sp.doDrawingLoop = function () {
    if (this !== B.surface) return doDrawingLoop.apply(this, arguments);
    const t0 = P.now();
    try { return doDrawingLoop.apply(this, arguments); } finally { bMs += P.now() - t0; }
  };
  const scrollTo = async (bottom) => { scroller.scrollTop = bottom ? scroller.scrollHeight : 0; await P.idleFrames(8); };
  await P.sleep(500);

  // (1) defaults
  await scrollTo(false);
  P.status("Streaming into both charts, default options…");
  bMs = 0;
  const r1 = await P.frames(FRAMES, streamBoth);
  const step1 = { bVisible, a: r1.perFrame("rendered chartA"), b: r1.perFrame("rendered chartB"), copies: r1.perFrame("2D copies into chart B"), bMs: bMs / FRAMES };
  P.log(`1 defaults: ${JSON.stringify(step1)}`);

  // (2) workaround: freeze when out of view
  B.surface.freezeWhenOutOfView = true;
  await P.idleFrames(8); // the visibility observer reports "not visible" and takes the lock
  P.status("Streaming with chart B frozen (freezeWhenOutOfView: true)…");
  bMs = 0;
  const r2 = await P.frames(FRAMES, streamBoth);
  const step2 = { bVisible, suspended: B.surface.isSuspended, a: r2.perFrame("rendered chartA"), b: r2.perFrame("rendered chartB"), copies: r2.perFrame("2D copies into chart B"), bMs: bMs / FRAMES };
  P.log(`2 frozen: ${JSON.stringify(step2)}`);

  // (3) stop streaming, scroll chart B into view
  P.status("Scrolling chart B back into view…");
  const r3 = await P.during(async () => { await scrollTo(true); await P.idleFrames(12); });
  const step3 = { bVisible, suspended: B.surface.isSuspended, renders: r3.total("rendered chartB"), shown: B.lastRenderedPoints, data: B.appended };
  P.log(`3 scroll-back: ${JSON.stringify(step3)}`);

  // (4) app-side workaround for the return: invalidate from the app's own IntersectionObserver
  await scrollTo(false); // frozen again
  for (let i = 0; i < 30; i++) append(B); // data arrives while frozen
  const appIO = new IntersectionObserver((es) => es.forEach((e) => {
    // next frame, so the library's own observer has released the lock first
    if (e.isIntersecting) requestAnimationFrame(() => B.surface.invalidateElement());
  }), { threshold: 0.01 });
  appIO.observe(B.surface.domChartRoot);
  await P.idleFrames(4);
  P.status("Scrolling back with the app-side workaround…");
  const r4 = await P.during(async () => { await scrollTo(true); await P.idleFrames(12); });
  const step4 = { bVisible, renders: r4.total("rendered chartB"), shown: B.lastRenderedPoints, data: B.appended };
  P.log(`4 scroll-back with app observer: ${JSON.stringify(step4)}`);
  appIO.disconnect();

  // (5) tab return while chart B is frozen
  await scrollTo(false);
  await P.idleFrames(4);
  P.status("Synthetic visibilitychange while chart B is frozen…");
  const frozenBefore = B.surface.isSuspended;
  const r5 = await P.during(async () => { document.dispatchEvent(new Event("visibilitychange")); await P.idleFrames(10); });
  const step5 = { bVisible, frozen: frozenBefore, visibilityState: document.visibilityState, b: r5.total("rendered chartB"), a: r5.total("rendered chartA") };
  P.log(`5 tab return: ${JSON.stringify(step5)}`);
  B.surface.freezeWhenOutOfView = false;
  sp.doDrawingLoop = doDrawingLoop;

  const offscreenRenders = step1.bVisible === false && step1.b >= 0.8;
  const staleOnReturn = step2.b <= 0.05 && step3.renders === 0 && step3.shown < step3.data;
  const tabReturnRendersFrozen = step5.frozen && step5.b >= 1;
  const reproduced = offscreenRenders && staleOnReturn;
  const yesNo = (v) => (v ? "yes" : "no");
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Out of view, chart B still renders ${step1.b.toFixed(2)} times per frame by default. Frozen, it renders ${step2.b.toFixed(2)}; scrolled back, it renders ${step3.renders} times and shows ${step3.shown} of ${step3.data} points (stale) until something else invalidates it. A tab return force-renders it while frozen: ${step5.b} render(s).`
      : `Off-screen renders per frame by default: ${step1.b.toFixed(2)} (chart B in view: ${step1.bVisible}); renders after scroll-back: ${step3.renders}, showing ${step3.shown} of ${step3.data} points.`,
    columns: ["Chart B (out of view)", "Chart A (in view)"],
    rows: [
      ["(1) Default options: renders per frame while streaming", step1.b, step1.a],
      ["    2D copies into chart B's canvas per frame (WebGL copy step)", step1.copies, null],
      ["    Time rendering chart B per frame, ms", step1.bMs, null],
      ["(2) freezeWhenOutOfView: true: renders per frame while streaming", step2.b, step2.a],
      ["(3) Streaming stopped, scrolled into view: renders in the next 20 frames", step3.renders, null],
      ["    Points drawn by chart B's last render / points in its data", `${step3.shown} / ${step3.data}`, null],
      ["    Freeze lock still held after scroll-back", yesNo(step3.suspended), null],
      ["(4) Same scroll-back with an app IntersectionObserver that invalidates: renders", step4.renders, null],
      ["    Points drawn / points in data", `${step4.shown} / ${step4.data}`, null],
      ["(5) visibilitychange while chart B is frozen: renders of chart B in the next 10 frames", step5.b, step5.a],
      ["Chart B out of view during (1), (2), (5) per the page's IntersectionObserver", yesNo(step1.bVisible === false && step2.bVisible === false && step5.bVisible === false), null],
    ],
    notes: [
      "Counts do not depend on hardware; times do. Under WebGPU there is no copy step (each chart renders straight to its canvas), so the copy row is 0 there; the render count is the comparable figure.",
      `Step 5 dispatches a synthetic visibilitychange event; the library's handler checks document.visibilityState (here '${step5.visibilityState}') and calls invalidateElement({ force: true }) on every surface, which bypasses the freeze lock. Tab return force-renders the frozen chart: ${yesNo(tabReturnRendersFrozen)}.`,
    ],
    metrics: { step1, step2, step3, step4, step5, offscreenRenders, staleOnReturn, tabReturnRendersFrozen },
  });
}
