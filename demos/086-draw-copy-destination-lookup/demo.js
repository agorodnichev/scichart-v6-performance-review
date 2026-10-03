const META = {
  id: "086",
  title: "Each per-frame Draw and Copy callback copies and scans the whole destination list: 2N arrays and O(N^2) compares for N charts",
  issue: "issues/086-draw-copy-destination-lookup-allocates-per-frame.md",
  severity: "low",
  claim: "The engine's per-frame Draw(canvasId) callback, and under WebGL the CopyToDestination callback, find their chart with getDestinations('2d').find(...). getDestinations walks the global destination store with forEach and returns a fresh array on every call, so N streaming create() charts cost 2N array allocations (N under WebGPU) and about N^2 canvas-id comparisons per frame.",
  method: "<p>Grids of 6, 12 and 24 small create() charts, each receiving one appended point per frame, 40 frames per size. getDestinations and the store are internal (not exported), so the demo finds the store through what it calls: for two frames it wraps Array.prototype.forEach and keeps the array of destination records that is walked once per drawn chart (the same object every time, unlike the fresh result arrays). It then gives that store array an own forEach that counts walks (each walk is one getDestinations call, which allocates one result array), and gives every destination record a canvasElementId getter that counts the comparisons made by .find(). Draw callbacks are counted on the RenderSurface prototype (onRenderTimeElapsed), and under WebGL the 2D copies into the charts' canvases are counted on drawImage. Nothing in the library is patched, so there is no A/B run: the fix would change code inside closures the page cannot reach.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, EAutoRange } = P.SciChart;
  const SIZES = [6, 12, 24], FRAMES = 40;
  const grid = document.getElementById("grid");
  const charts = [];

  async function addCharts(n) {
    while (charts.length < n) {
      const id = `cell${charts.length}`;
      const div = document.createElement("div");
      div.id = id; div.className = "cell";
      grid.appendChild(div);
      const { sciChartSurface, wasmContext } = await P.createSurface(id);
      sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always, isVisible: false }));
      sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always, isVisible: false }));
      const ds = new XyDataSeries(wasmContext, { fifoCapacity: 200, isSorted: true, containsNaN: false });
      for (let x = 0; x < 200; x++) ds.append(x, Math.sin(x / 15 + charts.length));
      sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries: ds, stroke: "#4e79a7", strokeThickness: 1 }));
      charts.push({ surface: sciChartSurface, ds, x: 200 });
    }
    await P.sleep(300);
  }
  const step = () => charts.forEach((c, i) => { c.x++; c.ds.append(c.x, Math.sin(c.x / 15 + i)); });

  await addCharts(SIZES[0]);

  // --- find the destination store through Array.prototype.forEach --------------------
  const isDestination = (o) => o && typeof o === "object" && "canvasElementId" in o && "sciChartSurface" in o && "kind" in o;
  const seen = new Map();
  const arrayForEach = Array.prototype.forEach;
  Array.prototype.forEach = function () {
    if (this.length && isDestination(this[0])) seen.set(this, (seen.get(this) || 0) + 1);
    return arrayForEach.apply(this, arguments);
  };
  try { await P.frames(2, step); } finally { Array.prototype.forEach = arrayForEach; }
  let store = null, best = 0;
  seen.forEach((n, arr) => { if (n > best) { best = n; store = arr; } });
  if (!store) throw new Error("could not locate the destination store (no forEach over destination records seen)");

  // --- instrument the store and its records ------------------------------------------
  Object.defineProperty(store, "forEach", { configurable: true, writable: true, value: function () { P.count("destination store walks (getDestinations calls)"); return arrayForEach.apply(this, arguments); } });
  const instrumentRecords = () => {
    let n = 0;
    for (let i = 0; i < store.length; i++) {
      const rec = store[i];
      const d = Object.getOwnPropertyDescriptor(rec, "canvasElementId");
      if (d && !d.get) {
        let v = d.value;
        Object.defineProperty(rec, "canvasElementId", { configurable: true, enumerable: true, get() { P.count("canvasElementId comparisons"); return v; }, set(nv) { v = nv; } });
      }
      if (d) n++;
    }
    return n;
  };
  const rsProto = Object.getPrototypeOf(charts[0].surface.renderSurface);
  P.hookMethod(rsProto, "onRenderTimeElapsed", { name: "Draw callbacks (charts drawn)" });
  const canvases = new Set();
  P.hookMethod(CanvasRenderingContext2D.prototype, "drawImage", { name: "drawImage (all)", onCall: (a, self) => { if (canvases.has(self.canvas)) P.count("2D copies into chart canvases"); } });

  const results = [];
  for (const n of SIZES) {
    await addCharts(n);
    charts.forEach((c) => canvases.add(c.surface.domCanvas2D));
    const records = instrumentRecords();
    P.status(`Streaming into ${n} charts…`);
    await P.frames(5, step);
    const r = await P.frames(FRAMES, step);
    const res = {
      n, records,
      drawn: r.perFrame("Draw callbacks (charts drawn)"),
      walks: r.perFrame("destination store walks (getDestinations calls)"),
      compares: r.perFrame("canvasElementId comparisons"),
      copies: r.perFrame("2D copies into chart canvases"),
      p95: r.frameP95,
    };
    res.walksPerDrawn = res.drawn ? res.walks / res.drawn : 0;
    res.comparesPerN2 = res.compares / (n * n);
    P.log(`${n} charts: ${JSON.stringify(res)}`);
    results.push(res);
  }
  delete store.forEach;

  const webgpu = P.renderer() === "WebGPU";
  const lookups = webgpu ? 1 : 2; // Draw, plus CopyToDestination under WebGL
  const expectedCompares = (n) => (lookups * n * (n + 1)) / 2;
  const ok = results.every((r) => r.drawn >= 0.9 * r.n && r.walks >= 0.9 * lookups * r.drawn && r.compares >= 0.9 * expectedCompares(r.n));
  const first = results[0], last = results[results.length - 1];
  P.report({
    verdict: ok ? "reproduced" : "not-reproduced",
    headline: ok
      ? `With ${last.n} streaming charts every frame walks the destination store ${last.walks.toFixed(0)} times (${last.walksPerDrawn.toFixed(1)} fresh arrays per drawn chart) and makes ${last.compares.toFixed(0)} canvas-id comparisons; with ${first.n} charts: ${first.walks.toFixed(0)} walks and ${first.compares.toFixed(0)} comparisons. Comparisons grow with N^2 (${P.renderer()}: ${lookups} lookup${lookups > 1 ? "s" : ""} per drawn chart).`
      : `Expected ${lookups} store walks per drawn chart and about ${lookups} x N(N+1)/2 comparisons per frame; measured ${last.walksPerDrawn.toFixed(2)} walks per drawn chart and ${last.compares.toFixed(0)} comparisons at N = ${last.n}.`,
    columns: results.map((r) => `${r.n} charts`),
    rows: [
      ["Destination records in the store", ...results.map((r) => r.records)],
      ["Draw callbacks per frame (charts drawn)", ...results.map((r) => r.drawn)],
      ["2D copies into chart canvases per frame (WebGL copy step)", ...results.map((r) => r.copies)],
      ["Store walks per frame (one getDestinations call and one new array each)", ...results.map((r) => r.walks)],
      ["  per drawn chart", ...results.map((r) => r.walksPerDrawn)],
      ["canvasElementId comparisons per frame (.find scans)", ...results.map((r) => r.compares)],
      [`  expected ${lookups} x N(N+1)/2`, ...results.map((r) => expectedCompares(r.n))],
      ["  comparisons / N^2", ...results.map((r) => r.comparesPerN2)],
      ["Frame interval p95, ms", ...results.map((r) => r.p95)],
    ],
    notes: [
      "Counts do not depend on hardware. Under WebGPU there is no copy step, so each drawn chart is looked up once; under WebGL twice (Draw, then CopyToDestination). Each walk also visits every record of every kind to build its result array.",
      "The work per lookup is small; the issue rates it low because it only becomes steady young-generation garbage and quadratic scanning on dashboards with 50-100+ streaming create() charts. No timing row: the per-frame cost here is far below timer and frame-interval resolution.",
    ],
    metrics: { results, renderer: P.renderer(), lookups },
  });
}
