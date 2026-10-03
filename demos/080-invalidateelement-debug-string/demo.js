const META = {
  id: "080",
  title: "invalidateElement builds a ~150-character debug string on every call while debug logging is off",
  issue: "issues/080-invalidateelement-builds-debug-string-every-call.md",
  severity: "low",
  claim: "SciChartSurface.invalidateElement passes a template literal with six interpolations to Logger.debug before any early return, and Logger.debug only then checks Logger.enableDebug (false by default). Every data change pays for a string that is thrown away, including the calls that arrive after the frame is already invalidated.",
  method: "<p>One chart with 20 line series. Each frame appends 5 single points to every series (100 data changes per frame, each calling invalidateElement through the series' invalidateParentCallback), for 60 frames. Logger.debug (a static method of the exported Logger class) is wrapped to count the 'Invalidating …' strings it receives and their length; Logger.enableDebug stays false. Because each surface binds invalidateElement in its constructor, SciChartSurface.prototype.invalidateElement is replaced before the chart is created by a dispatcher that runs either the shipped method or a copy of it with the issue's fix (the Logger.debug call wrapped in if (Logger.enableDebug)); the same page then runs both versions. The time per invalidateElement call is a secondary row.</p>",
};

async function demo(P) {
  const { SciChartSurface, NumericAxis, FastLineRenderableSeries, XyDataSeries, EAutoRange, Logger, PerformanceDebugHelper, EPerformanceMarkType } = P.SciChart;
  const SERIES = 20, APPENDS = 5, FRAMES = 60;

  // Dispatcher installed before the surface exists (the constructor binds this.invalidateElement).
  const proto = SciChartSurface.prototype;
  const shipped = proto.invalidateElement;
  function fixed(options) {
    // Shipped body (SciChartSurface.js:570-600) with the debug string built only when debug logging is on.
    if (Logger.enableDebug) {
      Logger.debug(`Invalidating ${this.id ?? (this.domChartRoot && this.domChartRoot.id)}: force=${options && options.force} isSuspended=${this.isSuspended} isInitialized=${this.isInitialized}. svgOnly: ${options && options.svgOnly} isInvalidated: ${this.sciChartRenderer && this.sciChartRenderer.isInvalidated}`);
    }
    if (!(options && options.force) && (this.isSuspended || this.isDeleted || !this.isInitialized || !this.isWebGLContextActive)) return;
    PerformanceDebugHelper.mark(this.sciChartRenderer.isInvalidated ? EPerformanceMarkType.Invalidate : EPerformanceMarkType.LeadingInvalidate, { contextId: this.id });
    if (options && options.svgOnly) {
      if (this.sciChartRenderer.isInvalidated || this.sciChartRenderer.svgRenderRequestId) return;
      this.sciChartRenderer.svgRenderRequestId = requestAnimationFrame(() => {
        this.sciChartRenderer.svgRenderRequestId = undefined;
        if (!this.sciChartRenderer.isInvalidated) this.sciChartRenderer.renderDomOnly();
      });
    } else {
      if (this.sciChartRenderer.svgRenderRequestId) {
        cancelAnimationFrame(this.sciChartRenderer.svgRenderRequestId);
        this.sciChartRenderer.svgRenderRequestId = undefined;
      }
      if (!this.sciChartRenderer.isInvalidated) {
        const canvasId = this.domCanvas2D ? this.domCanvas2D.id : "undefinedCanvasId";
        this.sciChartRenderer.isInvalidated = this.renderSurface.invalidateElement(canvasId);
        this.redrawRequested.raiseEvent(this.sciChartRenderer.isInvalidated);
      }
    }
  }
  let useFix = false, measuring = false;
  proto.invalidateElement = function (options) {
    if (measuring) P.count("invalidateElement calls");
    return (useFix ? fixed : shipped).call(this, options);
  };

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
  const series = [];
  for (let s = 0; s < SERIES; s++) {
    const ds = new XyDataSeries(wasmContext, { fifoCapacity: 1000, isSorted: true, containsNaN: false });
    for (let x = 0; x < 200; x++) ds.append(x, Math.sin(x / 30 + s) + s * 0.3);
    sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries: ds, stroke: "#4e79a7", strokeThickness: 1 }));
    series.push(ds);
  }
  sciChartSurface.rendered.subscribe(() => P.count("renders"));
  await P.sleep(500);

  const unhookDebug = P.hookMethod(Logger, "debug", {
    name: "Logger.debug (all)",
    onCall: (a) => { if (typeof a[0] === "string" && a[0].startsWith("Invalidating ")) P.count("'Invalidating …' debug strings built", 1, a[0].length); },
  });

  let x = 200;
  const step = () => {
    for (let k = 0; k < APPENDS; k++) { x++; series.forEach((ds, s) => ds.append(x, Math.sin(x / 30 + s) + s * 0.3)); }
  };
  async function run(label) {
    await P.frames(10, step);
    measuring = true;
    const r = await P.frames(FRAMES, step);
    measuring = false;
    const calls = r.perFrame("invalidateElement calls");
    const res = {
      calls, renders: r.perFrame("renders"),
      strings: r.perFrame("'Invalidating …' debug strings built"),
      chars: r.perFrame("'Invalidating …' debug strings built", "bytes"),
      enableDebug: Logger.enableDebug,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Streaming 100 single-point appends per frame, as shipped…");
  const a = await run("as shipped");
  useFix = true;
  P.status("Same stream with the debug string guarded by Logger.enableDebug…");
  const b = await run("with fix");
  useFix = false;
  // Timing (secondary): many back-to-back calls in one task, so all but the first take the
  // 'already invalidated' exit, as most calls in a streaming frame do. performance.now() is coarse,
  // so time a batch, not single calls.
  P.status("Timing invalidateElement in a tight loop…");
  unhookDebug(); // time the library code, not the counting wrapper
  const bench = (fix, n) => { useFix = fix; const t0 = P.now(); for (let i = 0; i < n; i++) sciChartSurface.invalidateElement(); const us = ((P.now() - t0) / n) * 1000; useFix = false; return us; };
  bench(false, 20000); bench(true, 20000); // warm up both paths
  const N = 200000;
  const usShipped = Math.min(bench(false, N), bench(false, N));
  const usFixed = Math.min(bench(true, N), bench(true, N));
  a.usPerCall = usShipped; b.usPerCall = usFixed;
  await P.idleFrames(2);
  proto.invalidateElement = shipped; // surfaces created from now on bind the original

  const reproduced = a.enableDebug === false && a.calls >= SERIES * APPENDS * 0.9 && a.strings >= 0.95 * a.calls && b.strings === 0;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `With Logger.enableDebug = false, each of the ${a.calls.toFixed(0)} invalidateElement calls per frame still builds a debug string (${(a.chars / a.strings).toFixed(0)} characters, ${a.chars.toFixed(0)} per frame) for ${a.renders.toFixed(0)} render per frame. With the guard: ${b.strings.toFixed(0)}. Cost on this machine: ${a.usPerCall.toFixed(3)} vs ${b.usPerCall.toFixed(3)} µs per call, about ${((a.usPerCall - b.usPerCall) * a.calls).toFixed(1)} µs per frame here.`
      : `Expected one discarded debug string per invalidateElement call; measured ${a.strings.toFixed(1)} strings for ${a.calls.toFixed(1)} calls per frame (with fix ${b.strings.toFixed(1)}).`,
    columns: ["As shipped", "With if (Logger.enableDebug)"],
    rows: [
      ["Logger.enableDebug", String(a.enableDebug), String(b.enableDebug)],
      ["invalidateElement calls per frame (20 series x 5 appends)", a.calls, b.calls],
      ["Renders per frame", a.renders, b.renders],
      ["'Invalidating …' strings built and discarded per frame", a.strings, b.strings],
      ["Characters built per frame", a.chars, b.chars],
      ["Time per invalidateElement call, µs (200,000 back-to-back calls, best of 2)", a.usPerCall, b.usPerCall],
      ["  at this frame's 100 calls, ms per frame", (a.usPerCall * a.calls) / 1000, (b.usPerCall * b.calls) / 1000],
      ["Frame interval p95, ms", a.p95, b.p95],
    ],
    notes: [
      "Counts do not depend on hardware; times do. All but the first call per frame return at the 'already invalidated' check, after the string was built.",
      "The saving per call is small; it scales with the data-change rate (per-point appends make it one string per point).",
    ],
    metrics: { shipped: a, fixed: b },
  });
}
