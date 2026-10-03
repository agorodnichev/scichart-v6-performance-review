const META = {
  id: "037",
  title: "CanvasTexture.copyTexture makes two embind calls per pixel: 131,072 for one gradient",
  issue: "issues/037-canvastexture-per-pixel-embind-copy.md",
  severity: "medium",
  claim: "CanvasTexture.copyTexture copies the canvas into wasm with two UIntVector.set() embind calls per non-transparent pixel. A 256x256 gradient brush costs 131,072 boundary calls, and the gradient brush of a mountain series is rebuilt on every frame of a fade animation because opacity is part of its cache key.",
  method: "<p>5 FastMountainRenderableSeries with an opaque fillLinearGradient run a 1-second FadeAnimation together. While it runs, the demo counts chart renders, CanvasTexture.copyTexture calls (gradient brush rebuilds), embind calls to UIntVector.prototype.set (the wasm vector setter) and new canvas elements. It then replaces CanvasTexture.prototype.copyTexture with the issue's fix (swizzle into a HEAPU32 view of the vector's memory, no per-pixel embind call) and runs the same fade again. Both fades are repeated without the embind counter to measure frame intervals, and the original method is restored.</p><p>Before any counter is installed, a standalone 256x256 CanvasTexture (a gradient on half of it, the rest transparent) is copied with both versions: the time per copy comes from there, and the two vectors' contents are compared word for word.</p>",
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
  const unhookSet = P.hookMethod(wasmContext.UIntVector.prototype, "set", { name: "wasm UIntVector.set" });
  P.hookMethod(CanvasTexture.prototype, "copyTexture", { name: "CanvasTexture.copyTexture" });
  P.hookMethod(P.SciChart.SciChartRenderer.prototype, "render", { name: "chart renders" });
  const counted = CanvasTexture.prototype.copyTexture;
  const useFix = (on) => {
    CanvasTexture.prototype.copyTexture = on ? function () { P.count("CanvasTexture.copyTexture"); return fixedCopy.apply(this, arguments); } : counted;
  };

  async function fade(label) {
    const stamps = [];
    const r = await P.during(async () => {
      series.forEach((rs) => rs.runAnimation(new FadeAnimation({ duration: 1000 })));
      stamps.push(await P.nextFrame());
      while (series.some((rs) => rs.isRunningAnimation) && stamps.length < 400) stamps.push(await P.nextFrame());
      await P.idleFrames(2);
    });
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]).sort((a, b) => a - b);
    const renders = Math.max(r.total("chart renders"), 1);
    const copies = r.total("CanvasTexture.copyTexture");
    const res = {
      renders: r.total("chart renders"),
      copies,
      copiesPerRender: copies / renders,
      setPerCopy: copies ? r.total("wasm UIntVector.set") / copies : 0,
      setPerRender: r.total("wasm UIntVector.set") / renders,
      canvasesPerRender: r.total("canvas elements created") / renders,
      maxGap: gaps.length ? gaps[gaps.length - 1] : 0,
      p95Gap: gaps.length ? gaps[Math.floor(gaps.length * 0.95)] : 0,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    await P.idleFrames(10);
    return res;
  }

  P.status("FadeAnimation on 5 gradient mountains, library as shipped (counting)…");
  const shipped = await fade("fade, as shipped, counting");
  useFix(true);
  P.status("FadeAnimation on 5 gradient mountains, with the bulk copy (counting)…");
  const fixed = await fade("fade, bulk copy, counting");
  useFix(false);
  // Same fades without the per-call embind counter, for frame timing.
  unhookSet();
  P.status("FadeAnimation, as shipped, no embind counter (timing)…");
  const shippedT = await fade("fade, as shipped, timing");
  useFix(true);
  P.status("FadeAnimation, bulk copy, no embind counter (timing)…");
  const fixedT = await fade("fade, bulk copy, timing");
  useFix(false);

  const pixels = SIZE * SIZE;
  const reproduced = shipped.copiesPerRender >= SERIES * 0.8 && shipped.setPerCopy >= 2 * pixels * 0.95 && fixed.setPerCopy === 0 && fixed.copies > 0;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `During a fade, ${SERIES} gradient mountains rebuild ${shipped.copiesPerRender.toFixed(1)} gradient textures per render, each with ${Math.round(shipped.setPerCopy).toLocaleString("en-US")} UIntVector.set embind calls (${Math.round(shipped.setPerRender).toLocaleString("en-US")} per render). The bulk copy makes 0 and is ${(copyMsShipped / Math.max(copyMsFixed, 1e-3)).toFixed(0)}x faster here (${copyMsShipped.toFixed(2)} vs ${copyMsFixed.toFixed(2)} ms per copy), with identical output.`
      : `Expected about ${2 * pixels} embind calls per gradient copy and ${SERIES} copies per render; measured ${Math.round(shipped.setPerCopy)} per copy and ${shipped.copiesPerRender.toFixed(1)} copies per render (identical output: ${sameOutput}).`,
    columns: ["As shipped", "Bulk HEAPU32 copy (fix)"],
    rows: [
      ["Gradient texture rebuilds (copyTexture) per render during the fade", shipped.copiesPerRender, fixed.copiesPerRender],
      ["UIntVector.set embind calls per copyTexture", shipped.setPerCopy, fixed.setPerCopy],
      ["UIntVector.set embind calls per render", shipped.setPerRender, fixed.setPerRender],
      ["New canvas elements per render (one per rebuilt CanvasTexture)", shipped.canvasesPerRender, fixed.canvasesPerRender],
      ["Time per 256x256 copyTexture, standalone, no counters, ms", copyMsShipped, copyMsFixed],
      ["Renders during the 1 s fade, no embind counter", shippedT.renders, fixedT.renders],
      ["Longest frame during the fade, no embind counter, ms", shippedT.maxGap, fixedT.maxGap],
      ["Frame interval p95 during the fade, no embind counter, ms", shippedT.p95Gap, fixedT.p95Gap],
      ["Copied vectors identical (standalone check, half-transparent texture)", sameOutput ? "yes" : "no", null],
    ],
    notes: [
      "Counts do not depend on hardware; times do. The embind counter slows the counting runs, so times come from the standalone copy and from a second pair of fades run without it.",
      "The rebuild per render comes from BrushCache: opacity is part of the gradient brush's cache key although the gradient texture never uses it, so each FadeAnimation step builds a new 256x256 CanvasTexture (with its own canvas element and two 65,536-element vectors) per series. That part is outside this issue and is unchanged by the fix.",
    ],
    metrics: { shipped, fixed, shippedT, fixedT, copyMsShipped, copyMsFixed, sameOutput, pixels },
  });
}
