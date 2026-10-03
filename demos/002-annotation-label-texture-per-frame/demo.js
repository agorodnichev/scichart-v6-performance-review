const META = {
  id: "002",
  title: "Line-annotation labels and axis markers are re-rasterized, read back and uploaded as new textures every frame",
  issue: "issues/002-annotation-label-texture-rasterized-every-frame.md",
  severity: "high",
  claim: "drawLineAnnotation and drawAxisMarkerAnnotation (drawLabel.js) build a fresh label texture on every render: a clearRect over the whole 1920x1080 CPU canvas, measureText and fillText, getImageData, a new wasm texture with a full upload, one draw, then delete. Nothing is cached when the label text and style have not changed.",
  method: "<p>One chart with a streaming line series (one point appended per frame, so the chart redraws every frame), 6 HorizontalLineAnnotations with showLabel: true and 6 AxisMarkerAnnotations, all at fixed y values on a fixed y range, so no label text changes during the run. For 60 frames the demo counts, per frame: AxisRenderer.createAnnotationLabelTexture and createAxisMarker calls (the two drawLabel.js entry points), wasm SCRTCreateBitmapTexture calls, the clearRect / getImageData / fillText calls made while a label texture is built (with the bytes cleared and read back), texture objects created and deleted (embind handles), and GPU texture creations and uploads (WebGL or WebGPU calls). It then patches both AxisRenderer methods with a per-renderer cache keyed by the label's text and style (the fix proposed in the issue, emulated at runtime: the cached texture's delete() is made a no-op while it is cached) and repeats the run. The patch is removed and the cached textures are freed afterwards.</p><p>Overlap: issue 022 covers the same TextureManager pipeline from the AxisRenderer side, including the cursor/modifier axis labels (drawModifiersAxisLabel); this page exercises only the two drawLabel.js paths named by issue 002.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, HorizontalLineAnnotation, AxisMarkerAnnotation, NumberRange, EAutoRange,
    AxisRenderer, TextureManager, ELabelPlacement } = P.SciChart;
  const LINES = 6, MARKERS = 6, FRAMES = 60;
  const LABELS = LINES + MARKERS;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#b07aa1"];

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { visibleRange: new NumberRange(0, 13), autoRange: EAutoRange.Never }));
  const ds = new XyDataSeries(wasmContext, { fifoCapacity: 500, isSorted: true, containsNaN: false });
  for (let x = 0; x < 500; x++) ds.append(x, 6.5 + 5 * Math.sin(x / 40));
  sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries: ds, stroke: "#9aa3b2", strokeThickness: 1 }));
  for (let i = 0; i < LINES; i++) {
    sciChartSurface.annotations.add(new HorizontalLineAnnotation({
      y1: 1 + i * 2, stroke: COLORS[i], strokeThickness: 2, showLabel: true, labelPlacement: ELabelPlacement.Axis, axisLabelFill: COLORS[i],
    }));
  }
  for (let i = 0; i < MARKERS; i++) {
    sciChartSurface.annotations.add(new AxisMarkerAnnotation({ y1: 2 + i * 2, fontSize: 12, backgroundColor: COLORS[i], color: "#ffffff" }));
  }
  await P.sleep(600);

  // --- counters -----------------------------------------------------------------------
  P.watch.gpu();
  P.watchEmbind(wasmContext, ["SCRTCreateBitmapTexture"]);
  // Each entry point gets an outer "requested" counter that delegates to a swappable implementation:
  // the original (counted as "rasterized") as shipped, or a cache in front of it for the fix run.
  let inLabel = false, labelMs = 0;
  const impls = {}, restore = [];
  const install = (name) => {
    const orig = AxisRenderer.prototype[name];
    impls[name] = function () {
      inLabel = true;
      const t0 = P.now();
      try { return orig.apply(this, arguments); } finally {
        inLabel = false;
        labelMs += P.now() - t0;
        P.count(name + " (rasterized)");
      }
    };
    const rasterize = impls[name];
    AxisRenderer.prototype[name] = function () { P.count(name + " (requested)"); return impls[name].apply(this, arguments); };
    restore.push(() => { AxisRenderer.prototype[name] = orig; });
    return rasterize;
  };
  const rasterizeLine = install("createAnnotationLabelTexture");
  const rasterizeMarker = install("createAxisMarker");
  const c2d = CanvasRenderingContext2D.prototype;
  P.hookMethod(c2d, "clearRect", { name: "2d.clearRect (all)", onCall: (a) => { if (inLabel) P.count("clearRect while building a label", 1, Math.abs(a[2] * a[3] * 4)); } });
  P.hookMethod(c2d, "getImageData", { name: "2d.getImageData (all)", onCall: (a) => { if (inLabel) P.count("getImageData while building a label", 1, Math.abs(a[2] * a[3] * 4)); } });
  P.hookMethod(c2d, "fillText", { name: "2d.fillText (all)", onCall: () => { if (inLabel) P.count("fillText while building a label"); } });
  P.hookMethod(c2d, "measureText", { name: "2d.measureText (all)", onCall: () => { if (inLabel) P.count("measureText while building a label"); } });
  P.hookMethod(TextureManager.prototype, "createTextureFromImageData", { name: "TextureManager.createTextureFromImageData" });

  let x = 500;
  const step = () => { x++; ds.append(x, 6.5 + 5 * Math.sin(x / 40)); };
  async function run(label) {
    await P.frames(10, step); // warm-up
    labelMs = 0;
    P.native.reset(); P.native.start();
    const r = await P.frames(FRAMES, step);
    P.native.stop();
    const nat = P.native.snapshot();
    let texCreated = 0, texDeleted = 0;
    Object.keys(nat).forEach((k) => { if (/Texture/i.test(k) && !/Brush|Vertex/i.test(k)) { texCreated += nat[k].created; texDeleted += nat[k].deleted; } });
    const gpuCreates = r.total("gl.createTexture") + r.total("gpu.createTexture");
    const gpuUploads = r.total("gl.texImage2D") + r.total("gl.texSubImage2D") + r.total("gpu.writeTexture");
    const gpuBytes = r.total("gl.texImage2D", "bytes") + r.total("gl.texSubImage2D", "bytes") + r.total("gpu.writeTexture", "bytes");
    const res = {
      requested: r.perFrame("createAnnotationLabelTexture (requested)") + r.perFrame("createAxisMarker (requested)"),
      rasterized: r.perFrame("createAnnotationLabelTexture (rasterized)") + r.perFrame("createAxisMarker (rasterized)"),
      wasmTextures: r.perFrame("wasm SCRTCreateBitmapTexture"),
      clears: r.perFrame("clearRect while building a label"),
      clearMB: r.perFrame("clearRect while building a label", "bytes") / 1048576,
      readbacks: r.perFrame("getImageData while building a label"),
      readbackKB: r.perFrame("getImageData while building a label", "bytes") / 1024,
      fillText: r.perFrame("fillText while building a label"),
      measureText: r.perFrame("measureText while building a label"),
      texCreated: texCreated / FRAMES, texDeleted: texDeleted / FRAMES,
      gpuCreates: gpuCreates / FRAMES, gpuUploads: gpuUploads / FRAMES, gpuKB: gpuBytes / FRAMES / 1024,
      ms: labelMs / FRAMES, p95: r.frameP95,
      nativeClasses: Object.keys(nat).filter((k) => /Texture/i.test(k)).map((k) => `${k} +${nat[k].created}/-${nat[k].deleted}`).join(", "),
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Streaming, library as shipped…");
  const shipped = await run("as shipped");

  // Fix emulated at runtime: one cached texture per (renderer, text, style); delete() is a no-op while cached.
  const cached = [];
  const withCache = (name, rasterize, keyOf) => function () {
    const map = this.__demoLabelCache || (this.__demoLabelCache = new Map());
    const key = name + "|" + keyOf(arguments);
    let entry = map.get(key);
    if (!entry || !entry.bitmapTexture) {
      entry = rasterize.apply(this, arguments);
      if (entry && entry.bitmapTexture) {
        entry.bitmapTexture.delete = function () {}; // own property shadows ClassHandle.delete while cached
        cached.push(entry.bitmapTexture);
      }
      map.set(key, entry);
    }
    return entry;
  };
  const styleKey = (s) => s ? [s.fontFamily, s.fontSize, s.fontStyle, s.fontWeight, s.color, s.padding ? [s.padding.top, s.padding.right, s.padding.bottom, s.padding.left].join(",") : "", s.multilineAlignment, s.alignment].join("|") : "";
  impls.createAnnotationLabelTexture = withCache("line", rasterizeLine, (a) => [a[0], styleKey(a[1]), a[2], a[3], a[4], a[5], a[6]].join("|"));
  impls.createAxisMarker = withCache("marker", rasterizeMarker, (a) => [a[0], a[1], styleKey(a[2]), a[3], a[4]].join("|"));
  P.status("Streaming again with a label-texture cache…");
  const fixed = await run("with cache");
  restore.forEach((f) => f());
  await P.idleFrames(3); // the next renders use the original path again
  cached.forEach((t) => { delete t.delete; try { t.delete(); } catch (e) { /* already freed */ } });

  const rows = [
    ["Label textures requested per frame (createAnnotationLabelTexture + createAxisMarker)", shipped.requested, fixed.requested],
    ["  of which rasterized from scratch", shipped.rasterized, fixed.rasterized],
    ["wasm SCRTCreateBitmapTexture calls per frame", shipped.wasmTextures, fixed.wasmTextures],
    ["Full-canvas clearRect calls while building labels, per frame", shipped.clears, fixed.clears],
    ["  MB cleared per frame (1920x1080 x 4 bytes each)", shipped.clearMB, fixed.clearMB],
    ["getImageData read-backs per frame", shipped.readbacks, fixed.readbacks],
    ["  KB read back per frame", shipped.readbackKB, fixed.readbackKB],
    ["measureText + fillText calls per frame", shipped.measureText + shipped.fillText, fixed.measureText + fixed.fillText],
    ["Texture handles created / deleted per frame (embind)", `${shipped.texCreated.toFixed(1)} / ${shipped.texDeleted.toFixed(1)}`, `${fixed.texCreated.toFixed(1)} / ${fixed.texDeleted.toFixed(1)}`],
    ["GPU texture creations per frame (gl.createTexture / gpu.createTexture)", shipped.gpuCreates, fixed.gpuCreates],
    ["GPU texture uploads per frame (texImage2D / texSubImage2D / writeTexture)", shipped.gpuUploads, fixed.gpuUploads],
    ["Time building label textures per frame, ms", shipped.ms, fixed.ms],
    ["Frame interval p95, ms", shipped.p95, fixed.p95],
  ];
  const reproduced = shipped.wasmTextures >= 0.8 * LABELS && shipped.clears >= 0.8 * LABELS && shipped.readbacks >= 0.8 * LABELS && fixed.wasmTextures <= 0.1 * LABELS;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `With ${LABELS} unchanged labels, every frame rasterizes ${shipped.wasmTextures.toFixed(0)} new label textures: ${shipped.clears.toFixed(0)} clears of the 1920x1080 canvas (${shipped.clearMB.toFixed(0)} MB), ${shipped.readbacks.toFixed(0)} getImageData read-backs and ${shipped.texCreated.toFixed(0)} texture handles created and deleted. With a cache keyed by text and style: ${fixed.wasmTextures.toFixed(1)}.`
      : `Expected about ${LABELS} label textures per frame; measured ${shipped.wasmTextures.toFixed(1)} (with cache ${fixed.wasmTextures.toFixed(1)}).`,
    columns: ["As shipped", "With label cache"],
    rows,
    notes: [
      "Counts do not depend on hardware; times do. The GPU rows count calls made by the engine on this renderer; the engine may batch or defer its own texture uploads, so read those rows as a cross-check of the texture-handle counts, not as an exact one-per-label figure.",
      `Texture classes seen (as shipped): ${shipped.nativeClasses || "none"}.`,
    ],
    metrics: { shipped, fixed, labels: LABELS },
  });
}
