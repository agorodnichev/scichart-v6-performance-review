const META = {
  id: "054",
  title: "Deleting a createSingle() chart wipes the page-wide label cache: other charts re-measure labels and leak font keys",
  issue: "issues/054-createsingle-delete-wipes-global-label-cache.md",
  severity: "medium",
  claim: "The createSingle() delete handler calls labelCache.resetCache(), which clears every label and text style on the page, not just the deleted chart's. Style ids are never reused, so on its next frame every other chart gets a new style id, re-measures all its tick labels, and adds a new SCRTFontKey per font to its wasm context while the old one stays alive.",
  method: "<p>One long-lived create() chart stays on the page and is redrawn each frame while a createSingle() chart is opened and closed in the \"modal\" slot, 6 times as shipped and 6 times with a fix. Per close the demo counts: labelCache.resetCache() calls, tick labels the long-lived chart measures natively (labels passed to LabelProviderBase2D.getLabelSizesNative for its axes) in the 5 frames after the close, the font keys held by its wasm context (getAllFontKeys), and labelCache.getSize() right after the close.</p><p>Fix: labelCache.resetCache is wrapped so that it does nothing while a createSingle chart is being deleted. With native text (the default) and the shared cache, labels carry providerId \"native\" and are shared by all contexts, so this is what the issue's resetCacheForProvider(canvasId) does for them. The original is restored afterwards. 6 + 6 cycles keep the page under the browser's 16 live WebGL contexts (deleted createSingle canvases hold theirs until garbage collection).</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, labelCache, getAllFontKeys, NumericLabelProvider } = P.SciChart;
  const CYCLES = 6, FRAMES_AFTER = 5;

  // Safety net: an evicted WebGL context of a deleted createSingle canvas would reload the page (issue 081).
  let reloadsBlocked = 0;
  if (window.navigation) navigation.addEventListener("navigate", (e) => { if (e.navigationType === "reload" && e.cancelable) { e.preventDefault(); reloadsBlocked++; } });

  const xs = Array.from({ length: 500 }, (_, i) => i);
  const fill = (surface, wasmContext, color) => {
    surface.xAxes.add(new NumericAxis(wasmContext));
    surface.yAxes.add(new NumericAxis(wasmContext));
    surface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, {
      dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 30) * 3), isSorted: true, containsNaN: false }),
      stroke: color, strokeThickness: 2,
    }));
  };

  P.status("Creating the long-lived create() chart…");
  const main = await P.createSurface("main");
  fill(main.sciChartSurface, main.wasmContext, "#4e79a7");
  await P.idleFrames(10);

  // Count labels the long-lived chart measures, and global cache wipes.
  const survivor = main.sciChartSurface;
  // LabelProviderBase2D is not in the UMD namespace: take it from NumericLabelProvider's prototype chain.
  let base = NumericLabelProvider.prototype;
  while (base && !Object.prototype.hasOwnProperty.call(base, "getLabelSizesNative")) base = Object.getPrototypeOf(base);
  const measure = base.getLabelSizesNative;
  let measureMs = 0;
  base.getLabelSizesNative = function (labels) {
    const mine = labels && labels.length && this.parentAxis && this.parentAxis.parentSurface === survivor;
    const t0 = mine ? P.now() : 0;
    const ret = measure.apply(this, arguments);
    if (mine) { P.count("labels measured by the long-lived chart", labels.length); measureMs += P.now() - t0; }
    return ret;
  };
  const reset = labelCache.resetCache;
  let fixOn = false, inSingleDelete = false;
  labelCache.resetCache = function () {
    P.count("labelCache.resetCache() calls");
    if (fixOn && inSingleDelete) return undefined;
    P.count("global label cache wipes");
    return reset.apply(this, arguments);
  };

  async function cycles(label) {
    const keys0 = getAllFontKeys(main.wasmContext).length;
    measureMs = 0;
    const perClose = [];
    const r = await P.during(async () => {
      for (let c = 0; c < CYCLES; c++) {
        P.status(`${label}: open/close ${c + 1} / ${CYCLES}…`);
        const modal = await P.createSurface("modal", undefined, true);
        fill(modal.sciChartSurface, modal.wasmContext, "#e15759");
        await P.idleFrames(4);
        inSingleDelete = true;
        try { modal.sciChartSurface.delete(); } finally { inSingleDelete = false; }
        const sizeAfterClose = labelCache.getSize();
        const f = await P.frames(FRAMES_AFTER, () => survivor.invalidateElement());
        perClose.push({ labels: f.total("labels measured by the long-lived chart"), sizeAfterClose, fontKeys: getAllFontKeys(main.wasmContext).length });
      }
    });
    const res = {
      resetCalls: r.total("labelCache.resetCache() calls"),
      wipes: r.total("global label cache wipes"),
      labels: r.total("labels measured by the long-lived chart"),
      fontKeysAdded: getAllFontKeys(main.wasmContext).length - keys0,
      fontKeys: getAllFontKeys(main.wasmContext).length,
      sizeAfterClose: perClose.map((p) => p.sizeAfterClose),
      measureMs,
      perClose,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  // Steady state: how many labels does the long-lived chart measure per frame when nothing happens?
  const idle = await P.frames(CYCLES * FRAMES_AFTER, () => survivor.invalidateElement());
  const idleLabels = idle.total("labels measured by the long-lived chart");

  const shipped = await cycles("as shipped");
  fixOn = true;
  const fixed = await cycles("with fix");
  fixOn = false;
  labelCache.resetCache = reset;
  base.getLabelSizesNative = measure;

  const reproduced = shipped.wipes >= CYCLES && shipped.fontKeysAdded >= CYCLES * 0.8 && shipped.labels >= CYCLES && fixed.fontKeysAdded === 0 && fixed.labels <= idleLabels;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `${CYCLES} createSingle closes wiped the shared label cache ${shipped.wipes} times; the long-lived chart re-measured ${shipped.labels} tick labels and its wasm context gained ${shipped.fontKeysAdded} font keys (${shipped.fontKeys} now). With the reset skipped for the closing chart: ${fixed.labels} labels, ${fixed.fontKeysAdded} new font keys.`
      : `Expected one wipe, about one new font key and a label re-measure per close; measured ${shipped.wipes} wipes, ${shipped.fontKeysAdded} font keys and ${shipped.labels} labels for ${CYCLES} closes (fix: ${fixed.fontKeysAdded}, ${fixed.labels}).`,
    columns: ["As shipped", "With fix", "No close (idle control)"],
    rows: [
      [`labelCache.resetCache() calls (${CYCLES} closes)`, shipped.resetCalls, fixed.resetCalls, 0],
      ["…that wiped the page-wide cache", shipped.wipes, fixed.wipes, 0],
      [`Tick labels re-measured by the long-lived chart (${FRAMES_AFTER} frames after each close)`, shipped.labels, fixed.labels, idleLabels],
      ["Labels re-measured per close", shipped.labels / CYCLES, fixed.labels / CYCLES, idleLabels / CYCLES],
      ["Font keys added to the long-lived chart's wasm context", shipped.fontKeysAdded, fixed.fontKeysAdded, 0],
      ["Font keys it holds afterwards", shipped.fontKeys, fixed.fontKeys, null],
      ["labelCache.getSize() right after each close (min)", Math.min(...shipped.sizeAfterClose), Math.min(...fixed.sizeAfterClose), null],
      ["Time the long-lived chart spent re-measuring labels, ms (all closes)", shipped.measureMs, fixed.measureMs, null],
    ],
    notes: [
      `Renderer: ${P.renderer()}. All counts are hardware-independent; the time row is not, and it is small here (two axes, one font). The idle control is the same number of frames with no createSingle close: the long-lived chart measures nothing then.`,
      "The old SCRTFontKey objects are freed only when that context is disposed, so a page that keeps a dashboard open while users open and close createSingle charts grows by one key per font per close. Whether AquireFont with a new key also rebuilds native font data is decided in C++ and is not visible here." +
        (reloadsBlocked ? ` Note: ${reloadsBlocked} page reload(s) triggered by a WebGL context loss were blocked during the run.` : ""),
    ],
    metrics: { cycles: CYCLES, idleLabels, shipped, fixed, reloadsBlocked },
  });
}
