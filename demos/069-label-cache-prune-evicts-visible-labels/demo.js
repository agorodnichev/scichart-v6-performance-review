const META = {
  id: "069",
  title: "labelCache.pruneCache evicts on-screen labels every 200 ms once more than 200 are visible",
  issue: "issues/069-label-cache-prune-evicts-visible-labels.md",
  severity: "medium",
  claim: "The shared label cache prunes min(size/2, 2 x (size - maxSize)) of its least recently used entries every 200 ms whenever it holds more than maxSize (200) labels, however recently they were used. When more than 200 labels are on screen, every prune removes labels that are drawn again on the next frame, so they are measured (native text) or rasterized and uploaded (canvas text) again, about five times per second.",
  method: "<p>Six charts, each with an X and a Y NumericAxis over its own fixed range and maxAutoTicks: 20, so the axes draw about 250 distinct labels in total (the default labelCache maxSize is 200). Every chart is invalidated on every frame; nothing else changes, so a working cache would create no labels at all in the steady state.</p><p>The demo wraps the exported labelCache: getLabel (hit or miss, and whether a missed label was drawn in the previous two frames), setLabel (a label created) and pruneCache (how many entries each prune removed). It also counts LabelProviderBase2D.getLabelSizesNative (native measurement) and TextureManager.createTextTexture (canvas-text rasterization). Each mode runs for 150 frames as shipped, then again after the issue's app-side workaround labelCache.setMaxSize(1000), first with the default native text, then with every axis switched to canvas text (useNativeText: false).</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, NumberRange, EAutoRange, labelCache, TextureManager } = P.SciChart;
  const CHARTS = 6, FRAMES = 150;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948"];
  const defaultMaxSize = labelCache.getMaxSize();

  const surfaces = [], axes = [];
  for (let k = 0; k < CHARTS; k++) {
    const { sciChartSurface, wasmContext } = await P.createSurface("c" + k);
    // Each chart has its own ranges, so label texts do not repeat across charts.
    const x = new NumericAxis(wasmContext, { autoRange: EAutoRange.Never, visibleRange: new NumberRange(k * 1000, k * 1000 + 100), maxAutoTicks: 20 });
    const y = new NumericAxis(wasmContext, { autoRange: EAutoRange.Never, visibleRange: new NumberRange(k * 50, k * 50 + 20), maxAutoTicks: 20 });
    sciChartSurface.xAxes.add(x);
    sciChartSurface.yAxes.add(y);
    const xs = Array.from({ length: 200 }, (_, i) => k * 1000 + i / 2);
    sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, {
      dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((v, i) => k * 50 + 10 + 8 * Math.sin(i / 15)), isSorted: true, containsNaN: false }),
      stroke: COLORS[k], strokeThickness: 2,
    }));
    surfaces.push(sciChartSurface);
    axes.push(x, y);
  }
  await P.sleep(800);

  // ---- counters on the exported label cache (local helper)
  let frameNo = 0, recordKeys = null;
  const lastSeen = new Map(); // "text|:|styleId" -> frame it was last drawn
  const keyOf = (a) => a[0] + "|:|" + a[1];
  P.hookMethod(labelCache, "getLabel", {
    name: "labelCache.getLabel",
    onCall: (a, self, ret) => {
      const k = keyOf(a);
      if (recordKeys) recordKeys.add(k);
      if (ret) { lastSeen.set(k, frameNo); return; }
      P.count("label cache misses");
      if (lastSeen.has(k) && frameNo - lastSeen.get(k) <= 2) P.count("misses on labels drawn in the previous 2 frames");
    },
  });
  P.hookMethod(labelCache, "setLabel", {
    name: "labels created (setLabel)",
    onCall: (a) => { const k = keyOf(a); lastSeen.set(k, frameNo); if (recordKeys) recordKeys.add(k); },
  });
  const prune0 = labelCache.pruneCache;
  labelCache.pruneCache = function () {
    const before = labelCache.getSize();
    const r = prune0.apply(this, arguments);
    const removed = before - labelCache.getSize();
    if (removed > 0) { P.count("prunes that removed labels"); P.count("labels removed by prune", removed); }
    return r;
  };
  // LabelProviderBase2D is not in the UMD bundle's export map: take its prototype from a label provider.
  let lpBase = Object.getPrototypeOf(axes[0].labelProvider);
  while (lpBase && !Object.prototype.hasOwnProperty.call(lpBase, "getLabelSizesNative")) lpBase = Object.getPrototypeOf(lpBase);
  P.hookMethod(lpBase, "getLabelSizesNative", { name: "getLabelSizesNative", time: true, onCall: (a) => P.count("labels measured natively", a[0] ? a[0].length : 0) });
  P.hookMethod(TextureManager.prototype, "createTextTexture", { name: "label textures rasterized (createTextTexture)", time: true });

  const tick = () => { frameNo++; surfaces.forEach((s) => s.invalidateElement()); };
  async function run(label) {
    await P.frames(40, tick); // settle: the cache refills after a mode or size change
    const r = await P.frames(FRAMES, (i) => { if (i === FRAMES - 1) recordKeys = new Set(); tick(); });
    const workingSet = recordKeys ? recordKeys.size : 0;
    recordKeys = null;
    const sec = r.ms / 1000;
    const res = {
      workingSet,
      cacheSize: labelCache.getSize(),
      maxSize: labelCache.getMaxSize(),
      prunesPerSec: r.total("prunes that removed labels") / sec,
      removedPerPrune: r.total("prunes that removed labels") ? r.total("labels removed by prune") / r.total("prunes that removed labels") : 0,
      removedPerSec: r.total("labels removed by prune") / sec,
      visibleMissesPerSec: r.total("misses on labels drawn in the previous 2 frames") / sec,
      createdPerSec: r.total("labels created (setLabel)") / sec,
      measuredPerSec: r.total("labels measured natively") / sec,
      rasterizedPerSec: r.total("label textures rasterized (createTextTexture)") / sec,
      labelMsPerSec: (r.total("getLabelSizesNative", "t") + r.total("label textures rasterized (createTextTexture)", "t")) / sec,
      p95: r.frameP95,
      removed: r.total("labels removed by prune"),
      visibleMisses: r.total("misses on labels drawn in the previous 2 frames"),
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Native text, default maxSize 200…");
  const nat = await run("native text, as shipped");
  labelCache.setMaxSize(1000);
  P.status("Native text, labelCache.setMaxSize(1000)…");
  const natFix = await run("native text, setMaxSize(1000)");
  labelCache.setMaxSize(defaultMaxSize);

  axes.forEach((a) => { a.labelProvider.useNativeText = false; }); // switches each axis to the canvas-text renderer
  P.status("Canvas text, default maxSize 200…");
  const tex = await run("canvas text, as shipped");
  labelCache.setMaxSize(1000);
  P.status("Canvas text, labelCache.setMaxSize(1000)…");
  const texFix = await run("canvas text, setMaxSize(1000)");
  labelCache.setMaxSize(defaultMaxSize);
  labelCache.pruneCache = prune0;

  const evicts = (s) => s.removed > 0 && s.visibleMisses >= 0.8 * s.removed;
  const reproduced = nat.workingSet > defaultMaxSize && evicts(nat) && natFix.createdPerSec <= 0.05 * nat.createdPerSec && evicts(tex);
  P.report({
    verdict: reproduced ? "reproduced" : (nat.workingSet <= defaultMaxSize ? "inconclusive" : "not-reproduced"),
    headline: reproduced
      ? `With ${nat.workingSet} labels on screen (maxSize ${defaultMaxSize}), the cache prunes ${nat.prunesPerSec.toFixed(1)} times per second, removing ${nat.removedPerPrune.toFixed(0)} labels each time, and ${(100 * nat.visibleMisses / nat.removed).toFixed(0)}% of them are missed again within two frames: ${nat.createdPerSec.toFixed(0)} labels re-created per second (canvas text: ${tex.rasterizedPerSec.toFixed(0)} textures/s). With setMaxSize(1000): ${natFix.createdPerSec.toFixed(0)}.`
      : `Expected on-screen labels to be pruned and re-created; measured ${nat.workingSet} labels on screen, ${nat.removed} removed and ${nat.visibleMisses} re-missed within two frames (native), ${tex.removed} and ${tex.visibleMisses} (canvas text).`,
    columns: ["Native text, as shipped", "Native, setMaxSize(1000)", "Canvas text, as shipped", "Canvas, setMaxSize(1000)"],
    rows: [
      ["Distinct labels drawn in one frame (all charts)", nat.workingSet, natFix.workingSet, tex.workingSet, texFix.workingSet],
      ["labelCache maxSize", nat.maxSize, natFix.maxSize, tex.maxSize, texFix.maxSize],
      ["labelCache size at the end of the run", nat.cacheSize, natFix.cacheSize, tex.cacheSize, texFix.cacheSize],
      ["Prunes that removed labels, per second", nat.prunesPerSec, natFix.prunesPerSec, tex.prunesPerSec, texFix.prunesPerSec],
      ["Labels removed per prune", nat.removedPerPrune, natFix.removedPerPrune, tex.removedPerPrune, texFix.removedPerPrune],
      ["Removed labels missed again within 2 frames (on screen), per second", nat.visibleMissesPerSec, natFix.visibleMissesPerSec, tex.visibleMissesPerSec, texFix.visibleMissesPerSec],
      ["Labels re-created (labelCache.setLabel), per second", nat.createdPerSec, natFix.createdPerSec, tex.createdPerSec, texFix.createdPerSec],
      ["Labels measured natively (getLabelSizesNative), per second", nat.measuredPerSec, natFix.measuredPerSec, tex.measuredPerSec, texFix.measuredPerSec],
      ["Label textures rasterized (createTextTexture), per second", nat.rasterizedPerSec, natFix.rasterizedPerSec, tex.rasterizedPerSec, texFix.rasterizedPerSec],
      ["Time re-creating labels, ms per second", nat.labelMsPerSec, natFix.labelMsPerSec, tex.labelMsPerSec, texFix.labelMsPerSec],
      ["Frame interval p95, ms", nat.p95, natFix.p95, tex.p95, texFix.p95],
    ],
    notes: [
      "Counts do not depend on hardware; times do. The ranges never change, so every label created during a run is one that the prune removed while it was still on screen.",
      "In canvas-text mode each re-created label is a Canvas 2D rasterization, a getImageData and a texture upload (each also clears the 1920x1080 scratch canvas, issue 011). setMaxSize(n) above the number of labels on screen is the issue's app-side workaround; the library fix would skip entries used within minAge.",
      `The library's labelCacheTooSmall performance warning fires only when one prune removes more than maxSize entries; here each prune removes ${nat.removedPerPrune.toFixed(0)} (maxSize ${defaultMaxSize}), so this churn is never reported.`,
    ],
    metrics: { nat, natFix, tex, texFix, defaultMaxSize },
  });
}
