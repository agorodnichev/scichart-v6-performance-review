const META = {
  id: "027",
  title: "The engine's requestAnimationFrame loop runs every frame, idle or after every chart is deleted",
  issue: "issues/027-engine-raf-loop-never-stops.md",
  severity: "high",
  claim: "The Emscripten main loop re-requests an animation frame after every tick for the life of the wasm module. An idle chart, and the page after the last chart is deleted (autoDisposeWasmContext defaults to false), still wake the main thread on every display refresh.",
  method: "<p>The demo counts window.requestAnimationFrame calls (the harness's own frames are not counted) over 2-second windows with no input and no data changes: before any chart exists, with one static chart, after that chart's delete(), after a delete() with SciChartSurface.autoDisposeWasmContext = true (the workaround), and with three createSingle() charts. It also counts engine draw requests (TSRRequestCanvasDraw / TSRRequestDraw) in the idle window, to show that nothing asked for a frame.</p>",
};

async function demo(P) {
  const { SciChartSurface, NumericAxis, FastLineRenderableSeries, XyDataSeries } = P.SciChart;
  const WINDOW = 2000;
  P.watch.timers();

  async function refreshRate() {
    let n = 0; const t0 = P.now();
    while (P.now() - t0 < 1000) { await P.nextFrame(); n++; }
    return n / ((P.now() - t0) / 1000);
  }
  async function idleRate(label, extra) {
    const r = await P.during(() => P.sleep(WINDOW));
    const perSec = r.total("requestAnimationFrame") / (WINDOW / 1000);
    P.log(`${label}: ${perSec.toFixed(1)} rAF requests/s` + (extra ? `, ${extra(r)}` : ""));
    return { perSec, r };
  }
  async function makeChart(div, single) {
    const res = await P.createSurface(div, undefined, single);
    const { sciChartSurface, wasmContext } = res;
    sciChartSurface.xAxes.add(new NumericAxis(wasmContext));
    sciChartSurface.yAxes.add(new NumericAxis(wasmContext));
    const xs = Array.from({ length: 500 }, (_, i) => i);
    sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, {
      dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 40)), isSorted: true, containsNaN: false }),
      stroke: "#4e79a7", strokeThickness: 2,
    }));
    return res;
  }

  P.status("Measuring the display refresh rate…");
  const refresh = await refreshRate();
  const before = await idleRate("before any chart exists");

  P.status("One static chart, idle…");
  const a = await makeChart("chart");
  await P.sleep(1000);
  P.watchEmbind(a.wasmContext, ["TSRRequestCanvasDraw", "TSRRequestDraw"]);
  const idle = await idleRate("one static chart, idle", (r) => `${r.total("wasm TSRRequestCanvasDraw") + r.total("wasm TSRRequestDraw")} engine draw requests`);
  const drawRequests = idle.r.total("wasm TSRRequestCanvasDraw") + idle.r.total("wasm TSRRequestDraw");

  P.status("After delete() with the default settings…");
  a.sciChartSurface.delete();
  await P.sleep(500);
  const afterDelete = await idleRate("after delete(), autoDisposeWasmContext = false (default)");

  P.status("After delete() with autoDisposeWasmContext = true…");
  SciChartSurface.autoDisposeWasmContext = true;
  const b = await makeChart("chart");
  await P.sleep(500);
  b.sciChartSurface.delete();
  await P.sleep(500);
  const afterDeleteAuto = await idleRate("after delete(), autoDisposeWasmContext = true");
  SciChartSurface.autoDisposeWasmContext = false;

  P.status("Three idle createSingle() charts…");
  const singles = [];
  for (const id of ["single1", "single2", "single3"]) singles.push(await makeChart(id, true));
  await P.sleep(1000);
  const idleSingles = await idleRate("three createSingle() charts, idle");
  singles.forEach((s) => s.sciChartSurface.delete());

  const loops = (v) => v.perSec / refresh;
  const reproduced = loops(idle) > 0.8 && loops(afterDelete) > 0.8 && drawRequests === 0;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `An idle chart requests ${idle.perSec.toFixed(0)} animation frames per second (display: ${refresh.toFixed(0)} Hz) with 0 draw requests, and keeps doing so after delete() (${afterDelete.perSec.toFixed(0)}/s). With autoDisposeWasmContext = true: ${afterDeleteAuto.perSec.toFixed(0)}/s.`
      : `Expected about one rAF request per display frame while idle; measured ${idle.perSec.toFixed(1)}/s idle and ${afterDelete.perSec.toFixed(1)}/s after delete() at ${refresh.toFixed(0)} Hz.`,
    columns: ["rAF requests / s", "per display frame"],
    rows: [
      ["Before any chart exists", before.perSec, loops(before)],
      ["One static chart, idle (no input, no data)", idle.perSec, loops(idle)],
      ["Engine draw requests during that idle window", drawRequests, null],
      ["After chart.delete(), autoDisposeWasmContext = false (default)", afterDelete.perSec, loops(afterDelete)],
      ["After chart.delete(), autoDisposeWasmContext = true (workaround)", afterDeleteAuto.perSec, loops(afterDeleteAuto)],
      ["Three idle createSingle() charts", idleSingles.perSec, loops(idleSingles)],
      ["Display refresh rate, frames / s", refresh, null],
    ],
    notes: [
      "Each request is one main-thread wake-up per display refresh. Open DevTools > Performance and record a few idle seconds to see one 'Animation frame fired' per frame.",
    ],
    metrics: { refresh, before: before.perSec, idle: idle.perSec, drawRequests, afterDelete: afterDelete.perSec, afterDeleteAuto: afterDeleteAuto.perSec, idleSingles: idleSingles.perSec },
  });
}
