const META = {
  id: "074",
  title: "Removing the 3D tooltip/selection modifiers leaves the per-frame selection pass and its GPU readback on",
  issue: "issues/074-hittest-selection-pass-left-enabled-after-detach.md",
  severity: "medium",
  claim: "TooltipModifier3D and SeriesSelectionModifier3D set sciChart3DSurface.isHitTestEnabled = true on attach and never reset it on detach. Every later frame still draws the scene into the selection (ID) buffer and reads it back to the CPU, although nothing reads it any more.",
  method: "<p>3 ScatterRenderableSeries3D x 2,000 sphere markers. The app animates the camera (camera.orbitalYaw += 0.5 per frame) for 60 frames in each of four states: no hit-test modifier ever attached; TooltipModifier3D and SeriesSelectionModifier3D attached; both removed with chartModifiers.remove() (as shipped); and the same after the issue's workaround, sciChart3DSurface.isHitTestEnabled = false.</p><p>Per rendered frame the demo counts GPU work at the browser API: WebGL draw calls, framebuffer binds and gl.readPixels calls and bytes; WebGPU draw calls, render passes, copyTextureToBuffer + mapAsync readbacks and createBuffer calls. The pointer never enters the chart, so no hit test runs: whatever the selection pass costs here is pure overhead.</p>",
};

async function demo(P) {
  const { NumericAxis3D, ScatterRenderableSeries3D, XyzDataSeries3D, SpherePointMarker3D, TooltipModifier3D, SeriesSelectionModifier3D, Vector3 } = P.SciChart;
  const SERIES = 3, POINTS = 2000, FRAMES = 60;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759"];

  const { sciChart3DSurface: scs, wasmContext: wasm } = await P.createSurface3D("chart", { worldDimensions: new Vector3(200, 200, 200) });
  scs.xAxis = new NumericAxis3D(wasm); scs.yAxis = new NumericAxis3D(wasm); scs.zAxis = new NumericAxis3D(wasm);
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let s = 0; s < SERIES; s++) {
    const xs = [], ys = [], zs = [];
    for (let i = 0; i < POINTS; i++) { xs.push(rnd()); ys.push(rnd()); zs.push(rnd()); }
    scs.renderableSeries.add(new ScatterRenderableSeries3D(wasm, {
      dataSeries: new XyzDataSeries3D(wasm, { xValues: xs, yValues: ys, zValues: zs }),
      pointMarker: new SpherePointMarker3D(wasm, { size: 4, fill: COLORS[s] }),
    }));
  }
  await P.sleep(800);

  // GPU counters. The harness covers WebGL draws/readPixels and WebGPU uploads/readback maps;
  // WebGPU draws, passes and texture-to-buffer copies are hooked here.
  P.watch.gpu();
  [window.WebGLRenderingContext, window.WebGL2RenderingContext].forEach((K) => { if (K) P.hookMethod(K.prototype, "bindFramebuffer", { name: "gl.bindFramebuffer" }); });
  if (window.GPURenderPassEncoder) {
    ["draw", "drawIndexed", "drawIndirect", "drawIndexedIndirect"].forEach((m) => P.hookMethod(GPURenderPassEncoder.prototype, m, { name: "gpu draw calls" }));
    P.hookMethod(GPUCommandEncoder.prototype, "beginRenderPass", { name: "gpu render passes" });
    P.hookMethod(GPUCommandEncoder.prototype, "copyTextureToBuffer", {
      name: "gpu copyTextureToBuffer",
      bytes: (a) => { const d = a[1] || {}, s = a[2] || {}; const h = s.height || (Array.isArray(s) ? s[1] : 1) || 1; return (d.bytesPerRow || 0) * h; },
    });
  }
  P.hookMethod(scs.sciChart3DRenderer, "render", { name: "3D render()" });

  const webgpu = P.renderer() === "WebGPU";
  async function run(label) {
    const r = await P.frames(FRAMES, () => { scs.camera.orbitalYaw += 0.5; });
    const n = r.total("3D render()") || 1;
    const res = webgpu ? {
      hitTestEnabled: scs.isHitTestEnabled ? 1 : 0,
      draws: r.total("gpu draw calls") / n,
      passes: r.total("gpu render passes") / n,
      readbacks: r.total("gpu copyTextureToBuffer") / n,
      maps: r.total("gpu.buffer.mapAsync (readback)") / n,
      readBytes: r.total("gpu copyTextureToBuffer", "bytes") / n,
      buffersCreated: r.total("gpu.createBuffer") / n,
      uploadBytes: r.total("gpu.writeBuffer", "bytes") / n,
      readMs: null,
      p95: r.frameP95,
    } : {
      hitTestEnabled: scs.isHitTestEnabled ? 1 : 0,
      draws: r.total("gl.draw calls") / n,
      passes: r.total("gl.bindFramebuffer") / n,
      readbacks: r.total("gl.readPixels") / n,
      maps: null,
      readBytes: r.total("gl.readPixels", "bytes") / n,
      buffersCreated: null,
      uploadBytes: (r.total("gl.bufferSubData", "bytes") + r.total("gl.bufferData", "bytes")) / n,
      readMs: r.total("gl.readPixels", "t") / n,
      p95: r.frameP95,
    };
    res.rendersPerFrame = r.total("3D render()") / FRAMES;
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("No hit-test modifier attached…");
  const never = await run("never attached");
  const tooltip = new TooltipModifier3D(), selection = new SeriesSelectionModifier3D();
  scs.chartModifiers.add(tooltip);
  scs.chartModifiers.add(selection);
  await P.idleFrames(5);
  P.status("TooltipModifier3D + SeriesSelectionModifier3D attached…");
  const attached = await run("attached");
  scs.chartModifiers.remove(tooltip);
  scs.chartModifiers.remove(selection);
  await P.idleFrames(5);
  P.status("Both modifiers removed, as shipped…");
  const detached = await run("removed, as shipped");
  scs.isHitTestEnabled = false;
  await P.idleFrames(5);
  P.status("Both modifiers removed, isHitTestEnabled = false…");
  const workaround = await run("removed, isHitTestEnabled = false");

  const reproduced = detached.hitTestEnabled === 1 && detached.readbacks >= 0.9 && never.readbacks <= 0.05 && workaround.readbacks <= 0.05 &&
    detached.draws > never.draws && Math.abs(detached.draws - attached.draws) <= Math.max(1, attached.draws * 0.1);
  const mb = (b) => (b / 1048576).toFixed(2) + " MB";
  const rows = [
    ["sciChart3DSurface.isHitTestEnabled (1 = on)", never.hitTestEnabled, attached.hitTestEnabled, detached.hitTestEnabled, workaround.hitTestEnabled],
    ["Draw calls per frame", never.draws, attached.draws, detached.draws, workaround.draws],
    [webgpu ? "Render passes per frame" : "Framebuffer binds per frame", never.passes, attached.passes, detached.passes, workaround.passes],
    [webgpu ? "GPU-to-CPU copies per frame (copyTextureToBuffer)" : "GPU-to-CPU readbacks per frame (gl.readPixels)", never.readbacks, attached.readbacks, detached.readbacks, workaround.readbacks],
    ["Bytes read back per frame", never.readBytes, attached.readBytes, detached.readBytes, workaround.readBytes],
  ];
  if (webgpu) {
    rows.push(["Buffer maps per frame (mapAsync)", never.maps, attached.maps, detached.maps, workaround.maps]);
    rows.push(["GPU buffers created per frame", never.buffersCreated, attached.buffersCreated, detached.buffersCreated, workaround.buffersCreated]);
  } else {
    rows.push(["Time in gl.readPixels per frame, ms", never.readMs, attached.readMs, detached.readMs, workaround.readMs]);
  }
  rows.push(["Vertex/uniform upload bytes per frame", never.uploadBytes, attached.uploadBytes, detached.uploadBytes, workaround.uploadBytes]);
  rows.push(["Frame interval p95, ms", never.p95, attached.p95, detached.p95, workaround.p95]);
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `After both modifiers are removed, every frame still runs the selection pass: ${detached.draws.toFixed(0)} draw calls instead of ${never.draws.toFixed(0)} and ${detached.readbacks.toFixed(0)} GPU-to-CPU readback of ${mb(detached.readBytes)} (${P.renderer()}). isHitTestEnabled = false brings it back to ${workaround.draws.toFixed(0)} draws and ${workaround.readbacks.toFixed(0)} readbacks.`
      : `Expected the selection pass to keep running after detach; measured ${detached.readbacks.toFixed(2)} readbacks and ${detached.draws.toFixed(1)} draws per frame after detach (never attached: ${never.readbacks.toFixed(2)} / ${never.draws.toFixed(1)}).`,
    columns: ["Never attached", "Modifiers attached", "Modifiers removed (as shipped)", "Removed + isHitTestEnabled = false"],
    rows,
    notes: [
      "The pointer never enters the chart in any state, so no hit test reads the buffer: the extra pass, the readback and the uploads in the third column are pure overhead for the rest of the surface's life.",
      "Readback size is the full canvas in device pixels (RGBA), so it grows with chart size and devicePixelRatio. Counts and bytes do not depend on hardware; the time and frame-interval rows do.",
    ],
    metrics: { renderer: P.renderer(), never, attached, detached, workaround },
  });
}
