const META = {
  id: "022",
  title: "Axis-marker and modifier axis-label textures are rebuilt and re-uploaded on every render",
  issue: "issues/022-annotation-axis-label-texture-rebuilt-every-frame.md",
  severity: "high",
  claim: "AxisRenderer.createAxisMarker (AxisMarkerAnnotation) and the native modifier axis label (NativeAxisRenderer.drawModifierAxisLabelSpecific, used by a CursorModifier with isSvgOnly: false) rasterize a Canvas 2D texture, read it back, create and upload a new GPU texture and delete it after one draw, on every render, even when the label text has not changed.",
  method: "<p>One chart with fixed axis ranges, two AxisMarkerAnnotations at fixed values and a CursorModifier with isSvgOnly: false whose pointer stays parked in the middle of the plot (two crosshair lines, each with a filled axis label). One point is appended per frame for 90 frames, so the chart redraws every frame while every label text stays the same. (The labelled HorizontalLineAnnotation path is issue 002.)</p><p>Counted per frame: AxisRenderer.createAxisMarker calls, NativeAxisRenderer.drawModifierAxisLabelSpecific calls, TextureManager rasterizations (createAxisMarkerTexture, createFilledRectTexture), calls into wasm SCRTCreateBitmapTexture, and the GPU API calls that follow (WebGL createTexture / texImage2D / deleteTexture, or WebGPU createTexture / writeTexture / destroy). Then a runtime patch with the issue's idea (a small texture cache keyed by text and style) is installed: createAxisMarker and createFilledRectTexture return a clone() of a cached texture handle, so the library's own delete() after the draw only drops the clone. The same 90 frames are measured again and the patch is removed.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, AxisMarkerAnnotation, CursorModifier, NumberRange, EAutoRange, AxisRenderer, NativeAxisRenderer, TextureManager, DpiHelper } = P.SciChart;
  const FRAMES = 90, MARKERS = 2, CURSOR_LABELS = 2;

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Never, visibleRange: new NumberRange(0, 1000) }));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Never, visibleRange: new NumberRange(-1.5, 1.5) }));
  const xs = Array.from({ length: 200 }, (_, i) => i);
  const stream = new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 30)), isSorted: true, containsNaN: false });
  sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries: stream, stroke: "#4e79a7", strokeThickness: 2 }));
  sciChartSurface.annotations.add(
    new AxisMarkerAnnotation({ y1: 0.8, backgroundColor: "#4e79a7" }),
    new AxisMarkerAnnotation({ y1: -0.6, backgroundColor: "#e15759" }),
  );
  sciChartSurface.chartModifiers.add(new CursorModifier({ isSvgOnly: false }));
  await P.sleep(500);
  const pointer = P.pointer(sciChartSurface);
  pointer.enter(0.5, 0.5);
  pointer.move(0.5, 0.5);
  await P.idleFrames(10);

  // Counters
  P.watch.gpu();
  let textureClass = "?";
  P.hookMethod(wasmContext, "SCRTCreateBitmapTexture", { name: "wasm SCRTCreateBitmapTexture", onCall: (a, self, ret) => { if (ret && ret.$$) textureClass = ret.$$.ptrType.registeredClass.name; } });
  // Native texture destructions: an embind delete() that drops the last handle runs the C++ destructor (local helper).
  let delOwner = wasmContext.SCRTDoubleVector.prototype;
  while (delOwner && !Object.prototype.hasOwnProperty.call(delOwner, "delete")) delOwner = Object.getPrototypeOf(delOwner);
  const delete0 = delOwner.delete;
  delOwner.delete = function () {
    const $$ = this.$$;
    if ($$ && $$.ptrType && $$.ptrType.registeredClass.name === textureClass && $$.count && $$.count.value === 1) P.count("native textures destroyed");
    return delete0.call(this);
  };
  const markerTexts = new Set();
  P.hookMethod(AxisRenderer.prototype, "createAxisMarker", { name: "createAxisMarker", onCall: (a) => markerTexts.add(a[1]) });
  P.hookMethod(NativeAxisRenderer.prototype, "drawModifierAxisLabelSpecific", { name: "drawModifierAxisLabelSpecific", time: true });
  P.hookMethod(TextureManager.prototype, "createAxisMarkerTexture", { name: "TextureManager.createAxisMarkerTexture", time: true });
  P.hookMethod(TextureManager.prototype, "createFilledRectTexture", { name: "TextureManager.createFilledRectTexture", time: true });

  let nextX = 200; // appended X values keep increasing across runs (sorted series)
  const appendOne = () => { stream.append(nextX, Math.sin(nextX / 30)); nextX++; };
  async function run(label) {
    const r = await P.frames(FRAMES, appendOne);
    const gpuCreated = r.perFrame("gl.createTexture") + r.perFrame("gpu.createTexture");
    const gpuDeleted = r.perFrame("gl.deleteTexture") + r.perFrame("gpu.texture.destroy");
    const uploadBytes = r.perFrame("gl.texImage2D", "bytes") + r.perFrame("gl.texSubImage2D", "bytes") + r.perFrame("gpu.writeTexture", "bytes");
    const res = {
      markers: r.perFrame("createAxisMarker"),
      modLabels: r.perFrame("drawModifierAxisLabelSpecific"),
      rasterMarker: r.perFrame("TextureManager.createAxisMarkerTexture"),
      rasterRect: r.perFrame("TextureManager.createFilledRectTexture"),
      bitmapTextures: r.perFrame("wasm SCRTCreateBitmapTexture"),
      destroyed: r.perFrame("native textures destroyed"),
      gpuCreated, gpuDeleted, uploadBytes,
      rasterMs: r.perFrame("TextureManager.createAxisMarkerTexture", "t") + r.perFrame("TextureManager.createFilledRectTexture", "t"),
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Redrawing with unchanged labels, library as shipped…");
  const shipped = await run("as shipped");

  // Patch: cache by key, hand out clone() so drawLabel's delete() only drops the clone.
  const cache = new Map();
  const cached = (key, create) => {
    let e = cache.get(key);
    if (!e) {
      e = create();
      if (!e || !e.bitmapTexture) return e;
      cache.set(key, e);
      P.count("patch: cache misses");
    }
    return { bitmapTexture: e.bitmapTexture.clone(), textureWidth: e.textureWidth, textureHeight: e.textureHeight };
  };
  const markerOrig = AxisRenderer.prototype.createAxisMarker;
  const rectOrig = TextureManager.prototype.createFilledRectTexture;
  AxisRenderer.prototype.createAxisMarker = function (axisAlignment, text, textStyle, backgroundColor, opacity) {
    const s = textStyle || {};
    const key = ["m", axisAlignment, text, s.fontStyle, s.fontWeight, s.fontSize, s.fontFamily, s.color, backgroundColor, opacity, DpiHelper.PIXEL_RATIO].join("|");
    return cached(key, () => markerOrig.apply(this, arguments));
  };
  TextureManager.prototype.createFilledRectTexture = function (width, height, backgroundColor, cornerRadius, opacity) {
    const key = ["r", Math.ceil(width), Math.ceil(height), backgroundColor, cornerRadius, opacity, DpiHelper.PIXEL_RATIO].join("|");
    return cached(key, () => rectOrig.apply(this, arguments));
  };
  appendOne(); // one redraw fills the cache before the measured run
  await P.idleFrames(5);
  P.status("Redrawing with unchanged labels, with a label texture cache…");
  const fixed = await run("with texture cache");
  AxisRenderer.prototype.createAxisMarker = markerOrig;
  TextureManager.prototype.createFilledRectTexture = rectOrig;
  await P.idleFrames(3);
  cache.forEach((e) => { try { e.bitmapTexture.delete(); } catch (err) { /* already gone */ } });
  delOwner.delete = delete0;
  P.log(`distinct axis-marker texts drawn: ${markerTexts.size}; cached textures: ${cache.size}; texture class: ${textureClass}`);

  const labels = MARKERS + CURSOR_LABELS;
  const reproduced = shipped.markers >= MARKERS * 0.9 && shipped.rasterRect >= CURSOR_LABELS * 0.9 &&
    shipped.bitmapTextures >= labels * 0.9 && shipped.destroyed >= labels * 0.9 && fixed.bitmapTextures <= 0.1 && markerTexts.size <= MARKERS;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `With ${markerTexts.size} unchanged marker texts and a parked cursor, every render rasterizes ${(shipped.rasterMarker + shipped.rasterRect).toFixed(1)} label textures, creates and uploads ${shipped.gpuCreated.toFixed(1)} new GPU textures and destroys ${shipped.destroyed.toFixed(1)}. With a texture cache: ${fixed.bitmapTextures.toFixed(1)} created, ${fixed.destroyed.toFixed(1)} destroyed.`
      : `Expected about ${labels} label textures per render; measured ${shipped.bitmapTextures.toFixed(1)} SCRTCreateBitmapTexture calls per frame as shipped and ${fixed.bitmapTextures.toFixed(1)} with the cache (marker texts seen: ${markerTexts.size}).`,
    columns: ["As shipped", "With label texture cache"],
    rows: [
      ["AxisRenderer.createAxisMarker calls per frame", shipped.markers, fixed.markers],
      ["NativeAxisRenderer.drawModifierAxisLabelSpecific calls per frame", shipped.modLabels, fixed.modLabels],
      ["Canvas 2D rasterizations per frame: axis marker", shipped.rasterMarker, fixed.rasterMarker],
      ["Canvas 2D rasterizations per frame: modifier label background (createFilledRectTexture)", shipped.rasterRect, fixed.rasterRect],
      ["wasm SCRTCreateBitmapTexture calls per frame", shipped.bitmapTextures, fixed.bitmapTextures],
      [`Native textures (${textureClass}) destroyed per frame`, shipped.destroyed, fixed.destroyed],
      [`GPU textures created per frame (${P.renderer()} createTexture)`, shipped.gpuCreated, fixed.gpuCreated],
      [P.renderer() === "WebGPU" ? "GPU textures destroyed per frame (WebGPU: released by dropping the GPUTexture object, no destroy() call to count)" : "GPU textures deleted per frame (WebGL deleteTexture)", shipped.gpuDeleted, fixed.gpuDeleted],
      [`GPU texture upload bytes per frame (${P.renderer()})`, shipped.uploadBytes, fixed.uploadBytes],
      ["Time in those TextureManager calls per frame, ms", shipped.rasterMs, fixed.rasterMs],
      ["Frame interval p95, ms", shipped.p95, fixed.p95],
      ["Distinct axis-marker texts during the run", markerTexts.size, null],
    ],
    notes: [
      "Counts do not depend on hardware; times do. Label texts never change during the run (fixed ranges, parked pointer), so every texture after the first frame is a repeat.",
      "The cache patch hands the library a clone() of an embind texture handle; the library's delete() after the draw only releases the clone, and the cached texture is deleted when the patch is removed. Upload bytes are counted from the WebGL/WebGPU calls the wasm engine makes, and include any other uploads in the frame (the With-cache column shows the baseline).",
      "On WebGPU the engine frees a texture by dropping its GPUTexture object (emwgpuDelete) without calling destroy(), so the GPU memory of these per-frame textures is reclaimed only when the JS garbage collector runs.",
    ],
    metrics: { shipped, fixed, markerTexts: markerTexts.size, cached: cache.size, textureClass, renderer: P.renderer() },
  });
}
