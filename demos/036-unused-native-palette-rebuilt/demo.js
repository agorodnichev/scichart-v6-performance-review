const META = {
  id: "036",
  title: "Band and mountain paletting builds a native palette on every update that nothing reads",
  issue: "issues/036-unused-native-palette-rebuilt-per-palette-update.md",
  severity: "medium",
  claim: "With a palette provider, band and mountain series run applyStrokeFillPaletting with usePalette = true, which resets paletteTextureCache and builds a new native SCRTPalette from all paletted colours (2 per point, 4 bytes each) on every palette update. The draw code passes the colours with SetPalettedColors instead, and no code reads paletteTextureCache.value, so the allocation and copy are wasted.",
  method: "<p>A FastMountainRenderableSeries with a cacheable fill palette provider (shouldUpdatePalette() true once, then false; the mountain forces an update on every redraw anyway, issue 005) and a FastBandRenderableSeries with a provider built on DefaultPaletteProvider (updates on every redraw). 50,000 points each, resampling off so every point is drawn. Each pass forces 60 redraws (invalidateElement() once per frame).</p><p>The demo counts, per redraw: SCRTCreatePalette calls and the colours each one copies, native SCRTPalette objects created and deleted (harness ledger), and reads of paletteTextureCache.value (the only way the palette could be used). A/B: PaletteCache.create is replaced by the issue's lazy version (store the colours, build the SCRTPalette on the first read of value) and the redraws run again.</p>",
};

async function demo(P) {
  const { NumericAxis, NumberRange, XyDataSeries, XyyDataSeries, FastMountainRenderableSeries, FastBandRenderableSeries, DefaultPaletteProvider,
    EFillPaletteMode, EResamplingMode, MountainSeriesDrawingProvider } = P.SciChart;
  const N = 50000, FRAMES = 60;
  const HIGHLIGHT = 0xffe15759; // ARGB

  class CachedFillPalette {
    constructor() { this.dirty = true; this.fillPaletteMode = EFillPaletteMode.SOLID; }
    onAttached() {}
    onDetached() {}
    get isRangeIndependant() { return true; }
    shouldUpdatePalette() { const d = this.dirty; this.dirty = false; return d; }
    overrideFillArgb(x, y) { return y > 0.6 ? HIGHLIGHT : undefined; }
  }
  class EveryRedrawPalette extends DefaultPaletteProvider {
    constructor() { super(); this.fillPaletteMode = EFillPaletteMode.SOLID; }
    overrideFillArgb(x, y) { return y < -1.6 ? HIGHLIGHT : undefined; }
  }

  const { sciChartSurface, wasmContext: wasm } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasm));
  sciChartSurface.yAxes.add(new NumericAxis(wasm, { visibleRange: new NumberRange(-2.2, 1.2) }));
  const xs = Array.from({ length: N }, (_, i) => i);
  const ys = xs.map((x) => Math.sin(x / 1200) * 0.8 + Math.sin(x / 61) * 0.2);
  const mountain = new FastMountainRenderableSeries(wasm, {
    dataSeries: new XyDataSeries(wasm, { xValues: xs, yValues: ys, isSorted: true, containsNaN: false }),
    fill: "#4e79a7", stroke: "#2b4c7e", paletteProvider: new CachedFillPalette(), resamplingMode: EResamplingMode.None,
  });
  const band = new FastBandRenderableSeries(wasm, {
    dataSeries: new XyyDataSeries(wasm, { xValues: xs, yValues: ys.map((y) => y - 1.2), y1Values: xs.map(() => -2.1), isSorted: true, containsNaN: false }),
    fill: "#59a14f", fillY1: "#59a14f", stroke: "#3b6e34", strokeY1: "#3b6e34", paletteProvider: new EveryRedrawPalette(), resamplingMode: EResamplingMode.None,
  });
  sciChartSurface.renderableSeries.add(mountain, band);
  await P.sleep(800);

  // Count SCRTCreatePalette calls (PaletteCache calls it with `new`) and the colours each copies.
  const createPalette = wasm.SCRTCreatePalette;
  wasm.SCRTCreatePalette = function (colors) {
    P.count("SCRTCreatePalette calls", 1, colors.size());
    return createPalette.apply(this, arguments);
  };
  // PaletteCache is not exported: take its prototype from a live instance.
  const cacheProto = Object.getPrototypeOf(mountain.drawingProviders[0].palettingState.paletteTextureCache);
  const shippedCreate = cacheProto.create, valueDesc = Object.getOwnPropertyDescriptor(cacheProto, "value");
  let lazy = false;
  Object.defineProperty(cacheProto, "value", {
    configurable: true,
    get() {
      P.count("paletteTextureCache.value reads");
      if (!lazy) return valueDesc.get.call(this);
      if (!this.cachedEntity && this.fillColors) this.cachedEntity = shippedCreate.call(this, this.fillColors); // built on first read
      return this.cachedEntity;
    },
  });
  function createLazily(fillColors) { this.invalidateCache(); this.fillColors = fillColors; } // the issue's setColorsLazy
  P.hookMethod(Object.getPrototypeOf(MountainSeriesDrawingProvider.prototype), "applyStrokeFillPaletting", { name: "applyStrokeFillPaletting", time: true });
  P.hookMethod(MountainSeriesDrawingProvider.prototype, "draw", { name: "mountain draw()" });
  P.hookMethod(P.SciChart.BandSeriesDrawingProvider.prototype, "draw", { name: "band draw()" });

  async function redraws(label) {
    sciChartSurface.invalidateElement();
    await P.idleFrames(3);
    P.native.reset();
    P.native.start();
    const r = await P.frames(FRAMES, () => sciChartSurface.invalidateElement());
    P.native.stop();
    const nat = P.native.snapshot().SCRTPalette || { created: 0, deleted: 0, live: 0 };
    const draws = r.total("mountain draw()") + r.total("band draw()");
    const creates = r.total("SCRTCreatePalette calls");
    const res = {
      seriesDraws: draws,
      createsPerSeriesDraw: draws ? creates / draws : 0,
      coloursPerPalette: creates ? r.total("SCRTCreatePalette calls", "bytes") / creates : 0,
      nativeCreated: nat.created, nativeDeleted: nat.deleted,
      valueReads: r.total("paletteTextureCache.value reads"),
      paletteMsPerFrame: r.perFrame("applyStrokeFillPaletting", "t"),
      p95: r.frameP95,
    };
    res.kbPerPalette = (res.coloursPerPalette * 4) / 1024;
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Redrawing, library as shipped…");
  const shipped = await redraws("as shipped");
  P.status("Redrawing, palette built only when read (fix)…");
  cacheProto.create = createLazily;
  lazy = true;
  const fixed = await redraws("lazy palette");
  cacheProto.create = shippedCreate;
  lazy = false;
  Object.defineProperty(cacheProto, "value", valueDesc);
  wasm.SCRTCreatePalette = createPalette;

  const wasted = shipped.seriesDraws >= FRAMES * 1.6 && shipped.createsPerSeriesDraw >= 0.9 && shipped.valueReads === 0 && shipped.nativeDeleted >= 0.9 * shipped.nativeCreated - 2;
  const fixRemoves = fixed.seriesDraws >= FRAMES * 1.6 && fixed.createsPerSeriesDraw === 0 && fixed.valueReads === 0;
  const reproduced = wasted && fixRemoves;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each series redraw builds a native SCRTPalette copying ${Math.round(shipped.coloursPerPalette).toLocaleString("en-US")} colours (${shipped.kbPerPalette.toFixed(0)} KB) and deletes the previous one; paletteTextureCache.value was read ${shipped.valueReads} times. Built lazily: ${fixed.createsPerSeriesDraw.toFixed(2)} palettes per redraw.`
      : `Expected one unread SCRTPalette per palette update; measured ${shipped.createsPerSeriesDraw.toFixed(2)} SCRTCreatePalette calls per series redraw and ${shipped.valueReads} reads of the palette (lazy: ${fixed.createsPerSeriesDraw.toFixed(2)}).`,
    columns: ["As shipped", "Built on first read (fix)"],
    rows: [
      ["Series redraws (mountain + band)", shipped.seriesDraws, fixed.seriesDraws],
      ["SCRTCreatePalette calls per series redraw", shipped.createsPerSeriesDraw, fixed.createsPerSeriesDraw],
      ["Colours copied per palette", shipped.coloursPerPalette, fixed.coloursPerPalette],
      ["Native copy per palette (colours x 4 bytes), KB", shipped.kbPerPalette, fixed.kbPerPalette],
      ["Native SCRTPalette created / deleted in the pass", `${shipped.nativeCreated} / ${shipped.nativeDeleted}`, `${fixed.nativeCreated} / ${fixed.nativeDeleted}`],
      ["Reads of paletteTextureCache.value", shipped.valueReads, fixed.valueReads],
      ["Time in applyStrokeFillPaletting per frame (both series), ms", shipped.paletteMsPerFrame, fixed.paletteMsPerFrame],
      ["Frame interval p95, ms", shipped.p95, fixed.p95],
    ],
    notes: [
      "Nothing read the palette in either pass, so building it lazily changes nothing on screen. The time row also contains the per-point palette callbacks, which the fix keeps; the issue's two numericHashCode calls per point (feeding the unused hash) are not counted here.",
      "Counts do not depend on hardware; times do. With resampling on, each palette holds 2 colours per resampled point instead of per visible point.",
    ],
    metrics: { N, frames: FRAMES, shipped, fixed },
  });
}
