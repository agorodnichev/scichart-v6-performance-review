const META = {
  id: "037",
  title: "CanvasTexture.copyTexture makes two embind calls per pixel: 131,072 for one gradient",
  issue: "issues/037-canvastexture-per-pixel-embind-copy.md",
  severity: "medium",
  claim: "CanvasTexture.copyTexture copies the canvas into wasm with two UIntVector.set() embind calls per non-transparent pixel. A 256x256 gradient brush costs 131,072 boundary calls, and the gradient brush of a mountain series is rebuilt on every frame of a fade animation because opacity is part of its cache key.",
  method: "<p>5 FastMountainRenderableSeries with an opaque fillLinearGradient run a 1-second FadeAnimation together. While it runs, the demo counts CanvasTexture.copyTexture calls (gradient brush rebuilds), embind calls to UIntVector.prototype.set (the wasm vector setter), and new canvas elements. It then replaces CanvasTexture.prototype.copyTexture with the issue's fix (swizzle into a HEAPU32 view of the vector's memory, no per-pixel embind call) and runs the same fade again, then restores the original.</p><p>Before any counter is installed, a standalone 256x256 CanvasTexture (a gradient on half of it, the rest transparent) is copied with both versions: the time per copy comes from there, and the two vectors' contents are compared word for word.</p>",
};

async function demo(P) {
  const { NumericAxis, FastMountainRenderableSeries, XyDataSeries, GradientParams, Point, FadeAnimation, CanvasTexture } = P.SciChart;
  const SERIES = 5, POINTS = 500, SIZE = 256;
  const COLORS = [["#4e79a7", "#1d3a5a"], ["#f28e2b", "#6b3a0c"], ["#e15759", "#5e1a1b"], ["#76b7b2", "#24504c"], ["#59a14f", "#1f4519"]];

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext));
  const xs = Array.from({ length: POINTS }, (_, i) => i);
  const series = [];
  for (let s = 0; s < SERIES; s++) {
    const rs = new FastMountainRenderableSeries(wasmContext, {
      dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => 1 + s * 0.5 + 0.4 * Math.sin(x / 40 + s)), isSorted: true, containsNaN: false }),
      stroke: COLORS[s][0], strokeThickness: 2,
      fillLinearGradient: new GradientParams(new Point(0, 0), new Point(0, 1), [{ color: COLORS[s][0], offset: 0 }, { color: COLORS[s][1], offset: 1 }]),
    });
    sciChartSurface.renderableSeries.add(rs);
    series.push(rs);
  }
  await P.sleep(600);

  // The issue's fix: swizzle RGBA bytes into the vectors' wasm memory, no embind call per pixel.
  const shippedCopy = CanvasTexture.prototype.copyTexture;
  const fixedCopy = function () {
    const size = this.width * this.height;
    if (!this.intermediateVector || this.intermediateVector.size() !== size) throw new Error("CanvasTexture: vector size mismatch");
    const imageArr = this.getContext().getImageData(0, 0, this.width, this.height).data;
    const src = new Uint32Array(imageArr.buffer, imageArr.byteOffset, size); // 0xAABBGGRR
    const heap = this.wasmContext.HEAPU32; // taken after the last wasm allocation
    const dstStart = Number(this.intermediateVector.dataPtr(0)) / 4;
    const dst = heap.subarray(dstStart, dstStart + size);
    for (let i = 0; i < size; i++) {
      const p = src[i];
      dst[i] = p >>> 24 ? ((p & 0xff00ff00) | ((p & 0xff) << 16) | ((p >>> 16) & 0xff)) >>> 0 : 0;
    }
    heap.set(dst, Number(this.originalIntermediateVector.dataPtr(0)) / 4);
    this.wasmContext.SCRTFillTextureAbgr(this.tsrTextureCache.value, this.width, this.height, this.intermediateVector);
  };

  // Standalone check before any counter: same output? time per copy?
  P.status("Standalone 256x256 copy: shipped vs fixed…");
  const ct = new CanvasTexture(wasmContext, SIZE, SIZE);
  const paint = () => {
    ct.clear();
    const ctx = ct.getContext();
    const g = ctx.createLinearGradient(0, 0, 0, SIZE);
    g.addColorStop(0, "#4e79a7"); g.addColorStop(0.7, "rgba(242,142,43,0.5)"); g.addColorStop(1, "#e15759");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SIZE / 2, SIZE); // right half stays transparent
  };
  const vectorSum = () => {
    const heap = wasmContext.HEAPU32;
    let h = 2166136261;
    for (const v of [ct.intermediateVector, ct.originalIntermediateVector]) {
      const start = Number(v.dataPtr(0)) / 4;
      for (let i = start; i < start + SIZE * SIZE; i++) { h ^= heap[i]; h = Math.imul(h, 16777619); }
    }
    return h >>> 0;
  };
  const timeCopy = (fn, n) => {
    let ms = 0;
    for (let k = 0; k < n; k++) { paint(); const t = P.now(); fn.call(ct); ms += P.now() - t; }
    return ms / n;
  };
  timeCopy(shippedCopy, 2); timeCopy(fixedCopy, 2); // warm-up
  const copyMsShipped = timeCopy(shippedCopy, 5);
  const sumShipped = vectorSum();
  await P.nextFrame();
  const copyMsFixed = timeCopy(fixedCopy, 5);
  const sumFixed = vectorSum();
  ct.delete();
  const sameOutput = sumShipped === sumFixed;
  P.log(`standalone copy: shipped ${copyMsShipped.toFixed(2)} ms, fixed ${copyMsFixed.toFixed(3)} ms, identical vectors: ${sameOutput}`);

  // Counters
  P.watch.canvas2d();
  P.watchEmbind(wasmContext, ["UIntVector.set"]);
  P.hookMethod(CanvasTexture.prototype, "copyTexture", { name: "CanvasTexture.copyTexture", time: true });

  async function fade(label) {
    let frames = 0;
    const r = await P.during(async () => {
      series.forEach((rs) => rs.runAnimation(new FadeAnimation({ duration: 1000 })));
      await P.nextFrame();
      while (series.some((rs) => rs.isRunningAnimation) && frames < 300) { await P.nextFrame(); frames++; }
      await P.idleFrames(2);
    });
    const copies = r.total("CanvasTexture.copyTexture");
    const res = {
      frames,
      copies,
      copiesPerFrame: copies / Math.max(frames, 1),
      setPerCopy: copies ? r.total("wasm UIntVector.set") / copies : 0,
      setPerFrame: r.total("wasm UIntVector.set") / Math.max(frames, 1),
      canvasesPerFrame: r.total("canvas elements created") / Math.max(frames, 1),
      ms: r.ms,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("FadeAnimation on 5 gradient mountains, library as shipped…");
  const shipped = await fade("fade, as shipped");
  await P.idleFrames(10);
  // Swap in the fix under the same counter name; the counted original is put back afterwards.
  const counted = CanvasTexture.prototype.copyTexture;
  CanvasTexture.prototype.copyTexture = function () { P.count("CanvasTexture.copyTexture"); return fixedCopy.apply(this, arguments); };
  P.status("FadeAnimation on 5 gradient mountains, with the bulk copy…");
  const fixed = await fade("fade, bulk copy");
  CanvasTexture.prototype.copyTexture = counted;

  const pixels = SIZE * SIZE;
  const reproduced = shipped.copiesPerFrame >= SERIES * 0.8 && shipped.setPerCopy >= 2 * pixels * 0.95 && fixed.setPerCopy === 0 && fixed.copies > 0;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `During a fade, ${SERIES} gradient mountains rebuild ${shipped.copiesPerFrame.toFixed(1)} gradient textures per frame, each with ${Math.round(shipped.setPerCopy).toLocaleString("en-US")} UIntVector.set embind calls (${Math.round(shipped.setPerFrame).toLocaleString("en-US")} per frame). The bulk copy makes 0 and is ${(copyMsShipped / Math.max(copyMsFixed, 1e-3)).toFixed(0)}x faster here (${copyMsShipped.toFixed(2)} vs ${copyMsFixed.toFixed(2)} ms per copy), same output: ${sameOutput ? "yes" : "no"}.`
      : `Expected about ${2 * pixels} embind calls per gradient copy and ${SERIES} copies per frame; measured ${Math.round(shipped.setPerCopy)} per copy and ${shipped.copiesPerFrame.toFixed(1)} copies per frame.`,
    columns: ["As shipped", "Bulk HEAPU32 copy (fix)"],
    rows: [
      ["Fade animation frames", shipped.frames, fixed.frames],
      ["Gradient texture rebuilds (copyTexture) per frame", shipped.copiesPerFrame, fixed.copiesPerFrame],
      ["UIntVector.set embind calls per copyTexture", shipped.setPerCopy, fixed.setPerCopy],
      ["UIntVector.set embind calls per frame", shipped.setPerFrame, fixed.setPerFrame],
      ["New canvas elements per frame (one per rebuilt CanvasTexture)", shipped.canvasesPerFrame, fixed.canvasesPerFrame],
      ["Time per 256x256 copyTexture, standalone, no counters, ms", copyMsShipped, copyMsFixed],
      ["Fade wall time with counters installed, ms (1000 ms animation)", shipped.ms, fixed.ms],
      ["Copied vectors identical (standalone check, half-transparent texture)", sameOutput ? "yes" : "no", null],
    ],
    notes: [
      "Counts do not depend on hardware; times do. The embind counter itself slows the shipped run, so the per-copy time comes from the standalone measurement made before any counter was installed.",
      "The rebuild per frame comes from BrushCache: opacity is part of the gradient brush's cache key although the gradient texture never uses it, so each FadeAnimation step builds a new 256x256 CanvasTexture (with its own canvas element and two 65,536-element vectors) per series. That part is out of this issue's scope and is unchanged by the fix.",
    ],
    metrics: { shipped, fixed, copyMsShipped, copyMsFixed, sameOutput, pixels },
  });
}
