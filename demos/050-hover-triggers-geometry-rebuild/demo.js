const META = {
  id: "050",
  title: "A 3D hover or selection flip rebuilds and re-uploads the whole point cloud, though nothing draws it",
  issue: "issues/050-hover-select-triggers-full-3d-geometry-rebuild.md",
  severity: "medium",
  claim: "Setting isHovered or isSelected on a 3D series forwards the property name to the scene entity, which marks its geometry dirty for any property. The next frame runs updateSeries: an O(N) metadata loop and a full mesh rebuild and upload, although no built-in 3D entity draws hover or selection state. isVisible re-sets with an unchanged value do the same.",
  method: "<p>One ScatterRenderableSeries3D with 100,000 points (EllipsePointMarker3D) in a dense cloud, and SeriesSelectionModifier3D({ enableHover: true }). The pointer alternates every 10 frames between the middle of the cloud and an empty corner (120 frames, 12 hover flips). Then the app toggles series.isSelected 10 times and sets series.isVisible = true (unchanged) 10 times, one change every 3 frames.</p><p>The demo counts hover/selection flips, geometry rebuilds (ScatterPointsSceneEntity.updateSeries), points walked by rebuildPointMetadata and bytes uploaded to the GPU (bufferData/bufferSubData or writeBuffer). A/B: the same steps with the issue's app-side workaround (the series' notifyPropertyChanged no longer forwards HOVERED and IS_SELECTED to the scene entity, but still invalidates) plus the fix's equality guard on isVisible, both installed on the series instance and removed afterwards.</p>",
};

async function demo(P) {
  const { NumericAxis3D, ScatterRenderableSeries3D, XyzDataSeries3D, EllipsePointMarker3D, SeriesSelectionModifier3D, ScatterPointsSceneEntity, Vector3 } = P.SciChart;
  const N = 100000, FRAMES = 120, TOGGLES = 10;

  const { sciChart3DSurface: scs, wasmContext: wasm } = await P.createSurface3D("chart", { worldDimensions: new Vector3(200, 200, 200) });
  scs.xAxis = new NumericAxis3D(wasm); scs.yAxis = new NumericAxis3D(wasm); scs.zAxis = new NumericAxis3D(wasm);
  let seed = 5;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const xs = new Array(N), ys = new Array(N), zs = new Array(N);
  for (let i = 0; i < N; i++) { xs[i] = gauss(); ys[i] = gauss(); zs[i] = gauss(); }
  const rs = new ScatterRenderableSeries3D(wasm, {
    dataSeries: new XyzDataSeries3D(wasm, { xValues: xs, yValues: ys, zValues: zs }),
    pointMarker: new EllipsePointMarker3D(wasm, { size: 3, fill: "#4e79a7" }),
  });
  scs.renderableSeries.add(rs);
  const selection = new SeriesSelectionModifier3D({ enableHover: true });
  scs.chartModifiers.add(selection);
  await P.sleep(1000);

  P.watch.gpu();
  P.hookMethod(ScatterPointsSceneEntity.prototype, "updateSeries", { name: "updateSeries()", time: true });
  P.hookMethod(rs.sceneEntity, "rebuildPointMetadata", { name: "rebuildPointMetadata()", bytes: (a) => a[3] }); // bytes field = points walked
  rs.hovered.subscribe(() => P.count("hover flips"));
  rs.selected.subscribe(() => P.count("selection flips"));
  P.hookMethod(scs.sciChart3DRenderer, "render", { name: "3D render()" });
  // WebGPU uploads rebuilt geometry through new buffers created with mappedAtCreation; count their size too.
  if (window.GPUDevice) P.hookMethod(GPUDevice.prototype, "createBuffer", { name: "gpu mapped buffers", bytes: (a) => (a[0] && a[0].mappedAtCreation ? a[0].size : 0) });
  const uploadBytes = (r) => r.total("gl.bufferData", "bytes") + r.total("gl.bufferSubData", "bytes") + r.total("gpu.writeBuffer", "bytes") + r.total("gpu mapped buffers", "bytes");
  const writeBufferBytes = (r) => r.total("gpu.writeBuffer", "bytes");
  const pointer = P.pointer(scs);

  async function scenario(label) {
    // 1) hover flips from real pointer moves
    pointer.enter(0.12, 0.15);
    await P.idleFrames(5);
    const hover = await P.frames(FRAMES, (i) => {
      const onCloud = Math.floor(i / 10) % 2 === 1;
      pointer.move(onCloud ? 0.5 + 0.002 * (i % 3) : 0.12, onCloud ? 0.5 : 0.15);
    });
    pointer.leave();
    await P.idleFrames(5);
    // 2) app toggles isSelected; 3) app re-sets isVisible to the same value
    const select = await P.frames(TOGGLES * 3, (i) => { if (i % 3 === 0) rs.isSelected = !rs.isSelected; });
    if (rs.isSelected) { rs.isSelected = false; await P.idleFrames(3); }
    const visible = await P.frames(TOGGLES * 3, (i) => { if (i % 3 === 0) rs.isVisible = true; });
    const pack = (r, flips) => ({
      flips,
      rebuilds: r.total("updateSeries()"),
      perFlip: flips ? r.total("updateSeries()") / flips : 0,
      pointsWalked: r.total("rebuildPointMetadata()", "bytes"),
      uploadBytes: uploadBytes(r),
      writeBufferBytes: writeBufferBytes(r),
      rebuildMs: r.total("updateSeries()", "t"),
      renders: r.total("3D render()"),
    });
    const res = { hover: pack(hover, hover.total("hover flips")), select: pack(select, select.total("selection flips")), visible: pack(visible, TOGGLES) };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Hover flips, selection toggles and isVisible re-sets, as shipped…");
  const shipped = await scenario("as shipped");

  // Workaround (issue): do not forward HOVERED / IS_SELECTED to the scene entity; still invalidate.
  // Fix (issue): isVisible setter returns early when the value is unchanged.
  const forward = rs.notifyPropertyChanged;
  rs.notifyPropertyChanged = function (name) {
    if (name === "HOVERED" || name === "IS_SELECTED") {
      if (this.invalidateParentCallback) this.invalidateParentCallback();
      return;
    }
    return forward.call(this, name);
  };
  let owner = Object.getPrototypeOf(rs), desc;
  while (owner && !(desc = Object.getOwnPropertyDescriptor(owner, "isVisible"))) owner = Object.getPrototypeOf(owner);
  Object.defineProperty(rs, "isVisible", {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) { if (desc.get.call(this) === v) return; desc.set.call(this, v); },
  });
  P.status("Same steps with the workaround…");
  const fixed = await scenario("with workaround");
  delete rs.notifyPropertyChanged;
  delete rs.isVisible;

  const s = shipped, f = fixed;
  const reproduced = s.hover.flips >= 6 && s.hover.perFlip >= 0.8 && s.select.perFlip >= 0.8 && f.hover.flips >= 6 && f.hover.perFlip <= 0.1 && f.select.perFlip <= 0.1;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each hover flip rebuilt the ${N.toLocaleString("en-US")}-point series ${s.hover.perFlip.toFixed(2)} times (${s.hover.flips} flips, ${(s.hover.pointsWalked / 1e6).toFixed(1)} M points walked); each isSelected toggle ${s.select.perFlip.toFixed(2)} times; an unchanged isVisible set ${s.visible.perFlip.toFixed(2)} times. With the workaround: ${f.hover.perFlip.toFixed(2)}, ${f.select.perFlip.toFixed(2)} and ${f.visible.perFlip.toFixed(2)}.`
      : `Expected about one full rebuild per hover/selection flip; measured ${s.hover.perFlip.toFixed(2)} per hover flip (${s.hover.flips} flips) and ${s.select.perFlip.toFixed(2)} per selection flip (workaround: ${f.hover.perFlip.toFixed(2)}, ${f.select.perFlip.toFixed(2)}).`,
    columns: ["As shipped", "With workaround"],
    rows: [
      ["Hover flips (pointer cloud <-> corner)", s.hover.flips, f.hover.flips],
      ["  geometry rebuilds (updateSeries)", s.hover.rebuilds, f.hover.rebuilds],
      ["  rebuilds per flip", s.hover.perFlip, f.hover.perFlip],
      ["  points walked by rebuildPointMetadata", s.hover.pointsWalked, f.hover.pointsWalked],
      ["  renders", s.hover.renders, f.hover.renders],
      ["  bytes uploaded to the GPU per render", s.hover.renders ? s.hover.uploadBytes / s.hover.renders : 0, f.hover.renders ? f.hover.uploadBytes / f.hover.renders : 0],
      ["  time in updateSeries, ms (total)", s.hover.rebuildMs, f.hover.rebuildMs],
      ["isSelected toggles by the app", s.select.flips, f.select.flips],
      ["  geometry rebuilds per toggle", s.select.perFlip, f.select.perFlip],
      ["  points walked by rebuildPointMetadata", s.select.pointsWalked, f.select.pointsWalked],
      ["isVisible = true re-sets (value unchanged)", s.visible.flips, f.visible.flips],
      ["  geometry rebuilds per re-set", s.visible.perFlip, f.visible.perFlip],
      ["  renders", s.visible.renders, f.visible.renders],
    ],
    notes: [
      "No data, camera or style changes during the runs: hover, selection and visibility state are the only inputs, and no built-in 3D scene entity reads isHovered or isSelected. The chart still renders once per change in both columns (the workaround keeps the invalidate), so app styling in onHoveredChanged keeps working.",
      P.renderer() === "WebGPU"
        ? "On WebGPU the engine writes the whole point buffer (about 32 bytes per point) on every render, rebuild or not, so the upload row does not change with the workaround here; the rebuild still costs the JS metadata loop and the native transform. (Seen in this demo only; on WebGL the upload happens only on rebuild.) Counts and bytes do not depend on hardware; times do."
        : "On WebGL the point buffer is uploaded only when the geometry is rebuilt, so the upload per render drops to uniforms only with the workaround. Rebuild cost grows with N (JS metadata loop, native transform, upload). Counts and bytes do not depend on hardware; times do.",
    ],
    metrics: { N, shipped: s, fixed: f },
  });
}
