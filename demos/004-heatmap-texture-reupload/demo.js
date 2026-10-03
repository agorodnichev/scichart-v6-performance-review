const META = {
  id: "004",
  title: "Uniform heatmap re-uploads its whole W x H float texture on every redraw",
  issue: "issues/004-heatmap-texture-reuploaded-every-redraw.md",
  severity: "high",
  claim: "UniformHeatmapDrawingProvider.draw() calls SCRTFillTextureFloat32 on every redraw with no dirty check, so panning a static heatmap sends the full W x H x 4-byte texture to the GPU each frame. A contour series sharing the same data series also thrashes the single-slot normalized-vector cache, re-running an O(W x H) JS loop twice per redraw.",
  method: "<p>A 1000 x 1000 UniformHeatmapRenderableSeries with static data. The X axis is panned for 60 frames (a new visibleRange each frame). The demo counts, per frame: heatmap draw() calls, SCRTFillTextureFloat32 calls made inside them, texture bytes the page uploads (WebGL texImage2D / WebGPU GPUQueue.writeTexture, from the harness), and BaseHeatmapDataSeries.recreateNormalizedVector calls.</p><p>A/B: the same pan with the upload gated the way the issue's fix does it: SCRTFillTextureFloat32 runs only when the texture handle, the data series, its changeCount, colorMap.minimum/maximum or fillValuesOutOfRange changed. Then a UniformContoursRenderableSeries is added on the same data series (the cache-thrash case), and finally the contours get their own copy of the data (the app-side workaround from the issue).</p>",
};

async function demo(P) {
  const { NumericAxis, NumberRange, UniformHeatmapRenderableSeries, UniformHeatmapDataSeries, HeatmapColorMap, UniformContoursRenderableSeries,
    UniformHeatmapDrawingProvider, UniformContoursDrawingProvider } = P.SciChart;
  const W = 1000, H = 1000, FRAMES = 60, PAN = 100;

  const { sciChartSurface, wasmContext: wasm } = await P.createSurface("chart");
  const xAxis = new NumericAxis(wasm, { visibleRange: new NumberRange(0, W) });
  sciChartSurface.xAxes.add(xAxis);
  sciChartSurface.yAxes.add(new NumericAxis(wasm, { visibleRange: new NumberRange(0, H) }));
  const zValues = Array.from({ length: H }, (_, y) => {
    const row = new Array(W);
    for (let x = 0; x < W; x++) row[x] = Math.sin(x / 45) * Math.cos(y / 35);
    return row;
  });
  const makeData = () => new UniformHeatmapDataSeries(wasm, { xStart: 0, xStep: 1, yStart: 0, yStep: 1, zValues });
  const heatData = makeData();
  sciChartSurface.renderableSeries.add(new UniformHeatmapRenderableSeries(wasm, {
    dataSeries: heatData,
    colorMap: new HeatmapColorMap({ minimum: -1, maximum: 1, gradientStops: [{ offset: 0, color: "#1d2b64" }, { offset: 0.5, color: "#f2f2f2" }, { offset: 1, color: "#e15759" }] }),
  }));
  await P.sleep(800);

  P.watch.gpu();
  // Normalization (O(W x H) JS loop) lives on BaseHeatmapDataSeries, which is not exported: hook it on the prototype chain.
  let owner = P.SciChart.UniformHeatmapDataSeries.prototype;
  while (owner && !Object.prototype.hasOwnProperty.call(owner, "recreateNormalizedVector")) owner = Object.getPrototypeOf(owner);
  P.hookMethod(owner, "recreateNormalizedVector", { name: "recreateNormalizedVector()", time: true });

  // Attribute SCRTFillTextureFloat32 calls to the provider that makes them, and optionally gate the heatmap upload.
  const heatProto = UniformHeatmapDrawingProvider.prototype, contProto = UniformContoursDrawingProvider.prototype;
  const shippedHeatDraw = heatProto.draw, shippedContDraw = contProto.draw;
  let inHeat = null, inCont = false, gate = false;
  heatProto.draw = function () {
    P.count("heatmap draw()");
    inHeat = this;
    try { return shippedHeatDraw.apply(this, arguments); } finally { inHeat = null; }
  };
  P.hookMethod(heatProto, "draw", { name: "heatmap draw() time", time: true });
  contProto.draw = function () {
    inCont = true;
    try { return shippedContDraw.apply(this, arguments); } finally { inCont = false; }
  };
  const uploaded = new WeakMap();
  const fill = wasm.SCRTFillTextureFloat32;
  wasm.SCRTFillTextureFloat32 = function (texture) {
    if (inHeat) {
      if (gate) {
        // Fix from the issue: upload only when something the texture depends on changed.
        const rs = inHeat.parentSeries, ds = rs.dataSeries, cm = rs.colorMap;
        const key = [texture, ds, ds.changeCount, cm.minimum, cm.maximum, rs.fillValuesOutOfRange];
        const last = uploaded.get(inHeat);
        if (last && key.every((v, i) => v === last[i])) {
          P.count("heatmap uploads skipped");
          return new wasm.TSRVector4(0, 1, 0, 0); // draw() overwrites x..w and deletes it after drawing
        }
        uploaded.set(inHeat, key);
      }
      P.count("SCRTFillTextureFloat32 in heatmap draw");
    } else if (inCont) {
      P.count("SCRTFillTextureFloat32 in contour draw");
    }
    return fill.apply(this, arguments);
  };

  async function pan(label) {
    sciChartSurface.invalidateElement(); // one warm-up redraw outside the measured window (the gate records its first upload here)
    await P.idleFrames(5);
    const r = await P.frames(FRAMES, (i) => {
      const k = (i % 40) / 40, off = PAN * (k < 0.5 ? k * 2 : 2 - k * 2);
      xAxis.visibleRange = new NumberRange(off, off + W);
    });
    const res = {
      draws: r.perFrame("heatmap draw()"),
      heatFills: r.perFrame("SCRTFillTextureFloat32 in heatmap draw"),
      contFills: r.perFrame("SCRTFillTextureFloat32 in contour draw"),
      mb: (r.perFrame("gl.texImage2D", "bytes") + r.perFrame("gl.texSubImage2D", "bytes") + r.perFrame("gpu.writeTexture", "bytes")) / 1e6,
      normalize: r.perFrame("recreateNormalizedVector()"),
      normalizeMs: r.perFrame("recreateNormalizedVector()", "t"),
      heatMs: r.perFrame("heatmap draw() time", "t"),
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Panning the heatmap, library as shipped…");
  const shipped = await pan("heatmap, as shipped");
  P.status("Panning the heatmap, upload gated (fix)…");
  gate = true;
  const fixed = await pan("heatmap, upload gated");
  gate = false;

  P.status("Panning heatmap + contours that share one data series…");
  const contours = new UniformContoursRenderableSeries(wasm, { dataSeries: heatData, zMin: -1, zMax: 1, zStep: 0.25 });
  sciChartSurface.renderableSeries.add(contours);
  const shared = await pan("heatmap + contours on the same data series");
  P.status("Panning heatmap + contours, contours on their own copy of the data…");
  contours.dataSeries = makeData();
  const ownCopy = await pan("heatmap + contours, contours on a copy");

  heatProto.draw = shippedHeatDraw;
  contProto.draw = shippedContDraw;
  wasm.SCRTFillTextureFloat32 = fill;

  const textureMB = (W * H * 4) / 1e6;
  const uploadsEveryRedraw = shipped.draws >= 0.8 && shipped.heatFills >= 0.9 * shipped.draws && shipped.mb >= 0.9 * textureMB * shipped.draws;
  const gateRemovesThem = fixed.draws >= 0.8 && fixed.heatFills <= 0.05 * fixed.draws && fixed.mb <= 0.05 * textureMB;
  const thrash = shared.normalize >= 1.8 * shared.draws && ownCopy.normalize <= 0.1;
  const reproduced = uploadsEveryRedraw && gateRemovesThem;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Panning a static ${W} x ${H} heatmap uploads ${shipped.mb.toFixed(2)} MB of texture per frame (${shipped.heatFills.toFixed(2)} SCRTFillTextureFloat32 calls). With the upload gated on its inputs: ${fixed.mb.toFixed(2)} MB.` +
        (thrash ? ` A contour series on the same data adds ${shared.normalize.toFixed(1)} O(W x H) normalizations per frame (0 with its own data copy).` : "")
      : `Expected one full-texture upload (${textureMB.toFixed(1)} MB) per redraw; measured ${shipped.heatFills.toFixed(2)} uploads and ${shipped.mb.toFixed(2)} MB per frame (gated: ${fixed.mb.toFixed(2)} MB).`,
    columns: ["Heatmap, as shipped", "Heatmap, upload gated (fix)", "+ contours, same data series", "+ contours, own data copy"],
    rows: [
      ["Heatmap draw() calls per frame", shipped.draws, fixed.draws, shared.draws, ownCopy.draws],
      ["SCRTFillTextureFloat32 calls per frame, heatmap", shipped.heatFills, fixed.heatFills, shared.heatFills, ownCopy.heatFills],
      ["SCRTFillTextureFloat32 calls per frame, contours", shipped.contFills, fixed.contFills, shared.contFills, ownCopy.contFills],
      ["Texture bytes uploaded per frame, MB (whole page)", shipped.mb, fixed.mb, shared.mb, ownCopy.mb],
      ["recreateNormalizedVector() calls per frame", shipped.normalize, fixed.normalize, shared.normalize, ownCopy.normalize],
      ["Time in recreateNormalizedVector() per frame, ms", shipped.normalizeMs, fixed.normalizeMs, shared.normalizeMs, ownCopy.normalizeMs],
      ["Time in heatmap draw() per frame, ms", shipped.heatMs, fixed.heatMs, shared.heatMs, ownCopy.heatMs],
      ["Frame interval p95, ms", shipped.p95, fixed.p95, shared.p95, ownCopy.p95],
    ],
    notes: [
      `Texture size: ${W} x ${H} R32F = ${textureMB.toFixed(1)} MB per upload (WebGPU pads each row to 256 bytes). Counts and bytes do not depend on hardware; times do, and they leave out the copy in the GPU process.`,
      "The gate keys on the texture handle, the data series and its changeCount, so a data change, a swapped data series or a recreated texture still uploads. The contour provider has its own ungated upload, so the last two columns keep 2 uploads per frame.",
      thrash ? "Contours normalize with the data z-range and no fillValuesOutOfRange, the heatmap with its colour map and fillValuesOutOfRange = true: the shared single-slot cache misses on both calls every redraw." : "The shared-data cache thrash did not show in this run.",
    ],
    metrics: { W, H, frames: FRAMES, shipped, fixed, shared, ownCopy, textureMB, thrash },
  });
}
