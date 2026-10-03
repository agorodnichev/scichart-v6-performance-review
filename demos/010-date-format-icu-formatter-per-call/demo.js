const META = {
  id: "010",
  title: "Date cursor and tooltip labels build a new ICU date formatter on every call",
  issue: "issues/010-date-format-new-icu-formatter-per-call.md",
  severity: "high",
  claim: "The default cursor format of DateTimeNumericAxis (Date_DDMMYYYY) calls new Date(t).toLocaleDateString(locale, options). V8 reuses the ICU formatter behind that call only when no options are passed, so every rollover or cursor label resolves the locale and builds a new formatter, once per series on each pointer move and again on each render.",
  method: "<p>10 line series on a DateTimeNumericAxis (SmartDateLabelProvider, default cursorLabelFormat) with a default RolloverModifier. The pointer sweeps the plot for 120 frames, one pointermove per frame, first with nothing else going on, then while the chart also redraws every frame (invalidateElement, as a streaming chart would). The demo counts, per frame: chart renders, RolloverModifier.update() calls, calls to the axis's formatCursorLabel, calls to Date.prototype.toLocaleDateString that pass an options object, and new Intl.DateTimeFormat objects. Each run is repeated with the issue's app-side workaround (labelProvider.formatCursorLabel set to one cached Intl.DateTimeFormat). A last pair of runs uses a default CursorModifier (one X-axis label per render).</p><p>An in-page micro-benchmark gives the cost of one call: toLocaleDateString(\"en-US\", options) against a cached Intl.DateTimeFormat.format and against toLocaleDateString() with no arguments (which V8 does cache). The verdict rests on the call counts; the micro-benchmark shows why each call is expensive and depends on the machine.</p>",
};

async function demo(P) {
  const { DateTimeNumericAxis, NumericAxis, FastLineRenderableSeries, XyDataSeries, RolloverModifier, CursorModifier, SciChartRenderer } = P.SciChart;
  const SERIES = 10, POINTS = 1000, FRAMES = 120, CURSOR_FRAMES = 60;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"];
  // Untouched built-ins for the micro-benchmark (taken before any hook is installed).
  const nativeToLocaleDateString = Date.prototype.toLocaleDateString;
  const NativeDateTimeFormat = Intl.DateTimeFormat;

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  const xAxis = new DateTimeNumericAxis(wasmContext);
  sciChartSurface.xAxes.add(xAxis);
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext));
  const day0 = Date.UTC(2020, 0, 1) / 1000; // unix seconds, one point per day
  const xs = Array.from({ length: POINTS }, (_, i) => day0 + i * 86400);
  for (let s = 0; s < SERIES; s++) {
    const ys = xs.map((x, i) => Math.sin(i / 60 + s) + s * 0.6);
    sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, {
      dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: ys, isSorted: true, containsNaN: false }),
      stroke: COLORS[s % COLORS.length], strokeThickness: 2,
    }));
  }
  const rollover = new RolloverModifier();
  sciChartSurface.chartModifiers.add(rollover);
  await P.sleep(500);

  const lp = xAxis.labelProvider;
  P.log(`X axis label provider: ${lp.constructor.name}, cursorNumericFormat = ${lp.cursorNumericFormat}`);

  // Counters
  P.watch.intl();
  P.hookMethod(Date.prototype, "toLocaleDateString", {
    name: "toLocaleDateString (any)",
    onCall: (a) => { if (a[1] && typeof a[1] === "object") P.count("toLocaleDateString(locale, options)"); },
  });
  P.hookAccessor(lp, "formatCursorLabel", { name: "formatCursorLabel calls" }); // getter counts; setter unchanged
  P.hookMethod(SciChartRenderer.prototype, "render", { name: "chart renders" });
  P.hookMethod(RolloverModifier.prototype, "update", { name: "rollover update()" });

  // The issue's app-side workaround: one cached formatter, same options, same SmartDate conversion.
  const shippedFormatter = lp.formatCursorLabel;
  const cachedFmt = new NativeDateTimeFormat("en-US", { month: "numeric", year: "numeric", day: "numeric" });
  const workaround = (v) => lp.applyFormat(cachedFmt.format(new Date((lp.convertToUnixSeconds(v) + lp.dateOffset) * 1000)));
  const sameOutput = P.quiet(() => xs.filter((_, i) => i % 97 === 0).every((v) => workaround(v) === shippedFormatter(v)));
  P.log(`Workaround output equals the shipped formatter on sample dates: ${sameOutput}`);

  const pointer = P.pointer(sciChartSurface);
  async function sweep(label, frames, redraw) {
    pointer.enter(0.5, 0.5);
    await P.idleFrames(5);
    const r = await P.frames(frames, (i) => {
      pointer.move(pointer.sweepX(i, 40), 0.5);
      if (redraw) sciChartSurface.invalidateElement();
    });
    const res = {
      renders: r.perFrame("chart renders"),
      updates: r.perFrame("rollover update()"),
      cursorCalls: r.perFrame("formatCursorLabel calls"),
      withOptions: r.perFrame("toLocaleDateString(locale, options)"),
      newDtf: r.perFrame("new Intl.DateTimeFormat"),
      ms: r.perFrame("Date.toLocaleDateString", "t"),
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    pointer.leave();
    await P.idleFrames(5);
    return res;
  }
  async function pair(label, frames, redraw) {
    P.status(`${label}, library as shipped…`);
    const shipped = await sweep(`${label}, as shipped`, frames, redraw);
    lp.formatCursorLabel = workaround;
    P.status(`${label}, with the cached-formatter workaround…`);
    const fixed = await sweep(`${label}, with workaround`, frames, redraw);
    lp.formatCursorLabel = shippedFormatter;
    return { shipped, fixed };
  }

  const hover = await pair("Rollover, pointer moves only", FRAMES, false);
  const hoverRedraw = await pair("Rollover while the chart redraws every frame", FRAMES, true);

  // Default CursorModifier: one SVG X-axis label per render.
  sciChartSurface.chartModifiers.remove(rollover); // also deletes it
  sciChartSurface.chartModifiers.add(new CursorModifier());
  await P.idleFrames(10);
  const cursor = await pair("Default CursorModifier", CURSOR_FRAMES, false);

  // Micro-benchmark: cost of one call (built-ins taken before hooking, so no counter overhead).
  P.status("Micro-benchmark: one date format call…");
  const opts = { month: "numeric", year: "numeric", day: "numeric" };
  const dates = Array.from({ length: 64 }, (_, i) => new Date((day0 + i * 86400) * 1000));
  const bench = (fn, n) => { const t = P.now(); for (let i = 0; i < n; i++) fn(i); return ((P.now() - t) * 1000) / n; };
  const runBench = () => ({
    withOptions: bench((i) => nativeToLocaleDateString.call(dates[i & 63], "en-US", opts), 1000),
    cached: bench((i) => cachedFmt.format(dates[i & 63]), 1000),
    noOptions: bench((i) => nativeToLocaleDateString.call(dates[i & 63]), 1000),
  });
  runBench(); // warm-up
  await P.nextFrame();
  const micro = runBench();
  P.log(`micro-benchmark, µs per call: ${JSON.stringify(micro)}`);
  const ratio = micro.withOptions / Math.max(micro.cached, 1e-3);

  const s = hover.shipped, f = hover.fixed, rs = hoverRedraw.shipped, rf = hoverRedraw.fixed;
  const reproduced = s.withOptions >= SERIES * 0.8 && f.withOptions <= SERIES * 0.1 && f.cursorCalls >= s.cursorCalls * 0.8;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Hovering ${SERIES} date series calls toLocaleDateString(locale, options) ${s.withOptions.toFixed(1)} times per pointer move (${rs.withOptions.toFixed(1)} per frame when the chart also redraws), each building a new ICU formatter (${micro.withOptions.toFixed(1)} µs vs ${micro.cached.toFixed(2)} µs cached here). With one cached Intl.DateTimeFormat: ${f.withOptions.toFixed(1)}.`
      : `Expected at least ${SERIES} toLocaleDateString(locale, options) calls per hovered frame; measured ${s.withOptions.toFixed(1)} as shipped and ${f.withOptions.toFixed(1)} with the workaround.`,
    columns: ["As shipped", "With cached formatter"],
    rows: [
      ["Rollover, pointer moves only: chart renders per frame", s.renders, f.renders],
      ["Rollover, pointer moves only: rollover update() calls per frame", s.updates, f.updates],
      ["Rollover, pointer moves only: formatCursorLabel calls per frame", s.cursorCalls, f.cursorCalls],
      ["Rollover, pointer moves only: toLocaleDateString(locale, options) calls per frame", s.withOptions, f.withOptions],
      ["Rollover + redraw every frame: rollover update() calls per frame", rs.updates, rf.updates],
      ["Rollover + redraw every frame: toLocaleDateString(locale, options) calls per frame", rs.withOptions, rf.withOptions],
      ["Default CursorModifier: toLocaleDateString(locale, options) calls per frame", cursor.shipped.withOptions, cursor.fixed.withOptions],
      ["new Intl.DateTimeFormat per frame (rollover + redraw)", rs.newDtf, rf.newDtf],
      ["Time inside toLocaleDateString per frame (rollover + redraw), ms", rs.ms, rf.ms],
      ["Frame interval p95 (rollover + redraw), ms", rs.p95, rf.p95],
      ["One date format call (micro-benchmark), µs: toLocaleDateString(\"en-US\", options) vs cached Intl.DateTimeFormat.format", micro.withOptions, micro.cached],
      ["One toLocaleDateString() call with no arguments (V8 caches this one), µs", micro.noOptions, null],
      ["Workaround output identical to the shipped formatter", sameOutput ? "yes" : "no", null],
    ],
    notes: [
      "Call counts do not depend on hardware; times do. V8 builds a new ICU formatter inside every toLocaleDateString call that passes options, which no JS hook can count directly: the micro-benchmark row shows that cost (compare with the cached formatter and with the no-argument call that V8 does cache).",
      "With the default SVG rollover line a pointer move does not trigger a chart render, so the rollover formats once per series per move (the tooltip template, via getTooltipSize). When the chart also renders (streaming data, animation), onParentSurfaceLayoutComplete runs the same update again, and on that second pass the tooltip's seriesInfo setter calls SeriesInfo.equals, which reaches formattedXValue for both the old and the new info because the hit point has not moved since the pointer update. That is 4 calls per series per frame here, more than the issue's estimate of 2 (the issue lists SeriesInfo.equals only for tooltipLegendTemplate). SmartDate axis tick labels use getUTC* helpers and do not add to these counts.",
    ],
    metrics: { hover, hoverRedraw, cursor, micro, ratio, sameOutput, series: SERIES },
  });
}
