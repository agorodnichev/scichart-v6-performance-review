const META = {
  id: "019",
  title: "3D autoRange Always rescans every XYZ point for min/max on every frame, even when only the camera moves",
  issue: "issues/019-3d-autorange-always-scans-full-data-every-frame.md",
  severity: "high",
  claim: "XyzDataSeries3D.xRange/yRange/zRange run a full NumberUtil.MinMax over the data on every read and cache nothing, and with EAutoRange.Always the 3D renderer reads them for each axis on every frame. A camera orbit over static data pays three O(N) scans per frame.",
  method: "<p>One ScatterRenderableSeries3D (PixelPointMarker3D) with 500,000 points and three NumericAxis3D with autoRange: EAutoRange.Always. Orbit: the app turns the camera (camera.orbitalYaw += 0.5 per frame) for 60 frames over static data. Streaming: 60 frames with one appendRange of 1,000 points each. Per frame the demo counts wasm NumberUtil.MinMax calls, the bytes they scan (vector size x 8), the time spent in them, series geometry rebuilds (ScatterPointsSceneEntity.updateSeries) and GPU upload bytes.</p><p>A/B: the same runs with the issue's library fix applied at runtime (x/y/zRange cached on XyzDataSeries3D.prototype, cache cleared in notifyDataChanged), and an orbit run with the app-side workaround (EAutoRange.Once). Patches and settings are restored afterwards.</p>",
};

async function demo(P) {
  const { NumericAxis3D, ScatterRenderableSeries3D, XyzDataSeries3D, PixelPointMarker3D, ScatterPointsSceneEntity, EAutoRange, Vector3 } = P.SciChart;
  const N = 500000, FRAMES = 60, BATCH = 1000;

  const { sciChart3DSurface: scs, wasmContext: wasm } = await P.createSurface3D("chart", { worldDimensions: new Vector3(200, 200, 200) });
  for (const k of ["xAxis", "yAxis", "zAxis"]) scs[k] = new NumericAxis3D(wasm, { autoRange: EAutoRange.Always });
  let seed = 13;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const batch = (n) => { const x = new Array(n), y = new Array(n), z = new Array(n); for (let i = 0; i < n; i++) { x[i] = rnd(); y[i] = rnd(); z[i] = rnd(); } return [x, y, z]; };
  const [x0, y0, z0] = batch(N);
  const ds = new XyzDataSeries3D(wasm, { xValues: x0, yValues: y0, zValues: z0 });
  scs.renderableSeries.add(new ScatterRenderableSeries3D(wasm, { dataSeries: ds, pointMarker: new PixelPointMarker3D(wasm, { fill: "#4e79a7" }) }));
  await P.sleep(1000);

  P.watch.gpu();
  P.hookMethod(wasm.NumberUtil, "MinMax", { name: "NumberUtil.MinMax", time: true, bytes: (a) => a[0].size() * 8 });
  P.hookMethod(ScatterPointsSceneEntity.prototype, "updateSeries", { name: "updateSeries()" });
  P.hookMethod(scs.sciChart3DRenderer, "render", { name: "3D render()" });
  // WebGPU uploads rebuilt geometry through new buffers created with mappedAtCreation, which the
  // harness's writeBuffer counter does not see: count their size here.
  if (window.GPUDevice) P.hookMethod(GPUDevice.prototype, "createBuffer", { name: "gpu mapped buffers", bytes: (a) => (a[0] && a[0].mappedAtCreation ? a[0].size : 0) });
  const uploads = (r) => r.total("gl.bufferData", "bytes") + r.total("gl.bufferSubData", "bytes") + r.total("gpu.writeBuffer", "bytes") + r.total("gpu mapped buffers", "bytes");

  async function run(label, mode) {
    const batches = mode === "stream" ? Array.from({ length: FRAMES }, () => batch(BATCH)) : null;
    const r = await P.frames(FRAMES, (i) => {
      if (mode === "orbit") scs.camera.orbitalYaw += 0.5;
      else { const [x, y, z] = batches[i]; ds.appendRange(x, y, z); }
    });
    const n = r.total("3D render()") || 1;
    const res = {
      rendersPerFrame: r.perFrame("3D render()"),
      minMaxPerRender: r.total("NumberUtil.MinMax") / n,
      mbScannedPerRender: r.total("NumberUtil.MinMax", "bytes") / n / 1048576,
      minMaxMsPerRender: r.total("NumberUtil.MinMax", "t") / n,
      rebuildsPerRender: r.total("updateSeries()") / n,
      uploadKBPerRender: uploads(r) / n / 1024,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Orbit over static data, autoRange Always, as shipped…");
  const orbitShipped = await run("orbit, as shipped", "orbit");
  P.status("Streaming 1,000 points per frame, as shipped…");
  const streamShipped = await run("stream, as shipped", "stream");

  // The issue's fix: cache the three ranges, clear them in notifyDataChanged (every mutator calls it).
  const proto = XyzDataSeries3D.prototype;
  const desc = {};
  for (const k of ["xRange", "yRange", "zRange"]) {
    desc[k] = Object.getOwnPropertyDescriptor(proto, k);
    const key = "__cached_" + k;
    Object.defineProperty(proto, k, { configurable: true, get() { if (this[key] === undefined) this[key] = desc[k].get.call(this); return this[key]; } });
  }
  const notifyOwn = Object.prototype.hasOwnProperty.call(proto, "notifyDataChanged");
  const notify = proto.notifyDataChanged;
  proto.notifyDataChanged = function () { this.__cached_xRange = this.__cached_yRange = this.__cached_zRange = undefined; return notify.apply(this, arguments); };
  P.status("Orbit over static data, with cached ranges…");
  const orbitFixed = await run("orbit, cached ranges", "orbit");
  P.status("Streaming 1,000 points per frame, with cached ranges…");
  const streamFixed = await run("stream, cached ranges", "stream");
  for (const k of ["xRange", "yRange", "zRange"]) Object.defineProperty(proto, k, desc[k]);
  if (notifyOwn) proto.notifyDataChanged = notify; else delete proto.notifyDataChanged;
  delete ds.__cached_xRange; delete ds.__cached_yRange; delete ds.__cached_zRange;

  // App-side workaround: EAutoRange.Once (static data, so no manual visibleRange is needed here).
  for (const k of ["xAxis", "yAxis", "zAxis"]) scs[k].autoRange = EAutoRange.Once;
  await P.idleFrames(3);
  P.status("Orbit over static data, autoRange Once…");
  const orbitOnce = await run("orbit, autoRange Once", "orbit");
  for (const k of ["xAxis", "yAxis", "zAxis"]) scs[k].autoRange = EAutoRange.Always;

  const reproduced = orbitShipped.minMaxPerRender >= 2.7 && orbitShipped.rebuildsPerRender <= 0.05 && orbitFixed.minMaxPerRender <= 0.1 && orbitShipped.rendersPerFrame >= 0.8;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each camera-only frame runs ${orbitShipped.minMaxPerRender.toFixed(1)} full MinMax scans (${orbitShipped.mbScannedPerRender.toFixed(1)} MB of ${N.toLocaleString("en-US")} points) with no data change and no rebuild. With cached ranges: ${orbitFixed.minMaxPerRender.toFixed(1)} per orbit frame, and still ${streamFixed.minMaxPerRender.toFixed(1)} per streaming frame, where the data really changed.`
      : `Expected three MinMax scans per camera-only frame with autoRange Always; measured ${orbitShipped.minMaxPerRender.toFixed(2)} (cached ranges: ${orbitFixed.minMaxPerRender.toFixed(2)}).`,
    columns: ["Orbit, as shipped", "Orbit, cached ranges", "Orbit, autoRange Once", "Streaming, as shipped", "Streaming, cached ranges"],
    rows: [
      ["Renders per frame", orbitShipped.rendersPerFrame, orbitFixed.rendersPerFrame, orbitOnce.rendersPerFrame, streamShipped.rendersPerFrame, streamFixed.rendersPerFrame],
      ["NumberUtil.MinMax scans per render", orbitShipped.minMaxPerRender, orbitFixed.minMaxPerRender, orbitOnce.minMaxPerRender, streamShipped.minMaxPerRender, streamFixed.minMaxPerRender],
      ["MB scanned per render", orbitShipped.mbScannedPerRender, orbitFixed.mbScannedPerRender, orbitOnce.mbScannedPerRender, streamShipped.mbScannedPerRender, streamFixed.mbScannedPerRender],
      ["Time in MinMax per render, ms", orbitShipped.minMaxMsPerRender, orbitFixed.minMaxMsPerRender, orbitOnce.minMaxMsPerRender, streamShipped.minMaxMsPerRender, streamFixed.minMaxMsPerRender],
      ["Series geometry rebuilds per render", orbitShipped.rebuildsPerRender, orbitFixed.rebuildsPerRender, orbitOnce.rebuildsPerRender, streamShipped.rebuildsPerRender, streamFixed.rebuildsPerRender],
      ["GPU upload per render, KB", orbitShipped.uploadKBPerRender, orbitFixed.uploadKBPerRender, orbitOnce.uploadKBPerRender, streamShipped.uploadKBPerRender, streamFixed.uploadKBPerRender],
      ["Frame interval p95, ms", orbitShipped.p95, orbitFixed.p95, orbitOnce.p95, streamShipped.p95, streamFixed.p95],
    ],
    notes: [
      "Orbit frames change only the camera: the series is not rebuilt (0 updateSeries), yet each axis still re-reads its range, and each read is a fresh NaN-aware scan in wasm (invisible as JS self time). Streaming frames genuinely need one scan per axis; the cached version keeps exactly those.",
      "The upload row (WebGL bufferData/bufferSubData; WebGPU writeBuffer plus buffers created with mappedAtCreation) confirms that orbit frames send only uniforms to the GPU: the three scans are the only O(N) work in them. Counts and bytes do not depend on hardware; times do.",
    ],
    metrics: { N, orbitShipped, orbitFixed, orbitOnce, streamShipped, streamFixed },
  });
}
