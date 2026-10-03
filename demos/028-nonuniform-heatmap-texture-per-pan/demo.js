const META = {
  id: "028",
  title: "Non-uniform heatmap rebuilds and re-uploads a screen-sized texture on every pan and zoom frame",
  issue: "issues/028-nonuniform-heatmap-cpu-texture-rebuild-per-pan.md",
  severity: "high",
  claim: "NonUniformHeatmapDrawingProvider rasterises the heatmap in JS at screen resolution and uploads it with SCRTFillTextureAbgr. Its single-slot memo is keyed on pixel offsets, which change on every zoom frame and on every pan frame while the heatmap is clipped by the plot edge, so the texture is rebuilt and re-uploaded on each of those frames, and the GPU texture is re-created whenever a zoom changes the heatmap's on-screen size.",
  method: "<p>A NonUniformHeatmapRenderableSeries with 300 x 300 cells of varying size. Five 60-frame phases: pan while zoomed in (heatmap clipped by the plot edges), pan while the whole heatmap lies inside the plot area, zoom in and out while the heatmap fills the plot, zoom in and out while it is smaller than the plot, and plain redraws with no viewport change (invalidateElement()). The demo counts, per heatmap draw: SCRTFillTextureAbgr calls and texels uploaded by them, SCRTCreateBitmapTexture calls (new GPU textures), and the texture bytes the page uploads (WebGL texImage2D / WebGPU GPUQueue.writeTexture, from the harness).</p><p>The issue's fix needs a new engine shader, so there is no runtime A/B. The phase where the heatmap lies inside the plot area is the control: the same pan, but the memo key does not change, so nothing is rebuilt.</p>",
};

async function demo(P) {
  const { NumericAxis, NumberRange, NonUniformHeatmapRenderableSeries, NonUniformHeatmapDataSeries, HeatmapColorMap, NonUniformHeatmapDrawingProvider } = P.SciChart;
  const W = 300, H = 300, FRAMES = 60;

  const { sciChartSurface, wasmContext: wasm } = await P.createSurface("chart");
  const xAxis = new NumericAxis(wasm), yAxis = new NumericAxis(wasm);
  sciChartSurface.xAxes.add(xAxis);
  sciChartSurface.yAxes.add(yAxis);
  const xCellOffsets = Array.from({ length: W + 1 }, (_, i) => i + 0.4 * Math.sin(i / 7));
  const yCellOffsets = Array.from({ length: H + 1 }, (_, i) => i + 0.4 * Math.sin(i / 5));
  const zValues = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => Math.sin(x / 17) * Math.cos(y / 13)));
  sciChartSurface.renderableSeries.add(new NonUniformHeatmapRenderableSeries(wasm, {
    dataSeries: new NonUniformHeatmapDataSeries(wasm, { zValues, xCellOffsets, yCellOffsets }),
    colorMap: new HeatmapColorMap({ minimum: -1, maximum: 1, gradientStops: [{ offset: 0, color: "#1d2b64" }, { offset: 0.5, color: "#f2f2f2" }, { offset: 1, color: "#e15759" }] }),
  }));
  const setView = (x0, x1, y0, y1) => { xAxis.visibleRange = new NumberRange(x0, x1); yAxis.visibleRange = new NumberRange(y0, y1); };
  setView(60, 180, 30, 270);
  await P.sleep(800);

  P.watch.gpu();
  const proto = NonUniformHeatmapDrawingProvider.prototype;
  const shippedDraw = proto.draw;
  let inDraw = false;
  proto.draw = function () {
    inDraw = true;
    try { return shippedDraw.apply(this, arguments); } finally { inDraw = false; }
  };
  P.hookMethod(proto, "draw", { name: "heatmap draw()", time: true });
  const fillAbgr = wasm.SCRTFillTextureAbgr, createTexture = wasm.SCRTCreateBitmapTexture;
  wasm.SCRTFillTextureAbgr = function (texture, width, height) {
    if (inDraw) P.count("SCRTFillTextureAbgr in heatmap draw", 1, width * height);
    return fillAbgr.apply(this, arguments);
  };
  wasm.SCRTCreateBitmapTexture = function () {
    if (inDraw) P.count("SCRTCreateBitmapTexture in heatmap draw");
    return createTexture.apply(this, arguments);
  };

  const tri = (i, period) => { const k = (i % period) / period; return k < 0.5 ? k * 2 : 2 - k * 2; };
  async function phase(label, perFrame) {
    sciChartSurface.invalidateElement();
    await P.idleFrames(4);
    const r = await P.frames(FRAMES, perFrame);
    const draws = r.total("heatmap draw()");
    const fills = r.total("SCRTFillTextureAbgr in heatmap draw");
    const res = {
      draws,
      fillsPerDraw: draws ? fills / draws : 0,
      texelsPerFill: fills ? r.total("SCRTFillTextureAbgr in heatmap draw", "bytes") / fills : 0,
      createsPerDraw: draws ? r.total("SCRTCreateBitmapTexture in heatmap draw") / draws : 0,
      mbPerFrame: (r.perFrame("gl.texImage2D", "bytes") + r.perFrame("gpu.writeTexture", "bytes")) / 1e6,
      msPerDraw: draws ? r.total("heatmap draw()", "t") / draws : 0,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Panning while zoomed in (heatmap clipped)…");
  setView(60, 180, 30, 270);
  const clipped = await phase("pan, clipped", (i) => { const o = 30 * tri(i, 40); setView(60 + o, 180 + o, 30, 270); });
  const plot = sciChartSurface.seriesViewRect;
  const plotTexels = Math.round(plot.width) * Math.round(plot.height);

  P.status("Panning with the whole heatmap inside the plot area…");
  setView(-100, 400, -60, 360);
  const inside = await phase("pan, inside", (i) => { const o = 30 * tri(i, 40); setView(-100 + o, 400 + o, -60, 360); });

  P.status("Zooming in and out, heatmap filling the plot…");
  setView(60, 240, 30, 270);
  const zoom = await phase("zoom, heatmap fills the plot", (i) => { const h = 60 * (1 + 0.5 * tri(i, 40)); setView(150 - h, 150 + h, 30, 270); });

  P.status("Zooming in and out, heatmap smaller than the plot…");
  setView(-30, 330, -20, 320);
  const zoomOut = await phase("zoom, heatmap inside the plot", (i) => { const h = 180 * (1 + 0.5 * tri(i, 40)); setView(150 - h, 150 + h, -20, 320); });

  P.status("Redrawing with no viewport change…");
  setView(60, 180, 30, 270);
  const idle = await phase("redraw, no viewport change", () => sciChartSurface.invalidateElement());

  proto.draw = shippedDraw;
  wasm.SCRTFillTextureAbgr = fillAbgr;
  wasm.SCRTCreateBitmapTexture = createTexture;

  const rebuilds = (x) => x.draws >= FRAMES * 0.8 && x.fillsPerDraw >= 0.9;
  const reproduced = rebuilds(clipped) && clipped.texelsPerFill >= 0.5 * plotTexels && rebuilds(zoom) && rebuilds(zoomOut);
  const newTextureOnZoom = zoomOut.createsPerDraw >= 0.9;
  const controlHolds = inside.draws >= FRAMES * 0.8 && inside.fillsPerDraw <= 0.1;
  const fmtK = (v) => Math.round(v).toLocaleString("en-US");
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Every pan frame of the zoomed-in heatmap rebuilds and uploads a ${fmtK(clipped.texelsPerFill)}-texel texture (${clipped.mbPerFrame.toFixed(2)} MB per frame; plot area ${fmtK(plotTexels)} px), and so does every zoom frame${newTextureOnZoom ? ", which also creates a new GPU texture when the heatmap's on-screen size changes" : ""}. ` +
        (controlHolds ? `Panning the same heatmap while it lies inside the plot area: ${inside.fillsPerDraw.toFixed(2)} uploads per draw.` : `The control pan (heatmap inside the plot) also rebuilt ${inside.fillsPerDraw.toFixed(2)} times per draw.`)
      : `Expected one screen-sized rebuild per pan frame while clipped and per zoom frame; measured ${clipped.fillsPerDraw.toFixed(2)} (pan, clipped), ${zoom.fillsPerDraw.toFixed(2)} and ${zoomOut.fillsPerDraw.toFixed(2)} (zoom) uploads per draw.`,
    columns: ["Pan, clipped (zoomed in)", "Pan, inside plot (control)", "Zoom, clipped", "Zoom, inside plot", "No viewport change"],
    rows: [
      ["Heatmap draws in the phase", clipped.draws, inside.draws, zoom.draws, zoomOut.draws, idle.draws],
      ["Texture rebuilds + uploads (SCRTFillTextureAbgr) per draw", clipped.fillsPerDraw, inside.fillsPerDraw, zoom.fillsPerDraw, zoomOut.fillsPerDraw, idle.fillsPerDraw],
      ["Texels per upload", clipped.texelsPerFill, inside.texelsPerFill, zoom.texelsPerFill, zoomOut.texelsPerFill, idle.texelsPerFill],
      ["New GPU textures (SCRTCreateBitmapTexture) per draw", clipped.createsPerDraw, inside.createsPerDraw, zoom.createsPerDraw, zoomOut.createsPerDraw, idle.createsPerDraw],
      ["Texture bytes uploaded per frame, MB (whole page)", clipped.mbPerFrame, inside.mbPerFrame, zoom.mbPerFrame, zoomOut.mbPerFrame, idle.mbPerFrame],
      ["Time in heatmap draw() per draw, ms", clipped.msPerDraw, inside.msPerDraw, zoom.msPerDraw, zoomOut.msPerDraw, idle.msPerDraw],
      ["Frame interval p95, ms", clipped.p95, inside.p95, zoom.p95, zoomOut.p95, idle.p95],
    ],
    notes: [
      `The texture is the heatmap's visible area in canvas pixels (plot area here: ${Math.round(plot.width)} x ${Math.round(plot.height)} px), whatever the cell count: ${W} x ${H} cells. Each texel is 4 bytes (ARGB).`,
      "The memo key includes the cell offsets in pixels, which include -heatmapRect.left/top while the heatmap starts above or left of the plot, and the texture size. Zooming always changes the offsets; it creates a new GPU texture only when the heatmap's on-screen size changes (last zoom column), not while the heatmap fills the plot. Counts do not depend on hardware; times do.",
      "On WebGL the bytes row also counts the texImage2D call that allocates each new texture (it carries no pixel data), so the last zoom column reads about twice the uploaded bytes there; WebGPU allocates without an upload.",
    ],
    metrics: { W, H, frames: FRAMES, plotTexels, clipped, inside, zoom, zoomOut, idle, newTextureOnZoom },
  });
}
