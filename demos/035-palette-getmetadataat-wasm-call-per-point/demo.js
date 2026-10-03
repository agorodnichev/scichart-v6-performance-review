const META = {
  id: "035",
  title: "Palette loops make a wasm size() call per point through getMetadataAt, even without metadata",
  issue: "issues/035-palette-loop-wasm-call-per-point-in-getmetadataat.md",
  severity: "medium",
  claim: "The per-point palette loops pass dataSeries.getMetadataAt(index) to the provider. getMetadataAt first runs validateIndex, which calls count() and so xValues.size(), an embind call into wasm, and only then checks whether the series has metadata at all. The loop has already clamped the index, so the call repeats a bounds check once per point on every palette update.",
  method: "<p>A FastColumnRenderableSeries with 100,000 points and a fill palette provider built on DefaultPaletteProvider (its shouldUpdatePalette() returns true, so the palette is recomputed on every redraw). No metadata. Each pass forces 30 redraws (invalidateElement() once per frame), first with the default resampling, then with resampling off. The demo counts, per redraw: palette callbacks, getMetadataAt calls, and SCRTDoubleVector.size calls made inside getMetadataAt (embind calls into wasm). The time in the palette loop (applyStrokeFillPaletting) comes from a separate 30-redraw pass without the size() counter.</p><p>A/B: getMetadataAt is wrapped to return undefined straight away when the series has no metadata (dataSeries.hasMetadata is false), which gives the loop the same values as the issue's fix, and the passes run again.</p>",
};

async function demo(P) {
  const { NumericAxis, NumberRange, XyDataSeries, FastColumnRenderableSeries, DefaultPaletteProvider, EFillPaletteMode, EResamplingMode, ColumnSeriesDrawingProvider } = P.SciChart;
  const N = 100000, FRAMES = 30;
  const HIGHLIGHT = 0xffe15759; // ARGB

  class EveryRedrawPalette extends DefaultPaletteProvider {
    constructor() { super(); this.fillPaletteMode = EFillPaletteMode.SOLID; this.calls = 0; }
    overrideFillArgb(x, y) { this.calls++; return y > 0.6 ? HIGHLIGHT : undefined; }
  }

  const { sciChartSurface, wasmContext: wasm } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasm));
  sciChartSurface.yAxes.add(new NumericAxis(wasm, { visibleRange: new NumberRange(-1.2, 1.2) }));
  const xs = Array.from({ length: N }, (_, i) => i);
  const palette = new EveryRedrawPalette();
  const dataSeries = new XyDataSeries(wasm, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 1500) * 0.8 + Math.sin(x / 61) * 0.2), isSorted: true, containsNaN: false });
  const columns = new FastColumnRenderableSeries(wasm, { dataSeries, fill: "#4e79a7", stroke: "#4e79a7", strokeThickness: 0, paletteProvider: palette });
  sciChartSurface.renderableSeries.add(columns);
  await P.sleep(600);

  // getMetadataAt lives on BaseDataSeries, which is not exported: find it on the prototype chain.
  let baseDs = P.SciChart.XyDataSeries.prototype;
  while (baseDs && !Object.prototype.hasOwnProperty.call(baseDs, "getMetadataAt")) baseDs = Object.getPrototypeOf(baseDs);
  const shippedGetMetadataAt = baseDs.getMetadataAt;
  let inMeta = false, skipWithoutMetadata = false;
  baseDs.getMetadataAt = function () {
    P.count("getMetadataAt calls");
    if (skipWithoutMetadata && !this.hasMetadata) return undefined; // the fix: no metadata, nothing to validate
    inMeta = true;
    try { return shippedGetMetadataAt.apply(this, arguments); } finally { inMeta = false; }
  };
  const baseDp = Object.getPrototypeOf(ColumnSeriesDrawingProvider.prototype);
  P.hookMethod(baseDp, "applyStrokeFillPaletting", { name: "applyStrokeFillPaletting", time: true });
  P.hookMethod(ColumnSeriesDrawingProvider.prototype, "draw", { name: "column draw()" });
  const hookSize = () => P.hookMethod(wasm.SCRTDoubleVector.prototype, "size", {
    name: "SCRTDoubleVector.size (whole page)",
    onCall: () => { if (inMeta) P.count("SCRTDoubleVector.size inside getMetadataAt"); },
  });

  async function redraws(label, withCounter) {
    const unhook = withCounter ? hookSize() : null;
    sciChartSurface.invalidateElement();
    await P.idleFrames(3);
    const calls0 = palette.calls;
    const r = await P.frames(FRAMES, () => sciChartSurface.invalidateElement());
    if (unhook) unhook();
    const draws = r.total("column draw()");
    const res = {
      draws,
      callbacksPerDraw: draws ? (palette.calls - calls0) / draws : 0,
      metaPerDraw: draws ? r.total("getMetadataAt calls") / draws : 0,
      sizeInMetaPerDraw: draws ? r.total("SCRTDoubleVector.size inside getMetadataAt") / draws : 0,
      sizeAllPerDraw: draws ? r.total("SCRTDoubleVector.size (whole page)") / draws : 0,
      paletteMsPerDraw: draws ? r.total("applyStrokeFillPaletting", "t") / draws : 0,
      p95: r.frameP95,
    };
    P.log(`${label}${withCounter ? " (counting)" : " (timing)"}: ${JSON.stringify(res)}`);
    return res;
  }
  async function config(label) {
    skipWithoutMetadata = false;
    const sc = await redraws(label + ", as shipped", true), st = await redraws(label + ", as shipped", false);
    skipWithoutMetadata = true;
    const fc = await redraws(label + ", with fix", true), ft = await redraws(label + ", with fix", false);
    skipWithoutMetadata = false;
    return { shipped: { ...sc, paletteMsPerDraw: st.paletteMsPerDraw, p95: st.p95 }, fixed: { ...fc, paletteMsPerDraw: ft.paletteMsPerDraw, p95: ft.p95 } };
  }

  P.status("Redrawing, default resampling…");
  const resampled = await config("default resampling");
  P.status("Redrawing, resampling off (every point drawn)…");
  columns.resamplingMode = EResamplingMode.None;
  const full = await config("resampling off");
  columns.resamplingMode = EResamplingMode.Auto;
  baseDs.getMetadataAt = shippedGetMetadataAt;

  const rs = resampled.shipped, rf = resampled.fixed, fs = full.shipped, ff = full.fixed;
  const perPoint = (x) => x.draws >= FRAMES * 0.8 && x.callbacksPerDraw > 0 && x.sizeInMetaPerDraw >= 0.99 * x.callbacksPerDraw;
  const reproduced = perPoint(rs) && perPoint(fs) && rf.sizeInMetaPerDraw === 0 && ff.sizeInMetaPerDraw === 0;
  const fmt = (v) => Math.round(v).toLocaleString("en-US");
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Every palette update makes one wasm size() call per point through getMetadataAt on a series with no metadata: ${fmt(rs.sizeInMetaPerDraw)} per redraw with default resampling, ${fmt(fs.sizeInMetaPerDraw)} with every point drawn. Returning early without metadata: 0 (palette loop ${fs.paletteMsPerDraw.toFixed(1)} ms -> ${ff.paletteMsPerDraw.toFixed(1)} ms per redraw at 100,000 points).`
      : `Expected one SCRTDoubleVector.size call per palette point; measured ${fs.sizeInMetaPerDraw.toFixed(0)} per redraw for ${fs.callbacksPerDraw.toFixed(0)} palette callbacks (fix: ${ff.sizeInMetaPerDraw.toFixed(0)}).`,
    columns: ["Resampled, as shipped", "Resampled, fix", "All points, as shipped", "All points, fix"],
    rows: [
      ["Redraws in the pass", rs.draws, rf.draws, fs.draws, ff.draws],
      ["Palette callbacks (points) per redraw", rs.callbacksPerDraw, rf.callbacksPerDraw, fs.callbacksPerDraw, ff.callbacksPerDraw],
      ["getMetadataAt calls per redraw", rs.metaPerDraw, rf.metaPerDraw, fs.metaPerDraw, ff.metaPerDraw],
      ["SCRTDoubleVector.size calls inside getMetadataAt per redraw", rs.sizeInMetaPerDraw, rf.sizeInMetaPerDraw, fs.sizeInMetaPerDraw, ff.sizeInMetaPerDraw],
      ["SCRTDoubleVector.size calls per redraw (whole page)", rs.sizeAllPerDraw, rf.sizeAllPerDraw, fs.sizeAllPerDraw, ff.sizeAllPerDraw],
      ["Time in the palette loop per redraw, ms", rs.paletteMsPerDraw, rf.paletteMsPerDraw, fs.paletteMsPerDraw, ff.paletteMsPerDraw],
      ["Frame interval p95, ms", rs.p95, rf.p95, fs.p95, ff.p95],
    ],
    notes: [
      "The time row includes the provider's own callbacks, which the fix does not change; the difference between the columns is the getMetadataAt overhead. Counts do not depend on hardware; times do.",
      "A FIFO series with metadata also calls xValues.getStartIndex() per point. The fix helps only series without metadata; series with metadata keep the call.",
    ],
    metrics: { N, frames: FRAMES, resampled, full },
  });
}
