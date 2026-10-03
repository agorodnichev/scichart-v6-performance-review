const META = {
  id: "071",
  title: "Every axis owns two 1920x1080 scratch canvases, each a 7.9 MiB CPU bitmap once used",
  issue: "issues/071-two-1920x1080-scratch-canvases-per-axis.md",
  severity: "medium",
  claim: "Each TextureManager creates its own 1920x1080 willReadFrequently canvas, and every axis has two of them (axis renderer and axis title renderer) plus one per chart title. Each canvas that is drawn into holds a 1920 x 1080 x 4 byte CPU bitmap, although one shared scratch canvas would do, because every texture is rasterized and read back synchronously.",
  method: "<p>Before any chart exists, the demo wraps HTMLCanvasElement.prototype.getContext to record every 2D context opened with willReadFrequently on a 1920x1080 canvas (TextureManager's scratch canvas), and TextureManager.prototype methods to record which of those canvases are drawn into. Four charts with two axes each (each over its own data range) are created with the default native text, then given one AxisMarkerAnnotation each. Four more charts are created with canvas text (SciChartDefaults.useNativeText = false), axis titles and a chart title; they are deleted and created again with a runtime patch that points every TextureManager at one shared scratch canvas, as the issue's fix does.</p><p>Bitmap memory is not visible to page scripts, so the bytes shown are implied: width x height x 4 for each scratch canvas that has been drawn into (browsers allocate the backing store lazily). After the canvas-text charts are deleted, the demo checks whether their scratch canvases were resized to 0 and, where the page can force a garbage collection, whether they are still alive.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, AxisMarkerAnnotation, SciChartDefaults, TextureManager } = P.SciChart;
  const CHARTS = 4, AXES = 2;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2"];

  // ---- scratch canvas tracking (local helper), installed before any chart exists
  const created = [];               // WeakRefs to every scratch canvas, in creation order
  const createdIn = new WeakMap();  // scratch canvas -> phase that created it
  let phaseName = "", countFor = "";
  let touchedNow = new WeakSet(), touchedCount = 0, touchedBytes = 0;
  const getContext0 = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, opts) {
    if (type === "2d" && opts && opts.willReadFrequently && this.width === 1920 && this.height === 1080 && !createdIn.has(this)) {
      createdIn.set(this, phaseName);
      created.push(new WeakRef(this));
    }
    return getContext0.apply(this, arguments);
  };
  // Count a canvas once per phase, and only if it belongs to the charts of that phase (other charts keep redrawing).
  const markTouched = (cv) => {
    if (!cv || touchedNow.has(cv) || createdIn.get(cv) !== countFor) return;
    touchedNow.add(cv); touchedCount++; touchedBytes += cv.width * cv.height * 4;
  };
  let shared = null, useShared = false, sharedCreated = 0; // the patch: one scratch canvas for every TextureManager
  const TM = TextureManager.prototype;
  const tmRestore = [];
  ["createTextTexture", "createAxisMarkerTexture", "createTextureFromImage", "createFilledRectTexture", "getTextureContext", "createTextureFromCtxBuffer"].forEach((m) => {
    const orig = TM[m];
    TM[m] = function () {
      if (useShared && this.canvas) {
        if (!shared) { const c = document.createElement("canvas"); c.width = 1920; c.height = 1080; shared = { canvas: c, ctx: c.getContext("2d", { willReadFrequently: true }) }; sharedCreated++; }
        this.canvas = shared.canvas; this.ctx = shared.ctx;
      }
      markTouched(this.canvas);
      return orig.apply(this, arguments);
    };
    tmRestore.push(() => { TM[m] = orig; });
  });
  const phase = (name, owner) => { phaseName = name; countFor = owner || name; touchedNow = new WeakSet(); touchedCount = 0; touchedBytes = 0; return created.length; };

  async function makeChart(div, k, opts) {
    const { sciChartSurface, wasmContext } = await P.createSurface(div, opts.title ? { title: opts.title } : undefined);
    sciChartSurface.xAxes.add(new NumericAxis(wasmContext, opts.titles ? { axisTitle: "Time" } : undefined));
    sciChartSurface.yAxes.add(new NumericAxis(wasmContext, opts.titles ? { axisTitle: "Value" } : undefined));
    // Each chart shows its own data range (as on a real dashboard), so tick label texts differ between charts
    // and are not all served by the label cache shared across charts.
    const xs = Array.from({ length: 200 }, (_, i) => k * 1000 + i);
    sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, {
      dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x, i) => k * 10 + Math.sin(i / 20 + k)), isSorted: true, containsNaN: false }),
      stroke: COLORS[k], strokeThickness: 2,
    }));
    return sciChartSurface;
  }
  const mb = (b) => b / 1048576;
  // Wait until every chart has rendered: redraw all, then until the drawn-into count is stable for 20 frames (max 4 s).
  async function settle(surfaces) {
    surfaces.forEach((s) => s.invalidateElement());
    const t0 = P.now();
    let last = -1, stable = 0;
    while (stable < 20 && P.now() - t0 < 4000) {
      await P.nextFrame();
      if (touchedCount === last) stable++; else { stable = 0; last = touchedCount; }
    }
  }

  // A: default native text
  P.status("Four native-text charts…");
  let c0 = phase("A");
  const native = [];
  for (let k = 0; k < CHARTS; k++) native.push(await makeChart("a" + k, k, {}));
  await settle(native);
  const A = { created: created.length - c0, touched: touchedCount, bytes: touchedBytes };
  P.log(`native text: ${JSON.stringify(A)}`);

  // B: one AxisMarkerAnnotation per native chart
  P.status("Adding one AxisMarkerAnnotation per chart…");
  c0 = phase("B", "A"); // the markers draw on the phase-A charts' axis renderers
  native.forEach((s, k) => s.annotations.add(new AxisMarkerAnnotation({ y1: k * 10 + 0.5, backgroundColor: COLORS[k] })));
  await settle(native);
  const B = { created: created.length - c0, touched: touchedCount, bytes: touchedBytes };
  P.log(`native text + axis markers: ${JSON.stringify(B)}`);

  // C: canvas text with axis titles and a chart title, as shipped
  const useNativeText0 = SciChartDefaults.useNativeText;
  SciChartDefaults.useNativeText = false;
  P.status("Four canvas-text charts with titles…");
  c0 = phase("C");
  let textCharts = [];
  for (let k = 0; k < CHARTS; k++) textCharts.push(await makeChart("b" + k, k, { titles: true, title: "Chart " + (k + 1) }));
  await settle(textCharts);
  const C = { created: created.length - c0, touched: touchedCount, bytes: touchedBytes };
  P.log(`canvas text + titles: ${JSON.stringify(C)}`);
  const cRefs = created.slice(c0);

  // After delete(): resized to 0? still alive after a forced GC?
  textCharts.forEach((s) => s.delete());
  textCharts = [];
  await P.sleep(200);
  const notReleased = cRefs.map((r) => r.deref()).filter((cv) => cv && cv.width === 1920 && cv.height === 1080).length;
  const gcForced = await P.gc();
  await P.sleep(100);
  const aliveAfterGc = gcForced ? cRefs.filter((r) => r.deref()).length : null;
  P.log(`after delete(): ${notReleased} of ${cRefs.length} still 1920x1080; after forced GC alive: ${aliveAfterGc}`);

  // D: the same charts with one shared scratch canvas
  useShared = true;
  P.status("The same canvas-text charts with one shared scratch canvas…");
  c0 = phase("D");
  for (let k = 0; k < CHARTS; k++) textCharts.push(await makeChart("b" + k, k, { titles: true, title: "Chart " + (k + 1) }));
  await settle(textCharts);
  const D = { created: created.length - c0 - sharedCreated, touched: touchedCount, bytes: touchedBytes, sharedCreated };
  P.log(`canvas text + titles, shared scratch canvas: ${JSON.stringify(D)}`);
  useShared = false;
  SciChartDefaults.useNativeText = useNativeText0;
  tmRestore.forEach((f) => f());
  HTMLCanvasElement.prototype.getContext = getContext0;

  const perChart = AXES * 2 + 1; // two per axis + one chart title
  const reproduced = A.created === CHARTS * perChart && C.created === CHARTS * perChart && C.touched >= 0.9 * CHARTS * perChart && B.touched >= CHARTS && D.touched <= 1;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each chart with ${AXES} axes creates ${A.created / CHARTS} scratch canvases of 1920x1080. With canvas text and titles all ${C.touched} of them get drawn into (${mb(C.bytes).toFixed(0)} MiB of bitmaps for ${CHARTS} charts); with default native text, one AxisMarkerAnnotation per chart uses ${B.touched} (${mb(B.bytes).toFixed(0)} MiB). With one shared canvas: ${D.touched} (${mb(D.bytes).toFixed(1)} MiB).`
      : `Expected ${perChart} scratch canvases per ${AXES}-axis chart and one shared canvas with the patch; measured ${A.created / CHARTS} per chart, ${C.touched} drawn into with canvas text, ${D.touched} with the patch.`,
    columns: ["Native text", "Native + axis markers", "Canvas text + titles", "Same, one shared canvas"],
    rows: [
      ["Charts (2 axes each)", CHARTS, CHARTS, CHARTS, CHARTS],
      ["1920x1080 willReadFrequently scratch canvases created by the charts", A.created, B.created, C.created, D.created],
      ["Scratch canvases created per chart", A.created / CHARTS, null, C.created / CHARTS, D.created / CHARTS],
      ["Distinct scratch canvases drawn into", A.touched, B.touched, C.touched, D.touched + (D.sharedCreated ? " (the shared one)" : "")],
      ["Implied CPU bitmap memory of those canvases, MiB", mb(A.bytes), mb(B.bytes), mb(C.bytes), mb(D.bytes)],
      ["After delete(): canvas-text scratch canvases still sized 1920x1080", null, null, notReleased, null],
      ["After delete() + forced GC: still alive", null, null, aliveAfterGc == null ? "n/a (no forced GC here)" : aliveAfterGc, null],
    ],
    notes: [
      "Canvas counts do not depend on hardware. The memory row is implied, not measured: page scripts cannot read bitmap memory, so it is width x height x 4 for each scratch canvas that has been drawn into. Browsers allocate a canvas's backing store lazily, so a canvas that is never drawn into should cost little.",
      "Each chart plots its own data range. Charts that showed identical tick texts would share cached canvas-text labels (the label cache is shared across charts on one wasm context), and their axis-renderer canvases could stay untouched; titles are rasterized per renderer regardless.",
      "The 'Native + axis markers' column counts only what the markers added (charts already existed). The shared-canvas patch swaps each TextureManager's canvas and context for one page-wide scratch canvas before it draws; the per-instance canvases are still created by the constructor but never drawn into. TextureManager.delete() drops its references without setting the canvas size to 0, so the bitmaps live until garbage collection.",
    ],
    metrics: { A, B, C, D, notReleased, aliveAfterGc, gcForced, perChart },
  });
}
