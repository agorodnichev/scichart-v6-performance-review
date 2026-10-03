const META = {
  id: "078",
  title: "Every 3D XYZ series rebuild walks all N metadata slots in JS, even with no metadata at all",
  issue: "issues/078-3d-point-metadata-loop-runs-without-metadata.md",
  severity: "medium",
  claim: "RenderableSeriesSceneEntity.rebuildPointMetadata loops over every point on every rebuild to fill per-point colours and scales, even when the series never had metadata, and then reports 'all defaults' so the native side ignores what it wrote. While data streams this O(N) pass runs every frame.",
  method: "<p>One ScatterRenderableSeries3D (PixelPointMarker3D) with 200,000 points and no metadata. The app streams: appendRange of 1,000 points per frame for 60 frames. Per frame the demo counts rebuildPointMetadata calls, the points it walks (its count argument), whether it returned hasDefaultColors and hasDefaultScales, and the time spent in it next to the time in the native rebuild (nativeEntity.UpdateMeshesVec) that follows.</p><p>A/B: the same stream with the issue's fix emulated on this series: dataSeries.hasMetadata = false (what the fixed XyzDataSeries3D mutators would maintain for a series that never received metadata) and rebuildPointMetadata returning the defaults straight away when it is false. Patches are removed afterwards.</p>",
};

async function demo(P) {
  const { NumericAxis3D, ScatterRenderableSeries3D, XyzDataSeries3D, PixelPointMarker3D, Vector3 } = P.SciChart;
  const N = 200000, BATCH = 1000, FRAMES = 60;

  const { sciChart3DSurface: scs, wasmContext: wasm } = await P.createSurface3D("chart", { worldDimensions: new Vector3(200, 200, 200) });
  scs.xAxis = new NumericAxis3D(wasm); scs.yAxis = new NumericAxis3D(wasm); scs.zAxis = new NumericAxis3D(wasm);
  let seed = 9;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const batch = (n) => { const x = new Array(n), y = new Array(n), z = new Array(n); for (let i = 0; i < n; i++) { x[i] = rnd(); y[i] = rnd(); z[i] = rnd(); } return [x, y, z]; };
  const [x0, y0, z0] = batch(N);
  const ds = new XyzDataSeries3D(wasm, { xValues: x0, yValues: y0, zValues: z0 });
  const rs = new ScatterRenderableSeries3D(wasm, { dataSeries: ds, pointMarker: new PixelPointMarker3D(wasm, { fill: "#4e79a7" }) });
  scs.renderableSeries.add(rs);
  await P.sleep(1000);

  const entity = rs.sceneEntity;
  const shippedRebuild = entity.rebuildPointMetadata; // own, bound in the constructor
  const walk = function (colors, scales, metadata, count, defaultColor) {
    P.count("slots walked", 1, count); // the shipped loop runs over `count` slots
    return shippedRebuild.apply(this, arguments);
  };
  let impl = walk;
  entity.rebuildPointMetadata = function (colors, scales, metadata, count, defaultColor) {
    const t0 = P.now();
    const r = impl.apply(this, arguments);
    P.count("rebuildPointMetadata()");
    P.count("rebuildPointMetadata ms x1000", Math.round((P.now() - t0) * 1000));
    if (r && r.hasDefaultColors && r.hasDefaultScales) P.count("returned all defaults");
    return r;
  };
  P.hookMethod(entity.nativeEntity, "UpdateMeshesVec", { name: "UpdateMeshesVec", time: true });
  P.hookMethod(scs.sciChart3DRenderer, "render", { name: "3D render()" });

  async function stream(label) {
    const batches = Array.from({ length: FRAMES }, () => batch(BATCH)); // generated outside the measured frames
    const r = await P.frames(FRAMES, (i) => { const [x, y, z] = batches[i]; ds.appendRange(x, y, z); });
    const calls = r.total("rebuildPointMetadata()");
    const res = {
      rendersPerFrame: r.perFrame("3D render()"),
      callsPerFrame: calls / FRAMES,
      pointsPerFrame: r.total("slots walked", "bytes") / FRAMES,
      allDefaults: calls ? r.total("returned all defaults") / calls : 0,
      loopMs: r.total("rebuildPointMetadata ms x1000") / 1000 / FRAMES,
      nativeMs: r.total("UpdateMeshesVec", "t") / FRAMES,
      p95: r.frameP95,
      count: ds.count(),
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Streaming 1,000 points per frame, as shipped…");
  const shipped = await stream("as shipped");

  // The issue's fix, emulated for this series: a flag the mutators would maintain, and an O(1) exit.
  ds.hasMetadata = false;
  impl = function (colors, scales, metadata, count, defaultColor) {
    const d = this.parentSeries.dataSeries;
    if (d && d.hasMetadata === false) return { hasDefaultColors: true, hasDefaultScales: true };
    return walk.apply(this, arguments);
  };
  P.status("Streaming 1,000 points per frame, hasMetadata shortcut…");
  const fixed = await stream("hasMetadata shortcut");
  entity.rebuildPointMetadata = shippedRebuild;
  delete ds.hasMetadata;

  const reproduced = shipped.callsPerFrame >= 0.9 && shipped.pointsPerFrame >= N * 0.9 && shipped.allDefaults === 1 && fixed.pointsPerFrame === 0 && fixed.callsPerFrame >= 0.9;
  const share = shipped.loopMs / Math.max(1e-6, shipped.loopMs + shipped.nativeMs);
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `While streaming into a series with no metadata, every frame walks ${Math.round(shipped.pointsPerFrame).toLocaleString("en-US")} metadata slots in JS and gets 'all defaults' back (${(shipped.allDefaults * 100).toFixed(0)}% of calls). That loop took ${shipped.loopMs.toFixed(2)} ms per frame against ${shipped.nativeMs.toFixed(2)} ms for the native rebuild here (${(share * 100).toFixed(0)}% of the two). With the hasMetadata shortcut: ${fixed.pointsPerFrame} slots, ${fixed.loopMs.toFixed(3)} ms.`
      : `Expected one full metadata pass per streamed frame; measured ${shipped.callsPerFrame.toFixed(2)} calls and ${Math.round(shipped.pointsPerFrame)} points per frame (all-defaults ratio ${shipped.allDefaults.toFixed(2)}).`,
    columns: ["As shipped", "hasMetadata shortcut (fix)"],
    rows: [
      ["Points appended per frame", BATCH, BATCH],
      ["Renders per frame", shipped.rendersPerFrame, fixed.rendersPerFrame],
      ["rebuildPointMetadata calls per frame", shipped.callsPerFrame, fixed.callsPerFrame],
      ["Metadata slots walked per frame", shipped.pointsPerFrame, fixed.pointsPerFrame],
      ["Calls that returned 'all defaults' (share)", shipped.allDefaults, fixed.allDefaults],
      ["Time in rebuildPointMetadata per frame, ms", shipped.loopMs, fixed.loopMs],
      ["Time in native UpdateMeshesVec per frame, ms", shipped.nativeMs, fixed.nativeMs],
      ["Frame interval p95, ms", shipped.p95, fixed.p95],
      ["Points in the series at the end", shipped.count, fixed.count],
    ],
    notes: [
      "The series never receives metadata, so metadata[i] is undefined for every i: the loop writes the default colour and scale into every slot and reports hasDefaultColors/hasDefaultScales = true, which tells the native side to ignore those slots. Axis-range changes trigger the same full pass (RenderableSeriesSceneEntityState.validate).",
      "The two time rows answer the issue's open question (the loop's share next to the native rebuild) for this machine only; the slot counts do not depend on hardware.",
    ],
    metrics: { N, BATCH, shipped, fixed, share },
  });
}
