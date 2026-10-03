const META = {
  id: "079",
  title: "Deleting one create() chart clears and re-adds the native destination of every other chart",
  issue: "issues/079-delete-rebuilds-native-destinations-for-all-charts.md",
  severity: "medium",
  claim: "Each create() surface's delete runs resyncNativeDestinations(): ClearDestinations() on the shared render loop, then a new SCRTSurfaceDestination.implement() + AddDestination() for every surviving chart. Removing one of N charts costs N-1 re-adds; tearing down a view of N charts costs N(N-1)/2. Under WebGPU every survivor also gets a new swap chain and a forced redraw.",
  method: "<p>20 small create() charts share the engine. The demo deletes one of them, then deletes the other 19 in one task, as an unmount would. It counts calls into wasm: SCRTRenderLoopManager.ClearDestinations, SCRTRenderLoopManager.AddDestination and SCRTSurfaceDestination.implement, plus, under WebGPU, GPUCanvasContext.configure calls (swap chains set up again) and renders of the surviving charts in the three frames after the single delete.</p><p>Workaround from the issue (SC-17): the same 20 panels as sub-charts of one parent surface, which is a single native destination. The demo removes one sub-chart, then deletes the parent, and counts the same calls.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, SciChartSubSurface, Rect, EAxisAlignment } = P.SciChart;
  const N = 20;
  const grid = document.getElementById("grid");
  const xs = Array.from({ length: 100 }, (_, i) => i);
  const addContent = (surface, wasmContext, k) => {
    surface.xAxes.add(new NumericAxis(wasmContext, { drawLabels: false, drawMajorTickLines: false, drawMinorTickLines: false }));
    surface.yAxes.add(new NumericAxis(wasmContext, { drawLabels: false, drawMajorTickLines: false, drawMinorTickLines: false, axisAlignment: EAxisAlignment.Left }));
    surface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, {
      dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 8 + k)), isSorted: true, containsNaN: false }),
      stroke: "#4e79a7", strokeThickness: 1,
    }));
  };

  P.status(`Creating ${N} create() charts…`);
  const charts = [];
  for (let k = 0; k < N; k++) {
    const div = P.quiet(() => { const d = document.createElement("div"); d.id = "c" + k; d.className = "cell"; grid.appendChild(d); return d; });
    const r = await P.createSurface(div.id);
    addContent(r.sciChartSurface, r.wasmContext, k);
    charts.push(r);
  }
  const wasmContext = charts[0].wasmContext;
  await P.sleep(800);

  // Counters: wasm calls of the resync, WebGPU swap-chain configuration, renders of surviving charts.
  P.watchEmbind(wasmContext, ["SCRTRenderLoopManager.ClearDestinations", "SCRTRenderLoopManager.AddDestination", "SCRTSurfaceDestination::implement"]);
  if (window.GPUCanvasContext) P.hookMethod(GPUCanvasContext.prototype, "configure", { name: "GPUCanvasContext.configure" });
  const countRenders = (surface) => surface.rendered.subscribe(() => P.count("renders of other charts"));
  charts.forEach((c) => countRenders(c.sciChartSurface));
  const isWebGPU = P.renderer() === "WebGPU";
  const pick = (r, deleteMs) => ({
    clear: r.total("wasm SCRTRenderLoopManager.ClearDestinations"),
    add: r.total("wasm SCRTRenderLoopManager.AddDestination"),
    implement: r.total("wasm SCRTSurfaceDestination::implement"),
    configure: r.total("GPUCanvasContext.configure"),
    renders: r.total("renders of other charts"),
    deleteMs,
  });

  P.status("Deleting one chart of 20…");
  let ms = 0;
  const one = pick(await P.during(async () => {
    const t0 = P.now(); charts[N - 1].sciChartSurface.delete(); ms = P.now() - t0;
    await P.idleFrames(3);
  }), 0);
  one.deleteMs = ms;
  P.log(`delete 1 of ${N}: ${JSON.stringify(one)}`);

  P.status("Deleting the other 19 in one task (teardown)…");
  const rest = pick(await P.during(async () => {
    const t0 = P.now(); for (let k = N - 2; k >= 0; k--) charts[k].sciChartSurface.delete(); ms = P.now() - t0;
    await P.idleFrames(3);
  }), 0);
  rest.deleteMs = ms;
  P.log(`teardown of ${N - 1}: ${JSON.stringify(rest)}`);
  P.quiet(() => { grid.innerHTML = ""; });

  P.status(`Workaround: one surface with ${N} sub-charts…`);
  const parentDiv = P.quiet(() => { const d = document.createElement("div"); d.id = "parent"; d.className = "parent"; grid.appendChild(d); return d; });
  const parent = await P.createSurface(parentDiv.id);
  const subs = [];
  const COLS = 5, ROWS = Math.ceil(N / COLS);
  for (let k = 0; k < N; k++) {
    const sub = SciChartSubSurface.createSubSurface(parent.sciChartSurface, {
      position: new Rect((k % COLS) / COLS, Math.floor(k / COLS) / ROWS, 1 / COLS, 1 / ROWS),
    });
    addContent(sub, parent.wasmContext, k);
    subs.push(sub);
  }
  countRenders(parent.sciChartSurface);
  subs.forEach(countRenders);
  await P.sleep(800);
  const subOne = pick(await P.during(async () => {
    const t0 = P.now(); parent.sciChartSurface.removeSubChart(subs[N - 1]); ms = P.now() - t0;
    await P.idleFrames(3);
  }), 0);
  subOne.deleteMs = ms;
  const subAll = pick(await P.during(async () => {
    const t0 = P.now(); parent.sciChartSurface.delete(); ms = P.now() - t0;
    await P.idleFrames(3);
  }), 0);
  subAll.deleteMs = ms;
  P.log(`sub-charts: remove one ${JSON.stringify(subOne)}, delete parent ${JSON.stringify(subAll)}`);

  const expectedTeardown = ((N - 1) * (N - 2)) / 2;
  const reproduced = one.clear >= 1 && one.add >= N - 1 && one.implement >= N - 1 && rest.add >= expectedTeardown && subOne.add === 0 && subAll.add === 0;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Deleting 1 of ${N} charts re-added ${one.add} native destinations (${one.implement} new wrappers); deleting the other ${N - 1} in one task re-added ${rest.add} (= ${N - 1}·${N - 2}/2), ${N * (N - 1) / 2} in total. ` +
        (isWebGPU ? `Under WebGPU the single delete also configured ${one.configure} swap chains again and redrew ${one.renders} untouched charts. ` : "") +
        `As sub-charts of one surface: ${subOne.add} and ${subAll.add}.`
      : `Expected ${N - 1} re-adds for one delete and ${expectedTeardown} for the teardown; measured ${one.add} and ${rest.add}.`,
    columns: [`${N} create() charts`, `1 surface, ${N} sub-charts`],
    rows: [
      ["Remove one chart: native ClearDestinations() calls", one.clear, subOne.clear],
      ["Remove one chart: destinations re-added (AddDestination)", one.add, subOne.add],
      ["Remove one chart: new SCRTSurfaceDestination wrappers (implement)", one.implement, subOne.implement],
      ["Remove one chart: WebGPU swap chains configured again", isWebGPU ? one.configure : "n/a (WebGL)", isWebGPU ? subOne.configure : "n/a (WebGL)"],
      ["Remove one chart: renders of the other charts / panels in the next 3 frames", one.renders, subOne.renders],
      ["Remove one chart: time in the delete call, ms", one.deleteMs, subOne.deleteMs],
      [`Tear down the rest in one task: ClearDestinations() calls`, rest.clear, subAll.clear],
      [`Tear down the rest: destinations re-added (expected ${expectedTeardown})`, rest.add, subAll.add],
      ["Tear down the rest: WebGPU swap chains configured for charts about to be deleted", isWebGPU ? rest.configure : "n/a (WebGL)", isWebGPU ? subAll.configure : "n/a (WebGL)"],
      ["Tear down the rest: time in the delete calls, ms", rest.deleteMs, subAll.deleteMs],
    ],
    notes: [
      `Renderer: ${P.renderer()}. The call counts do not depend on hardware; the times do and grow with the cost of each wasm crossing. Under WebGL the survivors are not redrawn (their 2D canvases keep the last frame); under WebGPU ClearDestinations releases every swap chain, so each survivor is configured and drawn again. Removing a sub-chart redraws the parent surface, which draws its remaining panels, but changes no destination.`,
      "The issue's library fix defers the resync to one microtask per task, so a teardown re-adds nothing that is about to be deleted; no app-side workaround removes the teardown cost for separate create() charts.",
    ],
    metrics: { N, isWebGPU, one, rest, subOne, subAll, expectedTeardown },
  });
}
