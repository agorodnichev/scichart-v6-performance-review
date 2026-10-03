const META = {
  id: "070",
  title: "LabelProvider setters flush the label caches even when the value does not change",
  issue: "issues/070-label-provider-setters-flush-cache-without-change.md",
  severity: "low",
  claim: "LabelProvider.precision (and numericFormat, prefix, postfix, formatLabel...) always calls invalidateParent, which clears the provider's tick-to-text map and frees its label style. Writing the same value from a hot handler re-formats every visible tick, and for an axis whose label style no other axis shares it also deletes and re-creates every cached label.",
  method: "<p>One chart; the Y axis pans by 0.01 per frame (range 10, about 10 labels) for 90 frames while a visibleRangeChanged handler writes labelProvider.precision = 2, the value it already has. Five runs: Y axis with its own label colour (a style no other axis shares) as shipped, the same with the issue's app-side workaround (write only if the value differs), Y axis with the default style (shared with the X axis), then both styles again with canvas-text labels (useNativeText: false).</p><p>Counted per frame: visibleRangeChanged events, Y-axis formatLabel calls, labelCache.freeStyle calls, labelCache.getLabel lookups, labels created (labelCache.setLabel), labels measured natively (getLabelSizesNative) and label textures rasterized (TextureManager.createTextTexture). New tick values enter the view only about once every 100 frames, so a working cache creates almost nothing.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, NumberRange, EAutoRange, labelCache, TextureManager } = P.SciChart;
  const FRAMES = 90, STEP = 0.01, PRECISION = 2;

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  const xAxis = new NumericAxis(wasmContext, { autoRange: EAutoRange.Never, visibleRange: new NumberRange(0, 100) });
  const yAxis = new NumericAxis(wasmContext, { autoRange: EAutoRange.Never, visibleRange: new NumberRange(0, 10), labelPrecision: PRECISION, labelStyle: { color: "#e15759" } });
  sciChartSurface.xAxes.add(xAxis);
  sciChartSurface.yAxes.add(yAxis);
  const xs = Array.from({ length: 500 }, (_, i) => i / 5);
  sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, {
    dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => 5 + 4 * Math.sin(x / 8)), isSorted: true, containsNaN: false }),
    stroke: "#4e79a7", strokeThickness: 2,
  }));
  await P.sleep(500);
  const lp = yAxis.labelProvider;
  const defaultColor = xAxis.labelStyle.color;

  // Counters
  const f0 = lp.formatLabelProperty; // wrap the backing function directly: the public setter would itself flush
  lp.formatLabelProperty = function () { P.count("Y formatLabel calls"); return f0.apply(this, arguments); };
  P.hookMethod(labelCache, "freeStyle", { name: "labelCache.freeStyle" });
  let inY = false; // true while the Y axis's getLabels runs
  P.hookMethod(labelCache, "getLabel", { name: "labelCache.getLabel", onCall: () => { if (inY) P.count("Y getLabels cache lookups"); } });
  P.hookMethod(labelCache, "setLabel", { name: "labels created (setLabel)" });
  let lpBase = Object.getPrototypeOf(lp); // LabelProviderBase2D is not in the UMD export map
  while (lpBase && !Object.prototype.hasOwnProperty.call(lpBase, "getLabelSizesNative")) lpBase = Object.getPrototypeOf(lpBase);
  P.hookMethod(lpBase, "getLabelSizesNative", { name: "getLabelSizesNative", time: true, onCall: (a) => P.count("labels measured natively", a[0] ? a[0].length : 0) });
  const getLabels0 = lpBase.getLabels;
  lpBase.getLabels = function (ticks) {
    if (this !== lp) return getLabels0.apply(this, arguments);
    P.count("Y labels requested", ticks ? ticks.length : 0);
    inY = true;
    try { return getLabels0.apply(this, arguments); } finally { inY = false; }
  };
  P.hookMethod(TextureManager.prototype, "createTextTexture", { name: "label textures rasterized", time: true });

  let guarded = false;
  yAxis.visibleRangeChanged.subscribe(() => {
    P.count("visibleRangeChanged events");
    if (!guarded || lp.precision !== PRECISION) { P.count("precision writes"); lp.precision = PRECISION; }
  });

  let lo = 0;
  async function run(label) {
    await P.idleFrames(10);
    const r = await P.frames(FRAMES, () => { lo += STEP; yAxis.visibleRange = new NumberRange(lo, lo + 10); });
    const res = {
      events: r.perFrame("visibleRangeChanged events"),
      writes: r.perFrame("precision writes"),
      yLabels: r.perFrame("Y labels requested"),
      formats: r.perFrame("Y formatLabel calls"),
      freeStyle: r.perFrame("labelCache.freeStyle"),
      lookups: r.perFrame("Y getLabels cache lookups"),
      created: r.perFrame("labels created (setLabel)"),
      measured: r.perFrame("labels measured natively"),
      rasterized: r.perFrame("label textures rasterized"),
      ms: r.perFrame("getLabelSizesNative", "t") + r.perFrame("label textures rasterized", "t"),
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Unique Y label style, same-value precision write on every pan step…");
  const unique = await run("unique style, unguarded write");
  guarded = true;
  P.status("Unique Y label style, write only when the value differs…");
  const uniqueGuarded = await run("unique style, guarded write");
  guarded = false;
  yAxis.labelStyle = { color: defaultColor }; // now identical to the X axis style: one shared style id
  P.status("Default (shared) label style, same-value write…");
  const shared = await run("shared style, unguarded write");
  yAxis.labelStyle = { color: "#e15759" };
  lp.useNativeText = false;
  xAxis.labelProvider.useNativeText = false; // canvas-text style ids include the surface id, so switch both axes
  P.status("Unique style, canvas-text labels, same-value write…");
  const canvasText = await run("unique style, canvas text, unguarded write");
  yAxis.labelStyle = { color: defaultColor };
  P.status("Shared style, canvas-text labels, same-value write…");
  const canvasShared = await run("shared style, canvas text, unguarded write");
  lp.useNativeText = true;
  xAxis.labelProvider.useNativeText = true;
  lpBase.getLabels = getLabels0;

  const reproduced = unique.writes >= 0.9 && unique.yLabels > 0 && unique.created >= 0.8 * unique.yLabels &&
    uniqueGuarded.created <= 0.1 * uniqueGuarded.yLabels && uniqueGuarded.writes === 0;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Writing the unchanged precision on each pan step re-creates ${unique.created.toFixed(1)} of the ${unique.yLabels.toFixed(1)} Y labels every frame on an axis with its own label style (canvas text: ${canvasText.rasterized.toFixed(1)} textures per frame); guarding the write: ${uniqueGuarded.created.toFixed(2)}. With the shared default style, native text still re-measures ${shared.measured.toFixed(1)} labels per frame; only canvas text hits the shared cache (${canvasShared.created.toFixed(2)} created).`
      : `Expected a same-value write to re-create the Y labels; measured ${unique.created.toFixed(2)} labels created per frame for ${unique.yLabels.toFixed(1)} labels requested (guarded: ${uniqueGuarded.created.toFixed(2)}).`,
    columns: ["Unique style, as shipped", "Unique style, guarded write", "Shared style, as shipped", "Unique style, canvas text", "Shared style, canvas text"],
    rows: [
      ["visibleRangeChanged events per frame", unique.events, uniqueGuarded.events, shared.events, canvasText.events, canvasShared.events],
      ["precision writes (same value) per frame", unique.writes, uniqueGuarded.writes, shared.writes, canvasText.writes, canvasShared.writes],
      ["Y labels requested per frame (getLabels)", unique.yLabels, uniqueGuarded.yLabels, shared.yLabels, canvasText.yLabels, canvasShared.yLabels],
      ["Y formatLabel calls per frame", unique.formats, uniqueGuarded.formats, shared.formats, canvasText.formats, canvasShared.formats],
      ["labelCache.freeStyle calls per frame", unique.freeStyle, uniqueGuarded.freeStyle, shared.freeStyle, canvasText.freeStyle, canvasShared.freeStyle],
      ["Y-axis labelCache.getLabel lookups inside getLabels, per frame", unique.lookups, uniqueGuarded.lookups, shared.lookups, canvasText.lookups, canvasShared.lookups],
      ["Labels created (labelCache.setLabel) per frame", unique.created, uniqueGuarded.created, shared.created, canvasText.created, canvasShared.created],
      ["Labels measured natively per frame", unique.measured, uniqueGuarded.measured, shared.measured, canvasText.measured, canvasShared.measured],
      ["Label textures rasterized per frame", unique.rasterized, uniqueGuarded.rasterized, shared.rasterized, canvasText.rasterized, canvasShared.rasterized],
      ["Time measuring / rasterizing labels per frame, ms", unique.ms, uniqueGuarded.ms, shared.ms, canvasText.ms, canvasShared.ms],
      ["Frame interval p95, ms", unique.p95, uniqueGuarded.p95, shared.p95, canvasText.p95, canvasShared.p95],
    ],
    notes: [
      "Counts do not depend on hardware; times do. The pan moves 0.01 per frame with ticks 1 apart, so a new tick text enters the view only about once every 100 frames: everything else in the 'as shipped' columns is repeated work.",
      "The library never writes these setters itself after construction, so the cost exists only when app code writes them from a frequent handler. With the default shared style (X and Y axes share one style id) freeStyle leaves the cached labels alone. That protects canvas-text labels, as the issue says, but not the default native text: once the tick-to-text map is cleared, the native branch of getLabels sends every formatted text straight to getLabelSizesNative without a labelCache.getLabel lookup (0 lookups in that column), so every label is measured and stored again. The issue's note that the shared-style case only re-formats holds for canvas text only.",
    ],
    metrics: { unique, uniqueGuarded, shared, canvasText, canvasShared },
  });
}
