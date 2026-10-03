const META = {
  id: "048",
  title: "3D axis cube copies all three axis descriptors into wasm every frame, even when unchanged",
  issue: "issues/048-3d-axis-descriptors-remarshalled-to-wasm-every-frame.md",
  severity: "medium",
  claim: "AxisCubeEntity.Update deep-compares each new axis descriptor with the previous one but uses the result only to decide DestroyMeshes(); it then copies all three descriptors (ticks, labels, styles) into the persistent native descriptors anyway, hundreds of wasm calls per frame during a camera orbit where nothing changed.",
  method: "<p>A default 3D surface (three NumericAxis3D, one 100-point scatter). The app turns the camera (camera.orbitalYaw += 0.5 per frame) for 60 frames. While AxisCubeEntity.Update runs, the demo counts every call and property write it makes on the native descriptor classes (SCRTAxisDescriptor, SCRTAxisCubeDescriptor, SCRTTickStyle, SCRTTextStyle, TSRVector4, FloatVector, WStringVector), the native vectors and text styles it allocates (new FloatVector / WStringVector / SCRTTextStyle), the strings it marshals, and whether the three descriptors compared equal to the previous frame (getDescriptorsEqual).</p><p>A/B: the same orbit with the issue's fix, a copy of Update that calls updateScrtAxisDescriptor only for axes whose descriptor changed (patched onto AxisCubeEntity.prototype, removed afterwards). After each orbit the camera returns to its start and the chart canvas is read back (WebGL only): the image after the fixed orbit is compared with the last shipped one, next to the difference between two shipped orbits, to check that the persistent native descriptors still draw the same axes.</p>",
};

async function demo(P) {
  const { NumericAxis3D, ScatterRenderableSeries3D, XyzDataSeries3D, SpherePointMarker3D, AxisCubeEntity, BaseSceneEntity3D, Vector3,
    getDescriptorsEqual, getTextStylesEqual, convert3DPlaneModeForLabels, convert3DPlaneModeForTitles, convertAxisPlaneVisibilityMode, updateTsrVector4 } = P.SciChart;
  const FRAMES = 60;

  const { sciChart3DSurface: scs, wasmContext: wasm } = await P.createSurface3D("chart", { worldDimensions: new Vector3(200, 200, 200) });
  scs.xAxis = new NumericAxis3D(wasm); scs.yAxis = new NumericAxis3D(wasm); scs.zAxis = new NumericAxis3D(wasm);
  let seed = 17;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const xs = [], ys = [], zs = [];
  for (let i = 0; i < 100; i++) { xs.push(rnd()); ys.push(rnd()); zs.push(rnd()); }
  scs.renderableSeries.add(new ScatterRenderableSeries3D(wasm, { dataSeries: new XyzDataSeries3D(wasm, { xValues: xs, yValues: ys, zValues: zs }), pointMarker: new SpherePointMarker3D(wasm, { size: 6, fill: "#4e79a7" }) }));
  await P.sleep(1000);

  // ---- counters, attributed to AxisCubeEntity.Update
  let inUpdate = false;
  const entityProto = AxisCubeEntity.prototype;
  const shippedUpdate = entityProto.Update;
  let currentUpdate = shippedUpdate, updateMs = 0;
  entityProto.Update = function (dt) {
    const d = this.currentRenderPassData && this.currentRenderPassData.sceneDescriptor.axisCubeDescriptor;
    if (d) {
      const unchanged = getDescriptorsEqual(d.xAxisDescriptor, this.lastXDescriptor) && getDescriptorsEqual(d.yAxisDescriptor, this.lastYDescriptor) && getDescriptorsEqual(d.zAxisDescriptor, this.lastZDescriptor);
      P.count(unchanged ? "Update, descriptors unchanged" : "Update, descriptors changed");
    }
    const t0 = P.now();
    inUpdate = true;
    try { return currentUpdate.call(this, dt); } finally { inUpdate = false; updateMs += P.now() - t0; }
  };
  const STRING_PROPS = new Set(["m_strTitle", "m_strFont"]);
  for (const cls of ["SCRTAxisDescriptor", "SCRTAxisCubeDescriptor", "SCRTTickStyle", "SCRTTextStyle", "TSRVector4", "FloatVector", "WStringVector"]) {
    const K = wasm[cls];
    if (!K || !K.prototype) { P.log(`class ${cls} not found`); continue; }
    for (const name of Object.getOwnPropertyNames(K.prototype)) {
      if (name === "constructor" || name === "delete" || name === "isAliasOf" || name === "isDeleted" || name === "clone" || name === "deleteLater") continue;
      const d = Object.getOwnPropertyDescriptor(K.prototype, name);
      if (typeof d.value === "function") {
        P.hookMethod(K.prototype, name, { name: `${cls}.${name}()`, onCall: (a) => { if (inUpdate) { P.count("wasm calls in Update"); if (name === "push_back") P.count("push_back in Update", 1, cls === "WStringVector" ? 1 : 0); } } });
      } else if (d.set) {
        P.hookAccessor(K.prototype, name, { name: `${cls}.${name}`, set: true, get: false, onSet: () => { if (inUpdate) { P.count("wasm calls in Update"); P.count("property writes in Update"); if (STRING_PROPS.has(name)) P.count("strings marshalled in Update"); } } });
      }
    }
  }
  for (const cls of ["FloatVector", "WStringVector", "SCRTTextStyle"]) {
    P.hookConstructor(wasm, cls, { name: `new ${cls}`, onNew: () => { if (inUpdate) P.count("native allocations in Update"); } });
  }
  P.hookMethod(scs.sciChart3DRenderer, "render", { name: "3D render()" });

  // ---- pixel snapshot of the chart canvas at a given camera position
  const canvas = scs.domCanvas2D;
  function snapshot() {
    return P.quiet(() => {
      try {
        const c = document.createElement("canvas");
        c.width = canvas.width; c.height = canvas.height;
        const g = c.getContext("2d");
        g.drawImage(canvas, 0, 0);
        return g.getImageData(0, 0, c.width, c.height).data;
      } catch (e) { return null; }
    });
  }
  const diffPixels = (a, b) => { if (!a || !b || a.length !== b.length) return null; let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++; return n; };
  const nonEmpty = (a) => { if (!a) return 0; let n = 0; for (let i = 3; i < a.length; i += 4) if (a[i] !== 0) n++; return n; };
  const yaw0 = scs.camera.orbitalYaw;
  async function at(yaw) { scs.camera.orbitalYaw = yaw; await P.idleFrames(6); return snapshot(); }

  async function orbit(label) {
    updateMs = 0;
    const r = await P.frames(FRAMES, () => { scs.camera.orbitalYaw += 0.5; });
    const n = r.total("3D render()") || 1;
    const res = {
      rendersPerFrame: r.perFrame("3D render()"),
      updatesPerRender: (r.total("Update, descriptors unchanged") + r.total("Update, descriptors changed")) / n,
      unchangedPerRender: r.total("Update, descriptors unchanged") / n,
      wasmCalls: r.total("wasm calls in Update") / n,
      propertyWrites: r.total("property writes in Update") / n,
      pushBacks: r.total("push_back in Update") / n,
      labelsMarshalled: r.total("push_back in Update", "bytes") / n,
      stringsMarshalled: r.total("strings marshalled in Update") / n,
      allocations: r.total("native allocations in Update") / n,
      updateMs: updateMs / n,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Camera orbit, library as shipped…");
  const shipped = await orbit("orbit, as shipped");
  const imgA = await at(yaw0); // image at the starting camera after a shipped orbit
  P.status("Second shipped orbit (image noise baseline)…");
  await orbit("orbit 2, as shipped");
  const refShipped = await at(yaw0);
  const noise = diffPixels(imgA, refShipped);

  // ---- the issue's fix: push only the axes whose descriptor changed (copy of Update otherwise unchanged)
  const updateScrtLineStyle = (lineStyle, s) => { s.m_fStrokeThickness = lineStyle.strokeThickness; s.m_fStart = lineStyle.start; s.m_fEnd = lineStyle.end; updateTsrVector4(lineStyle.stroke, s.GetStrokeColorPtr()); };
  const updateScrtTextStyle = (st, s) => { s.m_fSize = st.fontSize; s.m_strFont = st.fontFamily; s.m_uiARGBColor = st.foreground; s.m_fDpiScaling = st.dpiScaling; s.m_MultilineAlignment = st.multilineAlignment; s.m_fMultilineSpacing = st.multilineSpacing; return s; };
  const updateScrtAxisDescriptor = (w, s, a) => {
    s.m_strTitle = a.axisTitle != null ? a.axisTitle : ""; s.m_fRangeSize = a.axisSize; s.m_fTitleOffset = a.titleOffset; s.m_fLabelsOffset = a.tickLabelsOffset;
    s.m_bBandsEnabled = a.drawBands; s.m_bLabelsEnabled = a.drawLabels; s.m_bMajorLinesEnabled = a.drawMajorGridlines; s.m_bMajorTicksEnabled = a.drawMajorTicks;
    s.m_bMinorLinesEnabled = a.drawMinorGridlines; s.m_bMinorTicksEnabled = a.drawMinorTicks; s.m_fBorderThickness = a.borderThickness;
    s.m_eLabelsRotationMode = a.labelOrientationMode; s.m_fLabelSpacing = a.labelSpacing; s.m_eTitleRotationMode = a.titleOrientationMode; s.m_bBackgroundEnabled = true;
    updateTsrVector4(a.borderColor, s.GetBorderColorPtr()); updateTsrVector4(a.backgroundColor, s.GetBackgroundColorPtr()); updateTsrVector4(a.bandColor, s.GetBandColorPtr());
    updateScrtLineStyle(a.majorLineStyle, s.GetMajorLineStylePtr()); updateScrtLineStyle(a.minorLineStyle, s.GetMinorLineStylePtr());
    const ts = new w.SCRTTextStyle();
    updateScrtTextStyle(a.labelStyle, ts); s.SetLabelTextStyle(ts); updateScrtTextStyle(a.titleStyle, ts); s.SetTitleTextStyle(ts); ts.delete();
    updateScrtLineStyle(a.majorTickStyle, s.GetMajorTickStylePtr()); updateScrtLineStyle(a.minorTickStyle, s.GetMinorTickStylePtr());
    const majors = new w.FloatVector(); a.majorCoordinates.forEach((v) => majors.push_back(v)); s.SetMajors(majors); majors.delete();
    const minors = new w.FloatVector(); a.minorCoordinates.forEach((v) => minors.push_back(v)); s.SetMinors(minors); minors.delete();
    const labels = new w.WStringVector(); a.tickLabels.forEach((v) => labels.push_back(v)); s.SetMajorLabels(labels); labels.delete();
  };
  const fixedUpdate = function (deltaTime) {
    if (!this.currentRenderPassData) return;
    const ent = this.nativeEntity, cube = ent.GetDescriptorPtr(), s = this.sciChart3DSurface, w = this.webAssemblyContext;
    cube.m_bIsZxPlaneVisible = s.isZXPlaneVisible; cube.m_bIsXyPlaneVisible = s.isXYPlaneVisible; cube.m_bIsZyPlaneVisible = s.isZYPlaneVisible;
    cube.m_eXyPlaneDrawLabelsMode = convert3DPlaneModeForLabels(s.xyAxisPlane.drawLabelsMode, w);
    cube.m_eZxPlaneDrawLabelsMode = convert3DPlaneModeForLabels(s.zxAxisPlane.drawLabelsMode, w);
    cube.m_eZyPlaneDrawLabelsMode = convert3DPlaneModeForLabels(s.zyAxisPlane.drawLabelsMode, w);
    cube.m_eXyPlaneDrawTitlesMode = convert3DPlaneModeForTitles(s.xyAxisPlane.drawTitlesMode, w);
    cube.m_eZxPlaneDrawTitlesMode = convert3DPlaneModeForTitles(s.zxAxisPlane.drawTitlesMode, w);
    cube.m_eZyPlaneDrawTitlesMode = convert3DPlaneModeForTitles(s.zyAxisPlane.drawTitlesMode, w);
    cube.m_eXyPlaneVisibilityMode = convertAxisPlaneVisibilityMode(s.xyAxisPlane.visibilityMode, w);
    cube.m_eZxPlaneVisibilityMode = convertAxisPlaneVisibilityMode(s.zxAxisPlane.visibilityMode, w);
    cube.m_eZyPlaneVisibilityMode = convertAxisPlaneVisibilityMode(s.zyAxisPlane.visibilityMode, w);
    const { xAxisDescriptor, yAxisDescriptor, zAxisDescriptor } = this.currentRenderPassData.sceneDescriptor.axisCubeDescriptor;
    const xChanged = !getDescriptorsEqual(xAxisDescriptor, this.lastXDescriptor);
    const yChanged = !getDescriptorsEqual(yAxisDescriptor, this.lastYDescriptor);
    const zChanged = !getDescriptorsEqual(zAxisDescriptor, this.lastZDescriptor);
    if (xChanged || yChanged || zChanged) ent.DestroyMeshes();
    this.lastXDescriptor = xAxisDescriptor; this.lastYDescriptor = yAxisDescriptor; this.lastZDescriptor = zAxisDescriptor;
    if (xChanged) updateScrtAxisDescriptor(w, cube.GetXAxisDescPtr(), xAxisDescriptor);
    if (yChanged) updateScrtAxisDescriptor(w, cube.GetYAxisDescPtr(), yAxisDescriptor);
    if (zChanged) updateScrtAxisDescriptor(w, cube.GetZAxisDescPtr(), zAxisDescriptor);
    cube.m_bIsCameraChange = false;
    BaseSceneEntity3D.prototype.Update.call(this, deltaTime);
    if (!s.isAxisCubeRendered) { s.setIsAxisCubeRendered(); setTimeout(() => s.invalidateElement(), 0); }
  };
  currentUpdate = fixedUpdate;
  P.status("Camera orbit with the per-axis push…");
  const fixed = await orbit("orbit, push only changed axes");
  const fixedImage = await at(yaw0);
  currentUpdate = shippedUpdate;
  entityProto.Update = shippedUpdate;

  const drawn = nonEmpty(refShipped), drawnFixed = nonEmpty(fixedImage);
  const readable = drawn > 0; // a WebGPU canvas cannot be read back with drawImage, so it shows as empty
  const fixDiff = readable ? diffPixels(refShipped, fixedImage) : null;
  const sameImage = readable && fixDiff <= Math.max(20, drawn * 0.01, noise * 1.5);
  const spacingBug = getTextStylesEqual({ dpiScaling: 1, fontFamily: "Arial", fontSize: 12, foreground: 0, multilineAlignment: 0, multilineSpacing: 1 },
    { dpiScaling: 1, fontFamily: "Arial", fontSize: 12, foreground: 0, multilineAlignment: 0, multilineSpacing: 2 });

  const reproduced = shipped.unchangedPerRender >= 0.9 && shipped.wasmCalls >= 100 && fixed.wasmCalls <= shipped.wasmCalls * 0.25 && shipped.allocations >= 9 && fixed.allocations <= 0.1;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `During a camera orbit all three axis descriptors compare equal in ${(shipped.unchangedPerRender * 100).toFixed(0)}% of frames, yet each frame makes ${shipped.wasmCalls.toFixed(0)} wasm calls (${shipped.pushBacks.toFixed(0)} push_back, ${shipped.labelsMarshalled.toFixed(0)} label strings) and ${shipped.allocations.toFixed(0)} native allocations to copy them again. Pushing only changed axes: ${fixed.wasmCalls.toFixed(0)} calls and ${fixed.allocations.toFixed(0)} allocations per frame${!readable ? "" : sameImage ? ", with the same image" : ", but the image changed more than between shipped renders"}.`
      : `Expected hundreds of redundant descriptor calls per unchanged frame; measured ${shipped.wasmCalls.toFixed(0)} (fix: ${fixed.wasmCalls.toFixed(0)}), unchanged share ${shipped.unchangedPerRender.toFixed(2)}.`,
    columns: ["Orbit, as shipped", "Orbit, push only changed axes"],
    rows: [
      ["Renders per frame", shipped.rendersPerFrame, fixed.rendersPerFrame],
      ["AxisCubeEntity.Update calls per render", shipped.updatesPerRender, fixed.updatesPerRender],
      ["  with all 3 descriptors equal to the previous frame", shipped.unchangedPerRender, fixed.unchangedPerRender],
      ["wasm calls and property writes in Update per render", shipped.wasmCalls, fixed.wasmCalls],
      ["  property writes", shipped.propertyWrites, fixed.propertyWrites],
      ["  push_back calls (ticks and labels)", shipped.pushBacks, fixed.pushBacks],
      ["  label strings marshalled (WStringVector.push_back)", shipped.labelsMarshalled, fixed.labelsMarshalled],
      ["  other strings marshalled (title, font families)", shipped.stringsMarshalled, fixed.stringsMarshalled],
      ["Native allocations per render (FloatVector, WStringVector, SCRTTextStyle)", shipped.allocations, fixed.allocations],
      ["Time in AxisCubeEntity.Update per render, ms (includes the per-call counters' overhead)", shipped.updateMs, fixed.updateMs],
      ["Image check: pixels drawn at the starting camera after the orbit", readable ? drawn : null, readable ? drawnFixed : null],
      ["Image check: pixels differing from the previous shipped image", readable ? noise : null, fixDiff],
    ],
    notes: [
      "The remaining calls in the fix column are the per-frame plane flags (visibility, label and title modes) and m_bIsCameraChange, which the issue's fix leaves as they are. The descriptors themselves are still rebuilt in JS every frame by AxisBase3D.toAxisDescriptor (ticks, labels, colour parsing); that part is not measured here.",
      !readable
        ? "Image check skipped: the chart canvas cannot be read back with drawImage on this renderer (WebGPU). Run the page with the WebGL renderer for it."
        : `Image check: after each orbit the camera returns to its starting position and the chart canvas (${drawn.toLocaleString("en-US")} drawn pixels) is read back. Two shipped orbits in a row already differ by ${noise} pixels (the axis labels are not laid out identically after each orbit); the image after the fixed orbit differs from the last shipped one by ${fixDiff}. ${sameImage ? "That is consistent with the native descriptors keeping their values between frames, as the fix assumes." : "That is more than the shipped variation: the fix's assumption that native descriptors persist may not hold."}`,
      `Related bug from the issue: getTextStylesEqual(a, b) ${spacingBug ? "returns true for two styles that differ only in multilineSpacing (it compares a.multilineSpacing with itself), so a fix that relies on it would miss such a change" : "detects a multilineSpacing-only change"}.`,
    ],
    metrics: { shipped, fixed, noise, fixDiff, drawn, drawnFixed, spacingBug },
  });
}
