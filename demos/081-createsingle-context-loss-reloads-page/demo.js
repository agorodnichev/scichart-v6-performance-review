const META = {
  id: "081",
  title: "A createSingle() chart reloads the whole page when its WebGL context is lost",
  issue: "issues/081-createsingle-context-loss-reloads-page.md",
  severity: "low",
  claim: "initCanvas() adds a webglcontextlost listener to every createSingle() canvas that calls location.reload(), although monitorWebGL() also registers loss and restore handlers on the same canvas. One GPU reset, driver update or context eviction throws away all page state; past the browser's live-context limit the reload repeats.",
  method: "<p>So that the page survives, a <code>navigate</code> listener (Navigation API) records every reload the page attempts and cancels it. (Browsers without the Navigation API get one real reload; a sessionStorage marker then reports it and the loss is not simulated again.)</p><p>WebGL: (1) two createSingle() charts; the first one's context is lost with WEBGL_lose_context.loseContext() and restored 1 s later. Counted: reload attempts, the library's \"Reloading the page\" warning, frames the <i>second</i> chart draws during the loss while it is invalidated every frame, and frames the first chart draws after the restore. (2) The workaround, a create() chart: the same loss on the shared master canvas. (3) The real trigger: the page creates 16 plain WebGL contexts, so the browser evicts its oldest ones, and the reload attempts are counted again.</p><p>WebGPU canvases never fire webglcontextlost, so on WebGPU the verdict is inconclusive; the page only shows, with a synthetic event, that the listener is attached anyway.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries } = P.SciChart;
  const MARK = "demo081.reloadMarker";

  // ---- reload capture: cancel and count reloads (Navigation API), or detect one real reload (fallback)
  const reloads = [];
  const canCancel = !!window.navigation;
  if (canCancel) {
    navigation.addEventListener("navigate", (e) => {
      if (e.navigationType !== "reload") return;
      reloads.push({ t: P.now(), cancelable: e.cancelable });
      if (e.cancelable) e.preventDefault();
    });
  }
  let marker = null;
  try { marker = JSON.parse(sessionStorage.getItem(MARK) || "null"); sessionStorage.removeItem(MARK); } catch (e) { /* storage blocked */ }
  const navType = (performance.getEntriesByType("navigation")[0] || {}).type;
  if (marker && navType === "reload") {
    P.report({
      verdict: "reproduced",
      headline: `The previous run simulated "${marker.what}" and the library reloaded the page (navigation type "${navType}"). The reload could not be intercepted in this browser${canCancel ? "" : " (no Navigation API)"}, so the loss is not simulated again.`,
      columns: ["Value"],
      rows: [["Navigation type of this page load", navType], ["Simulated loss in the previous run", marker.what]],
      notes: ["Run the page in a Chromium browser to see the full comparison with create() and the context-limit test."],
    });
    return;
  }
  // The marker is set around every simulated loss: if a reload gets through (no Navigation API, or a
  // reload that is not cancelable), the next load reports it instead of simulating the loss again.
  async function captureReloads(what, fn) {
    const before = reloads.length;
    try { sessionStorage.setItem(MARK, JSON.stringify({ what })); } catch (e) { /* ignore */ }
    await fn();
    try { sessionStorage.removeItem(MARK); } catch (e) { /* ignore */ }
    return reloads.length - before;
  }

  // ---- console messages from the two handlers
  P.hookMethod(console, "warn", {
    name: "console.warn",
    onCall(a) {
      const s = String(a[0]);
      if (/Reloading the page/.test(s)) P.count("warn: Reloading the page");
      else if (/WebGL context lost/.test(s)) P.count("warn: context lost (monitorWebGL)");
      else if (/WebGL context restored/.test(s)) P.count("warn: context restored (monitorWebGL)");
    },
  });

  const xs = Array.from({ length: 300 }, (_, i) => i);
  async function chart(div, single) {
    const r = await P.createSurface(div, undefined, single);
    r.sciChartSurface.xAxes.add(new NumericAxis(r.wasmContext));
    r.sciChartSurface.yAxes.add(new NumericAxis(r.wasmContext));
    r.sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(r.wasmContext, {
      dataSeries: new XyDataSeries(r.wasmContext, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 25)), isSorted: true, containsNaN: false }),
      stroke: single ? "#e15759" : "#4e79a7", strokeThickness: 2,
    }));
    let renders = 0;
    r.sciChartSurface.rendered.subscribe(() => { renders++; });
    r.renders = () => renders;
    return r;
  }
  async function drawnWhileInvalidating(surfaceRec, ms) {
    const r0 = surfaceRec.renders(), t0 = P.now();
    while (P.now() - t0 < ms) { surfaceRec.sciChartSurface.invalidateElement(); await P.nextFrame(); }
    return surfaceRec.renders() - r0;
  }
  const loseExt = (canvas) => { const gl = canvas && (canvas.getContext("webgl2") || canvas.getContext("webgl")); return gl ? gl.getExtension("WEBGL_lose_context") : null; };

  P.status("Creating two createSingle() charts…");
  const s1 = await chart("single1", true);
  const s2 = await chart("single2", true);
  await P.sleep(500);
  const isWebGPU = P.renderer() === "WebGPU";

  if (isWebGPU) {
    // No real webglcontextlost can happen here. Show that the reload listener is attached anyway.
    const canvas = document.getElementById("single1_WebGL");
    const synthetic = await captureReloads("synthetic webglcontextlost on a WebGPU canvas", async () => {
      canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
      await P.sleep(300);
    });
    P.report({
      verdict: "inconclusive",
      headline: `This run used WebGPU: createSingle() canvases have WebGPU contexts, which never fire webglcontextlost, so the reload path cannot be reached. The listener is still attached: a synthetic event caused ${synthetic} reload attempt(s). Choose Renderer: WebGL to test the claim.`,
      columns: ["Value"],
      rows: [
        ["WEBGL_lose_context available on the createSingle canvas", loseExt(canvas) ? "yes" : "no (WebGPU canvas)"],
        ["Reload attempts after a synthetic webglcontextlost event", synthetic],
        ["\"Reloading the page\" warnings", P.get(P.snap(), "warn: Reloading the page")],
      ],
      notes: [`Reloads ${canCancel ? "were intercepted with the Navigation API" : "could not be intercepted in this browser"}.`],
      metrics: { isWebGPU, synthetic },
    });
    return;
  }

  // (1) createSingle: lose the first chart's context, restore it after 1 s.
  P.status("Losing the first createSingle chart's WebGL context…");
  const c1 = s1.wasmContext.canvas || document.getElementById("single1_WebGL");
  const ext1 = loseExt(c1);
  let s2DuringLoss = 0, s1AfterRestore = 0, s2AfterRestore = 0, s2ActiveDuringLoss = null, s1ActiveAfterRestore = null;
  const single = await P.during(async () => {
    await captureReloads("WEBGL_lose_context on createSingle chart 1", async () => {
      ext1.loseContext();
      await P.sleep(100);
      s2ActiveDuringLoss = s2.sciChartSurface.isWebGLContextActive;
      s2DuringLoss = await drawnWhileInvalidating(s2, 900);
      ext1.restoreContext();
      await P.sleep(300);
      s1ActiveAfterRestore = s1.sciChartSurface.isWebGLContextActive;
      s1AfterRestore = await drawnWhileInvalidating(s1, 1500);
      s2AfterRestore = await drawnWhileInvalidating(s2, 500);
    });
  });
  const singleReloads = reloads.length;
  P.log(`createSingle loss: ${singleReloads} reload attempt(s); chart 2 drew ${s2DuringLoss} frames during the loss (isWebGLContextActive=${s2ActiveDuringLoss}); after restore chart 1 drew ${s1AfterRestore} frames in 1.5 s (isWebGLContextActive=${s1ActiveAfterRestore}), chart 2 ${s2AfterRestore} in 0.5 s`);

  // (2) Workaround: create() chart, loss on the shared master canvas.
  P.status("Workaround: a create() chart, losing the master canvas context…");
  const m = await chart("multi", false);
  await P.sleep(400);
  const master = document.getElementById("SciChartMasterCanvas");
  const extM = loseExt(master);
  let mAfterRestore = 0;
  const multi = await P.during(async () => {
    await captureReloads("WEBGL_lose_context on the create() master canvas", async () => {
      extM.loseContext();
      await P.sleep(500);
      extM.restoreContext();
      await P.sleep(300);
      mAfterRestore = await drawnWhileInvalidating(m, 500);
    });
  });
  const multiReloads = reloads.length - singleReloads;
  P.log(`create() loss: ${multiReloads} reload attempt(s); chart drew ${mAfterRestore} frames after restore`);

  // (3) The real trigger: more live WebGL contexts than the browser keeps.
  P.status("Creating 16 plain WebGL contexts (browser context limit)…");
  const lostSci = [];
  [c1, document.getElementById("single2_WebGL"), master].forEach((c, i) => c && c.addEventListener("webglcontextlost", () => lostSci.push(["createSingle 1", "createSingle 2", "create() master"][i])));
  const extra = [];
  const capReloads = await captureReloads("16 extra WebGL contexts", async () => {
    for (let i = 0; i < 16; i++) {
      const c = document.createElement("canvas"); c.width = c.height = 8;
      const gl = c.getContext("webgl2");
      if (gl) { gl.clear(gl.COLOR_BUFFER_BIT); extra.push(gl); }
    }
    await P.sleep(800);
  });
  extra.forEach((gl) => { const e = gl.getExtension("WEBGL_lose_context"); if (e) e.loseContext(); });
  P.log(`context limit: ${extra.length} extra contexts; SciChart canvases evicted: ${lostSci.join(", ") || "none"}; reload attempts: ${capReloads}`);

  const reproduced = singleReloads >= 1 && single.total("warn: Reloading the page") >= 1 && multiReloads === 0;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Losing one createSingle() context made the library call location.reload() ${singleReloads} time(s) (cancelled here so the page could keep measuring); the same loss on a create() chart: ${multiReloads}. With 16 more WebGL contexts on the page the browser evicted ${lostSci.length} SciChart context(s) and the page tried to reload ${capReloads} more time(s).`
      : `Expected a reload attempt for the createSingle loss and none for create(); measured ${singleReloads} and ${multiReloads}.`,
    columns: ["createSingle() (as shipped)", "create() (workaround)"],
    rows: [
      ["Reload attempts after one context loss", singleReloads, multiReloads],
      ["\"WebGL context lost. Reloading the page.\" warnings", single.total("warn: Reloading the page"), multi.total("warn: Reloading the page")],
      ["monitorWebGL loss / restore handlers run", `${single.total("warn: context lost (monitorWebGL)")} / ${single.total("warn: context restored (monitorWebGL)")}`, `${multi.total("warn: context lost (monitorWebGL)")} / ${multi.total("warn: context restored (monitorWebGL)")}`],
      ["Lost chart: frames drawn after restoreContext() (invalidated every frame)", `${s1AfterRestore} in 1.5 s`, `${mAfterRestore} in 0.5 s`],
      ["Second createSingle chart: frames drawn during the first one's loss (0.9 s)", s2DuringLoss, null],
      ["Second createSingle chart: isWebGLContextActive during that loss", String(s2ActiveDuringLoss), null],
      ["Second createSingle chart: frames drawn after the restore (0.5 s)", s2AfterRestore, null],
      ["16 extra WebGL contexts: SciChart contexts evicted by the browser", lostSci.length, null],
      ["16 extra WebGL contexts: further reload attempts", capReloads, null],
    ],
    notes: [
      `Renderer: ${P.renderer()}. Counts are hardware-independent. Without the cancellation each attempt is a full page load: HTML, scripts, wasm download and compile, data, and all app state lost. Evicted: ${lostSci.join(", ") || "none"}.`,
      `Because the reload was cancelled, monitorWebGL's handlers ran. The create() chart drew again after restoreContext(); the createSingle chart drew ${s1AfterRestore} frames in 1.5 s after its restore (isWebGLContextActive = ${s1ActiveAfterRestore}; Chrome logs \"bindBufferBase: object does not belong to this context\" in DevTools), so in this test the createSingle restore path does not bring the chart back either: removing the reload alone would leave it blank until it is re-created. The second-chart rows show the scoping problem the issue's fix also addresses: a loss on one createSingle context marks every createSingle chart inactive, so the second chart ignores its redraws until the first context is restored.`,
    ],
    metrics: { singleReloads, multiReloads, capReloads, lostSci, s2DuringLoss, s2ActiveDuringLoss, s1AfterRestore, s1ActiveAfterRestore, s2AfterRestore, mAfterRestore, canCancel },
  });
}
