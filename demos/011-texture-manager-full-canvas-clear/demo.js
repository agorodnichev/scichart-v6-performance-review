const META = {
  id: "011",
  title: "TextureManager clears its whole 1920x1080 scratch canvas (8.3 MB) for every label texture",
  issue: "issues/011-texture-manager-clears-full-1920x1080-per-label.md",
  severity: "high",
  claim: "Every label texture that TextureManager rasterizes starts with clearRect over its entire 1920x1080 willReadFrequently (CPU) canvas, about 8.3 MB of pixels, although it then reads back only the label's own small rectangle with getImageData.",
  method: "<p>Left chart: two AxisMarkerAnnotations and one HorizontalLineAnnotation with showLabel on the default native-text axes; one point is appended per frame so the chart redraws for 90 frames. Right chart: canvas-text axis labels (useNativeText: false); the X axis pans by one tick per frame for 60 frames, so one new tick label text needs a texture each frame.</p><p>The demo records every 2D context that a TextureManager draws on (by wrapping TextureManager.prototype methods) and counts, on those scratch canvases only: clearRect calls and the area they clear (bytes = width x height x 4), getImageData calls (one per texture) and the area read back, plus the time spent in both. It then installs a runtime patch with the same idea as the issue's fix: while a TextureManager method runs, a full-canvas clearRect is narrowed to the rectangle that earlier textures read back since the last clear, plus a 16 px margin (nothing is ever drawn outside those rectangles). Both scenarios are repeated with the patch. A checksum of every read-back ImageData shows whether the label pixels change.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, AxisMarkerAnnotation, HorizontalLineAnnotation, ELabelPlacement, NumberRange, EAutoRange, TextureManager } = P.SciChart;
  const FRAMES = 90, PAN_FRAMES = 60, MARGIN = 16;
  const FULL = 1920 * 1080 * 4; // TextureManager DEFAULT_WIDTH x DEFAULT_HEIGHT x RGBA

  // Chart A: axis markers and a labelled line on a chart that redraws every frame.
  const A = await P.createSurface("chartA");
  const ax = new NumericAxis(A.wasmContext, { autoRange: EAutoRange.Never, visibleRange: new NumberRange(0, 1000) });
  const ay = new NumericAxis(A.wasmContext, { autoRange: EAutoRange.Never, visibleRange: new NumberRange(-1.5, 1.5) });
  A.sciChartSurface.xAxes.add(ax);
  A.sciChartSurface.yAxes.add(ay);
  const xs = Array.from({ length: 200 }, (_, i) => i);
  const stream = new XyDataSeries(A.wasmContext, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 30)), isSorted: true, containsNaN: false });
  A.sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(A.wasmContext, { dataSeries: stream, stroke: "#4e79a7", strokeThickness: 2 }));
  A.sciChartSurface.annotations.add(
    new AxisMarkerAnnotation({ y1: 0.8, backgroundColor: "#4e79a7" }),
    new AxisMarkerAnnotation({ y1: -0.6, backgroundColor: "#e15759" }),
    new HorizontalLineAnnotation({ y1: 0.25, stroke: "#59a14f", strokeThickness: 2, showLabel: true, labelPlacement: ELabelPlacement.Axis, axisLabelFill: "#59a14f" }),
  );

  // Chart B: canvas-text axis labels, panned one tick per frame.
  const B = await P.createSurface("chartB");
  const bx = new NumericAxis(B.wasmContext, { useNativeText: false, autoRange: EAutoRange.Never, visibleRange: new NumberRange(0, 10) });
  const by = new NumericAxis(B.wasmContext, { useNativeText: false, autoRange: EAutoRange.Never, visibleRange: new NumberRange(-1.5, 1.5) });
  B.sciChartSurface.xAxes.add(bx);
  B.sciChartSurface.yAxes.add(by);
  const bxs = Array.from({ length: 2000 }, (_, i) => i / 10);
  B.sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(B.wasmContext, {
    dataSeries: new XyDataSeries(B.wasmContext, { xValues: bxs, yValues: bxs.map((x) => Math.sin(x)), isSorted: true, containsNaN: false }),
    stroke: "#f28e2b", strokeThickness: 2,
  }));
  await P.sleep(600);

  // ---- scratch-canvas tracking (local helper: the harness counts every canvas, these are only TextureManager's)
  P.watch.canvas2d();
  const C2D = CanvasRenderingContext2D.prototype;
  const scratch = new WeakSet();
  const dirty = new WeakMap(); // ctx -> furthest extent read back since the last clear
  const acc = { clearMs: 0, readMs: 0, tmMs: 0 };
  let sums = null; // checksums of read-back pixels during the current run
  const checksum = (u8) => {
    const u = new Uint32Array(u8.buffer, u8.byteOffset, u8.byteLength >> 2);
    let h = 2166136261;
    for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16) + ":" + u8.length;
  };
  const clearRect0 = C2D.clearRect, getImageData0 = C2D.getImageData;
  C2D.clearRect = function (x, y, w, h) {
    if (!scratch.has(this)) return clearRect0.apply(this, arguments);
    const t0 = P.now();
    const r = clearRect0.apply(this, arguments);
    acc.clearMs += P.now() - t0;
    P.count("scratch clearRect", 1, Math.abs(w * h) * 4);
    dirty.set(this, { w: 0, h: 0 });
    return r;
  };
  C2D.getImageData = function (x, y, w, h) {
    if (!scratch.has(this)) return getImageData0.apply(this, arguments);
    const t0 = P.now();
    const img = getImageData0.apply(this, arguments);
    acc.readMs += P.now() - t0;
    P.count("scratch getImageData (one per texture)", 1, Math.abs(w * h) * 4);
    const d = dirty.get(this) || { w: 0, h: 0 };
    d.w = Math.max(d.w, x + w); d.h = Math.max(d.h, y + h);
    dirty.set(this, d);
    if (sums) sums.push(checksum(img.data));
    return img;
  };

  // The patch: narrow a full-canvas clear to what earlier textures read back (+ margin).
  let fixOn = false, depth = 0;
  function narrowedClear(x, y, w, h) {
    const cv = this.canvas;
    if (x === 0 && y === 0 && w >= cv.width && h >= cv.height) {
      const d = dirty.get(this) || { w: 0, h: 0 };
      w = d.w ? Math.min(cv.width, Math.ceil(d.w) + MARGIN) : 0;
      h = d.h ? Math.min(cv.height, Math.ceil(d.h) + MARGIN) : 0;
    }
    return C2D.clearRect.call(this, x, y, w, h);
  }
  const TM = TextureManager.prototype;
  const restore = [];
  ["createTextTexture", "createAxisMarkerTexture", "createTextureFromImage", "createFilledRectTexture", "getTextureContext", "createTextureFromCtxBuffer"].forEach((m) => {
    const orig = TM[m];
    TM[m] = function () {
      const ctx = this.ctx;
      if (ctx) scratch.add(ctx);
      const top = depth === 0;
      if (top && fixOn && ctx) ctx.clearRect = narrowedClear;
      const t0 = top ? P.now() : 0;
      depth++;
      try { return orig.apply(this, arguments); } finally {
        depth--;
        if (top) { acc.tmMs += P.now() - t0; if (fixOn && ctx) delete ctx.clearRect; }
      }
    };
    restore.push(() => { TM[m] = orig; });
  });

  async function run(label, frames, perFrame) {
    await P.idleFrames(3);
    sums = [];
    const a0 = { ...acc };
    const r = await P.frames(frames, perFrame);
    const tex = r.total("scratch getImageData (one per texture)");
    const res = {
      texPerFrame: tex / frames,
      clearsPerFrame: r.perFrame("scratch clearRect"),
      clearPerTex: tex ? r.total("scratch clearRect", "bytes") / tex : 0,
      readPerTex: tex ? r.total("scratch getImageData (one per texture)", "bytes") / tex : 0,
      clearMBPerFrame: r.perFrame("scratch clearRect", "bytes") / 1e6,
      clearReadMs: (acc.clearMs - a0.clearMs + acc.readMs - a0.readMs) / frames,
      tmMs: (acc.tmMs - a0.tmMs) / frames,
      p95: r.frameP95,
      sums: new Set(sums),
    };
    sums = null;
    P.log(`${label}: ${JSON.stringify({ ...res, sums: res.sums.size })}`);
    return res;
  }
  let nextX = 200;
  const streamFrame = () => { stream.append(nextX, Math.sin(nextX / 30)); nextX++; };
  const panFrom = (start) => (i) => { bx.visibleRange = new NumberRange(start + i, start + i + 10); };

  P.status("Annotation labels, library as shipped…");
  const annShipped = await run("annotations, as shipped", FRAMES, streamFrame);
  P.status("Canvas-text tick labels, library as shipped…");
  const panShipped = await run("canvas-text pan, as shipped", PAN_FRAMES, panFrom(0));
  fixOn = true;
  P.status("Annotation labels, with the narrowed clear…");
  const annFixed = await run("annotations, narrowed clear", FRAMES, streamFrame);
  P.status("Canvas-text tick labels, with the narrowed clear…");
  const panFixed = await run("canvas-text pan, narrowed clear", PAN_FRAMES, panFrom(5000));
  fixOn = false;
  restore.forEach((f) => f());
  C2D.clearRect = clearRect0; C2D.getImageData = getImageData0;

  const samePixels = annShipped.sums.size > 0 && annShipped.sums.size === annFixed.sums.size && [...annShipped.sums].every((s) => annFixed.sums.has(s));
  const mb = (b) => b / 1e6; // decimal MB, as in the issue
  const reproduced = annShipped.texPerFrame >= 2.5 && annShipped.clearPerTex >= 0.9 * FULL && annShipped.readPerTex <= 0.02 * FULL &&
    annFixed.clearPerTex <= 0.05 * FULL && panShipped.clearPerTex >= 0.9 * FULL;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each label texture clears ${mb(annShipped.clearPerTex).toFixed(1)} MB of scratch canvas to read back ${(annShipped.readPerTex / 1e3).toFixed(1)} KB (${annShipped.texPerFrame.toFixed(1)} textures, ${annShipped.clearMBPerFrame.toFixed(1)} MB cleared per frame with 3 annotation labels). Narrowing the clear: ${(annFixed.clearPerTex / 1e3).toFixed(1)} KB per texture, same pixels: ${samePixels ? "yes" : "no"}.`
      : `Expected about ${mb(FULL).toFixed(1)} MB cleared per texture; measured ${mb(annShipped.clearPerTex).toFixed(2)} MB as shipped (${annShipped.texPerFrame.toFixed(1)} textures per frame) and ${mb(annFixed.clearPerTex).toFixed(2)} MB with the narrowed clear.`,
    columns: ["As shipped", "Clear narrowed to read-back area"],
    rows: [
      ["Annotations: label textures per frame (one getImageData each)", annShipped.texPerFrame, annFixed.texPerFrame],
      ["Annotations: scratch clearRect calls per frame", annShipped.clearsPerFrame, annFixed.clearsPerFrame],
      ["Annotations: bytes cleared per texture", annShipped.clearPerTex, annFixed.clearPerTex],
      ["Annotations: bytes read back per texture", annShipped.readPerTex, annFixed.readPerTex],
      ["Annotations: MB cleared per frame", annShipped.clearMBPerFrame, annFixed.clearMBPerFrame],
      ["Annotations: time in scratch clearRect + getImageData per frame, ms", annShipped.clearReadMs, annFixed.clearReadMs],
      ["Annotations: time inside TextureManager per frame, ms", annShipped.tmMs, annFixed.tmMs],
      ["Annotations: frame interval p95, ms", annShipped.p95, annFixed.p95],
      ["Canvas-text pan: new label textures per frame", panShipped.texPerFrame, panFixed.texPerFrame],
      ["Canvas-text pan: bytes cleared per texture", panShipped.clearPerTex, panFixed.clearPerTex],
      ["Canvas-text pan: bytes read back per texture", panShipped.readPerTex, panFixed.readPerTex],
      ["Canvas-text pan: time inside TextureManager per frame, ms", panShipped.tmMs, panFixed.tmMs],
      ["Annotation label pixels identical with the narrowed clear", samePixels ? "yes" : "no", `${annFixed.sums.size} distinct images`],
    ],
    notes: [
      "Byte counts do not depend on hardware; times do. The scratch canvas uses willReadFrequently, so it is a CPU bitmap: the full clear is a write over 8.3 MB that getImageData has to flush before it reads the small label rectangle.",
      "The patch narrows TextureManager's own full-canvas clearRect calls only while a TextureManager method runs, and is removed afterwards. It is equivalent to the issue's fix (clear the rectangle that is read back) for every texture whose drawing stays inside its read-back rectangle plus 16 px; the checksum row shows the read-back pixels did not change.",
    ],
    metrics: { full: FULL, annShipped: { ...annShipped, sums: annShipped.sums.size }, annFixed: { ...annFixed, sums: annFixed.sums.size }, panShipped: { ...panShipped, sums: panShipped.sums.size }, panFixed: { ...panFixed, sums: panFixed.sums.size }, samePixels },
  });
}
