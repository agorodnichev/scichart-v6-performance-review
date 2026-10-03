const META = {
  id: "033",
  title: "Style animations with a pointMarker style replace the series' marker and never delete the old one",
  issue: "issues/033-style-animation-pointmarker-replaced-not-deleted.md",
  severity: "high",
  claim: "BaseRenderableSeries.beforeAnimationStart builds a new point marker from styles.pointMarker and assigns it to series.pointMarker without deleting the marker it replaces. The old marker stays in the global WebGlRenderContext2D.webGlResourcesRefs set with its three sprite CanvasTextures (a canvas, two wasm UIntVectors and a native texture each), so each run of such an animation leaks one marker per series.",
  method: "<p>Two charts with 4 XyScatterRenderableSeries each (100 points, 6 px EllipsePointMarker). On each chart, 10 style animations run one after another on every series, alternating between a 12 px and a 6 px pointMarker style (ScatterAnimation, 250 ms), like a hover-in / hover-out effect. Left chart: library as shipped. Right chart: each series' <code>beforeAnimationStart</code> wrapped with the issue's fix: delete the replaced marker when an earlier style animation created it (the marker the app passed in stays app-owned).</p><p>Counted over each phase: markers created by style animations (<code>animationHelpers.createPointMarker</code>), <code>BasePointMarker.delete()</code> calls, live point markers in <code>WebGlRenderContext2D.webGlResourcesRefs</code> after every run, live markers that no series uses and the sprite CanvasTextures they hold, native <code>UIntVector</code> and texture handles created vs deleted (every embind handle is counted), and GPU textures created vs deleted.</p>",
};

async function demo(P) {
  const { NumericAxis, NumberRange, XyScatterRenderableSeries, XyDataSeries, EllipsePointMarker, ScatterAnimation, EPointMarkerType,
    WebGlRenderContext2D, animationHelpers } = P.SciChart;
  const SERIES = 4, RUNS = 10, DURATION = 250, POINTS = 100;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#59a14f"];
  const BasePointMarker = Object.getPrototypeOf(EllipsePointMarker.prototype).constructor; // not exported by name
  P.watch.gpu();

  async function makeChart(div) {
    const { sciChartSurface, wasmContext } = await P.createSurface(div);
    sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { visibleRange: new NumberRange(-2, POINTS + 2) }));
    sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { visibleRange: new NumberRange(-1.5, SERIES + 0.5) }));
    const series = [];
    for (let s = 0; s < SERIES; s++) {
      const xs = Array.from({ length: POINTS }, (_, i) => i);
      const ys = xs.map((x) => s + 0.35 * Math.sin(x / 7 + s));
      series.push(new XyScatterRenderableSeries(wasmContext, {
        dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: ys, isSorted: true, containsNaN: false }),
        pointMarker: new EllipsePointMarker(wasmContext, { width: 6, height: 6, fill: COLORS[s], stroke: COLORS[s], strokeThickness: 1 }),
      }));
      sciChartSurface.renderableSeries.add(series[s]);
    }
    return { sciChartSurface, series };
  }
  const shippedChart = await makeChart("chart-shipped");
  const fixedChart = await makeChart("chart-fixed");
  const allSeries = shippedChart.series.concat(fixedChart.series);
  await P.sleep(600);

  // The issue's fix on the right chart: free the marker an earlier style animation created; the app's own marker stays app-owned.
  // beforeAnimationStart is bound in the constructor, so the wrapper goes on each instance.
  fixedChart.series.forEach((rs) => {
    const original = rs.beforeAnimationStart;
    let animationOwned;
    rs.beforeAnimationStart = function () {
      const previous = rs.pointMarker;
      original();
      if (rs.pointMarker !== previous) {
        if (previous && previous === animationOwned) previous.delete();
        animationOwned = rs.pointMarker;
      }
    };
  });

  P.hookMethod(animationHelpers, "createPointMarker", { name: "markers created by style animations" });
  P.hookMethod(BasePointMarker.prototype, "delete", { name: "BasePointMarker.delete()" });
  const liveMarkers = () => { let n = 0; WebGlRenderContext2D.webGlResourcesRefs.forEach((r) => { if (r instanceof BasePointMarker) n++; }); return n; };
  const unusedMarkers = () => {
    const used = new Set(allSeries.map((rs) => rs.pointMarker)), out = [];
    WebGlRenderContext2D.webGlResourcesRefs.forEach((r) => { if (r instanceof BasePointMarker && !used.has(r)) out.push(r); });
    return out;
  };
  const texturesHeld = (markers) => markers.reduce((n, m) => n + (m.spriteTextures ? ["spriteTexture", "strokeMask", "fillMask"].filter((k) => m.spriteTextures[k] && m.spriteTextures[k].tsrTextureCache).length : 0), 0);

  async function waitForAnimations(series) {
    const t0 = P.now();
    await P.nextFrame();
    while (series.some((rs) => rs.isRunningAnimation) && P.now() - t0 < 4000) await P.nextFrame();
  }

  async function phase(label, chart) {
    await P.idleFrames(5);
    const unused0 = unusedMarkers().length, live0 = liveMarkers(), liveAfterRun = [];
    P.native.reset();
    P.native.start();
    const r = await P.during(async () => {
      for (let run = 0; run < RUNS; run++) {
        const size = run % 2 === 0 ? 12 : 6;
        chart.series.forEach((rs, s) => rs.runAnimation(new ScatterAnimation({
          duration: DURATION,
          styles: { pointMarker: { type: EPointMarkerType.Ellipse, width: size, height: size, fill: COLORS[s], stroke: COLORS[s], strokeThickness: 1 } },
        })));
        await waitForAnimations(chart.series);
        await P.idleFrames(3);
        liveAfterRun.push(liveMarkers());
      }
    });
    P.native.stop();
    const nat = P.native.snapshot();
    const unused = unusedMarkers();
    const sum = (re) => Object.keys(nat).filter((k) => re.test(k)).reduce((a, k) => ({ created: a.created + nat[k].created, deleted: a.deleted + nat[k].deleted }), { created: 0, deleted: 0 });
    const uiv = sum(/^UIntVector$/), tex = sum(/Texture/);
    const gpuCreated = r.total("gl.createTexture") + r.total("gpu.createTexture");
    const gpuDeleted = r.total("gl.deleteTexture") + r.total("gpu.texture.destroy");
    const res = {
      created: r.total("markers created by style animations"), deletes: r.total("BasePointMarker.delete()"),
      liveDelta: liveAfterRun[RUNS - 1] - live0,
      growthPerRunAfterFirst: (liveAfterRun[RUNS - 1] - liveAfterRun[0]) / (RUNS - 1),
      unusedDelta: unused.length - unused0, unusedTotal: unused.length, texturesHeld: texturesHeld(unused),
      uintVectorsLeaked: uiv.created - uiv.deleted, uintVectorsCreated: uiv.created,
      texturesLeaked: tex.created - tex.deleted, textureClasses: Object.keys(nat).filter((k) => /Texture/.test(k)).join(","),
      gpuCreated, gpuDeleted, gpuNet: gpuCreated - gpuDeleted,
      liveAfterRun,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("10 style animations per series, library as shipped…");
  const shipped = await phase("as shipped", shippedChart);
  P.status("10 style animations per series, with the fix…");
  const fixed = await phase("with fix", fixedChart);

  const reproduced = shipped.created === RUNS * SERIES && shipped.deletes === 0 &&
    shipped.growthPerRunAfterFirst >= SERIES * 0.9 && shipped.unusedDelta >= RUNS * SERIES * 0.9 &&
    fixed.growthPerRunAfterFirst === 0;
  const valid = shipped.created > 0;
  P.report({
    verdict: !valid ? "inconclusive" : reproduced ? "reproduced" : "not-reproduced",
    headline: !valid
      ? "No style animation created a point marker; the scenario did not run."
      : reproduced
        ? `${RUNS} style animations on ${SERIES} series left ${shipped.unusedDelta} point markers alive that no series uses (${shipped.growthPerRunAfterFirst.toFixed(1)} more per run), holding ${shipped.texturesHeld} sprite textures; 0 were deleted. With the fix: ${fixed.deletes} deleted, ${fixed.growthPerRunAfterFirst.toFixed(1)} more per run after the first.`
        : `Expected one leaked marker per series per run; measured ${shipped.growthPerRunAfterFirst.toFixed(2)} more live markers per run (${SERIES} series), ${shipped.deletes} deletes as shipped; fix: ${fixed.growthPerRunAfterFirst.toFixed(2)} per run.`,
    columns: ["As shipped", "With fix"],
    rows: [
      ["Markers created by style animations", shipped.created, fixed.created],
      ["BasePointMarker.delete() calls", shipped.deletes, fixed.deletes],
      ["Live point markers (webGlResourcesRefs), change over 10 runs", shipped.liveDelta, fixed.liveDelta],
      ["  more per run, runs 2-10", shipped.growthPerRunAfterFirst, fixed.growthPerRunAfterFirst],
      ["Live markers that no series uses, added", shipped.unusedDelta, fixed.unusedDelta],
      ["Sprite CanvasTextures held by those markers", shipped.texturesHeld, fixed.texturesHeld],
      ["Native UIntVector handles never deleted", shipped.uintVectorsLeaked, fixed.uintVectorsLeaked],
      ["Native texture handles never deleted", shipped.texturesLeaked, fixed.texturesLeaked],
      ["GPU textures created minus deleted", shipped.gpuNet, fixed.gpuNet],
    ],
    notes: [
      `With the fix, the first run on each series still leaves the marker the app passed in (${SERIES} markers): the fix deliberately leaves it to the app, which still holds a reference. Every later replacement is deleted, so the count stops growing.`,
      `Each leaked marker keeps 3 CanvasTextures, each with a canvas element, 2 UIntVectors (width x height pixels) and a native bitmap texture. Native texture class: ${shipped.textureClasses || "none seen"}. During each run the marker textures are also rebuilt every animation frame (issue 059): that churn is created and deleted again, so it does not show in the "never deleted" rows.`,
      "Counts do not depend on hardware.",
    ],
    metrics: { shipped, fixed, series: SERIES, runs: RUNS },
  });
}
