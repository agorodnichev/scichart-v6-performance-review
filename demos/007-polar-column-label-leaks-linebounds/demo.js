const META = {
  id: "007",
  title: "Radial polar column data labels leak one native TSRTextLineBounds per label per render",
  issue: "issues/007-polar-column-label-leaks-native-linebounds.md",
  severity: "high",
  claim: "In the radial-X (vertical) branch of PolarColumnSeriesDataLabelProvider.getPosition, GetLineBounds(0) is called a second time inline and that handle is never deleted. It is a raw-pointer handle with no GC finalizer, so every label on every render leaves one object in the wasm heap.",
  method: "<p>Two polar charts, each with one PolarColumnRenderableSeries of 24 labelled bars (<code>dataLabels.style</code> set). Left: X axis on the radial axis (<code>polarAxisMode: Radial</code>, the vertical polar layout that takes the leaking branch). Right: default angular X axis (control, the branch that reads once and deletes). Each run forces 60 renders of one chart with <code>invalidateElement()</code>, one per frame.</p><p>Counted per run: surface renders, <code>getPosition</code> calls (one per label), wasm <code>TSRTextBounds.GetLineBounds</code> calls, and native <code>TSRTextLineBounds</code> handles created vs deleted (the harness counts every embind handle when it is created and when <code>delete()</code> runs). The demo also records the native address of every returned handle: a deleted object's memory is reused by the next call, a leaked one's is not.</p><p>A/B: the radial chart again with <code>getPosition</code> wrapped so that <code>GetLineBounds(0)</code> is read once and the same handle is reused, which is what the issue's one-line fix does.</p>",
};

async function demo(P) {
  const { SciChartPolarSurface, PolarNumericAxis, EPolarAxisMode, EAxisAlignment, PolarColumnRenderableSeries, PolarColumnSeriesDataLabelProvider, XyDataSeries, NumberRange } = P.SciChart;
  const BARS = 24, FRAMES = 60;

  // Local helper: P.createSurface() calls SciChartSurface.create(). Route it to SciChartPolarSurface so the
  // polar charts share the harness's native-object hooks (all create() surfaces share one wasm context).
  async function createPolarSurface(div) {
    const real = P.SciChart;
    P.SciChart = Object.create(real, { SciChartSurface: { value: SciChartPolarSurface } });
    try { return await P.createSurface(div); } finally { P.SciChart = real; }
  }

  async function makeChart(div, radialX) {
    const { sciChartSurface, wasmContext } = await createPolarSurface(div);
    sciChartSurface.xAxes.add(new PolarNumericAxis(wasmContext, {
      polarAxisMode: radialX ? EPolarAxisMode.Radial : EPolarAxisMode.Angular,
      // a radial X axis makes a "vertical" chart: SciChart requires X aligned Left/Right and Y Top/Bottom
      axisAlignment: radialX ? EAxisAlignment.Right : EAxisAlignment.Top,
      visibleRange: new NumberRange(-0.5, BARS - 0.5),
    }));
    sciChartSurface.yAxes.add(new PolarNumericAxis(wasmContext, {
      polarAxisMode: radialX ? EPolarAxisMode.Angular : EPolarAxisMode.Radial,
      axisAlignment: radialX ? EAxisAlignment.Top : EAxisAlignment.Right,
      visibleRange: new NumberRange(0, 14),
    }));
    const xs = Array.from({ length: BARS }, (_, i) => i);
    const ys = xs.map((i) => 3 + ((i * 7) % 10));
    sciChartSurface.renderableSeries.add(new PolarColumnRenderableSeries(wasmContext, {
      dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: ys, isSorted: true, containsNaN: false }),
      fill: radialX ? "#4e79a7" : "#59a14f", stroke: "#ffffff", strokeThickness: 1, dataPointWidth: 0.7,
      dataLabels: { style: { fontFamily: "Arial", fontSize: 11 } },
    }));
    let renders = 0;
    sciChartSurface.rendered.subscribe(() => { renders++; });
    return { sciChartSurface, wasmContext, isVertical: () => sciChartSurface.xAxes.get(0).isVerticalChart, renders: () => renders };
  }

  const radial = await makeChart("chart-radial", true);
  const angular = await makeChart("chart-angular", false);
  const wasmContext = radial.wasmContext;
  await P.sleep(600);

  // Counters: every GetLineBounds call and the native address it returns; labels = getPosition calls.
  const addresses = new Set();
  P.hookMethod(wasmContext.TSRTextBounds.prototype, "GetLineBounds", {
    name: "wasm TSRTextBounds.GetLineBounds",
    onCall: (args, self, ret) => { if (ret && ret.$$ && ret.$$.ptr) addresses.add(ret.$$.ptr); },
  });
  const provider = PolarColumnSeriesDataLabelProvider.prototype;
  P.hookMethod(provider, "getPosition", { name: "labels positioned (getPosition)" });

  async function run(label, chart, other) {
    await P.idleFrames(3);
    addresses.clear();
    const r0 = chart.renders(), o0 = other.renders();
    P.native.reset();
    P.native.start();
    const heap0 = P.memory(wasmContext).wasmMemoryMB;
    const r = await P.frames(FRAMES, () => chart.sciChartSurface.invalidateElement());
    P.native.stop();
    const tl = P.native.snapshot().TSRTextLineBounds || { created: 0, deleted: 0, live: 0 };
    const renders = chart.renders() - r0;
    const labels = r.total("labels positioned (getPosition)");
    const res = {
      vertical: chart.isVertical(), renders, otherRenders: other.renders() - o0, labels,
      labelsPerRender: labels / Math.max(1, renders),
      getLineBounds: r.total("wasm TSRTextBounds.GetLineBounds"),
      created: tl.created, deleted: tl.deleted, leaked: tl.created - tl.deleted,
      addresses: addresses.size,
      heapMB: [heap0, P.memory(wasmContext).wasmMemoryMB],
    };
    res.perLabel = (v) => v / Math.max(1, labels);
    P.log(`${label}: ${JSON.stringify({ ...res, perLabel: undefined })}`);
    return res;
  }

  P.status("Radial X axis (vertical polar chart), library as shipped…");
  const shipped = await run("radial X, as shipped", radial, angular);

  // The issue's fix: reuse the line bounds already fetched instead of calling GetLineBounds(0) again.
  const getPosition = provider.getPosition;
  provider.getPosition = function (state, textBounds) {
    let first = null;
    textBounds.GetLineBounds = function (i) {
      if (i === 0 && first && !first.isDeleted()) return first;
      const lb = Object.getPrototypeOf(this).GetLineBounds.call(this, i);
      if (i === 0) first = lb;
      return lb;
    };
    try { return getPosition.call(this, state, textBounds); } finally { delete textBounds.GetLineBounds; }
  };
  P.status("Radial X axis, with the fix…");
  const fixed = await run("radial X, with fix", radial, angular);
  provider.getPosition = getPosition;

  P.status("Angular X axis (horizontal polar chart), as shipped…");
  const control = await run("angular X, as shipped", angular, radial);

  const leakPerLabel = shipped.perLabel(shipped.leaked);
  const valid = shipped.vertical && !control.vertical && shipped.renders >= FRAMES * 0.5 && shipped.labelsPerRender >= BARS * 0.9;
  const reproduced = valid && leakPerLabel >= 0.9 && fixed.leaked === 0 && control.leaked === 0;
  P.report({
    verdict: !valid ? "inconclusive" : reproduced ? "reproduced" : "not-reproduced",
    headline: !valid
      ? `The scenario did not run as intended (vertical chart: ${shipped.vertical}, renders: ${shipped.renders}, labels per render: ${shipped.labelsPerRender.toFixed(1)}).`
      : reproduced
        ? `Radial-X chart: ${shipped.leaked.toLocaleString("en-US")} TSRTextLineBounds never deleted after ${shipped.renders} renders of ${BARS} labels (${leakPerLabel.toFixed(2)} per label per render). With the line bounds read once: ${fixed.leaked}. Angular-X control: ${control.leaked}.`
        : `Expected about 1 undeleted TSRTextLineBounds per label per render; measured ${leakPerLabel.toFixed(2)} (${shipped.leaked} over ${shipped.renders} renders), ${fixed.leaked} with the fix, ${control.leaked} on the angular-X chart.`,
    columns: ["Radial X, as shipped", "Radial X, with fix", "Angular X (control)"],
    rows: [
      ["Surface renders", shipped.renders, fixed.renders, control.renders],
      ["Labels positioned per render", shipped.labelsPerRender, fixed.labelsPerRender, control.labelsPerRender],
      ["GetLineBounds calls per label", shipped.perLabel(shipped.getLineBounds), fixed.perLabel(fixed.getLineBounds), control.perLabel(control.getLineBounds)],
      ["TSRTextLineBounds created per label", shipped.perLabel(shipped.created), fixed.perLabel(fixed.created), control.perLabel(control.created)],
      ["TSRTextLineBounds deleted per label", shipped.perLabel(shipped.deleted), fixed.perLabel(fixed.deleted), control.perLabel(control.deleted)],
      ["TSRTextLineBounds never deleted, whole run", shipped.leaked, fixed.leaked, control.leaked],
      ["Distinct native addresses returned", shipped.addresses, fixed.addresses, control.addresses],
      ["Leak at 60 renders/s, objects per minute", leakPerLabel * shipped.labelsPerRender * 3600, fixed.perLabel(fixed.leaked) * fixed.labelsPerRender * 3600, control.perLabel(control.leaked) * control.labelsPerRender * 3600],
    ],
    notes: [
      "A leaked handle keeps its native allocation, so the distinct-address row grows with every leaked object. A deleted object's slot is reused, by the next GetLineBounds call or (on WebGPU, which allocates more per frame) by other allocations, so that row stays far below the leak count in the other columns. The issue's Node probe measured 24 bytes per allocation: 60 renders x 24 labels is about 35 KB, below the wasm heap's growth step (wasm memory before/after each run is in the log), and about 2 MB per minute at 60 renders/s.",
      "Per label, the shipped vertical branch makes 2 GetLineBounds calls in getPosition plus 1 in DataLabelProvider.generateDataLabels, and deletes 2. The extra 0.08 calls per label are 2 calls per render outside the data labels, the same in every column. Counts do not depend on hardware. The idle chart was checked for renders during each run (log: otherRenders).",
    ],
    metrics: { shipped: { ...shipped, perLabel: undefined }, fixed: { ...fixed, perLabel: undefined }, control: { ...control, perLabel: undefined }, bars: BARS, frames: FRAMES },
  });
}
