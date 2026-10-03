const META = {
  id: "014",
  title: "Every legend rebuild leaks one isVisibleChanged handler per series, and the old legend DOM with it",
  issue: "issues/014-legend-rebuild-leaks-isvisiblechanged-handlers-and-dom.md",
  severity: "high",
  claim: "With showCheckboxes, SciChartLegend subscribes a new rs.isVisibleChanged handler for every series on every rebuild, but removeEventListenerFromSeries only removes the checkbox's DOM listener and never calls the item's delete(), the only code that unsubscribes. Each leaked handler's closure keeps its old checkbox, and through it the detached legend <div>, alive. Removing the LegendModifier releases nothing.",
  method: "<p>Two identical charts with 10 line series each. The left one gets <code>new LegendModifier({ showCheckboxes: true })</code> as shipped; the right one gets the issue's app-side workaround: <code>new LegendModifier({ showCheckboxes: true, legend })</code> with a SciChartLegend subclass whose removeEventListeners() calls <code>item.delete()</code> for every entry of eventListenersCollection and clears it. On each chart the demo clicks the first legend checkbox 10 times (each click hides or shows series 1 and the legend rebuilds on the next render), then removes the modifier with <code>chartModifiers.remove()</code>.</p><p>It counts the live subscriptions directly: the sum of <code>rs.isVisibleChanged.handlers.length</code> over the 10 series, before the modifier, after the first legend build, after the toggles and after removal, plus EventHandler.subscribe/unsubscribe calls during the toggles. Each legend root &lt;div&gt; is tracked with a WeakRef; where the page can force a garbage collection (the headless verifier) it reports how many detached legend roots survive it.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, LegendModifier, SciChartLegend } = P.SciChart;
  const SERIES = 10, TOGGLES = 10, POINTS = 200;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"];
  P.watch.sciEvents();

  // App-side workaround from the issue: release what was registered, through item.delete().
  class LegendReleasingHandlers extends SciChartLegend {
    removeEventListeners() {
      this.eventListenersCollection.forEach((items) => items.forEach((item) => {
        if (item.delete) item.delete();
        else item.element.removeEventListener(item.eventType, item.eventListener);
      }));
      this.eventListenersCollection.clear();
    }
  }

  async function makeChart(divId) {
    const { sciChartSurface, wasmContext } = await P.createSurface(divId);
    sciChartSurface.xAxes.add(new NumericAxis(wasmContext));
    sciChartSurface.yAxes.add(new NumericAxis(wasmContext));
    const xs = Array.from({ length: POINTS }, (_, i) => i);
    const series = [];
    for (let s = 0; s < SERIES; s++) {
      const rs = new FastLineRenderableSeries(wasmContext, {
        dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 25 + s) + s * 0.5), isSorted: true, containsNaN: false }),
        stroke: COLORS[s], strokeThickness: 2, seriesName: `Series ${s + 1}`,
      });
      sciChartSurface.renderableSeries.add(rs);
      series.push(rs);
    }
    return { sciChartSurface, series };
  }

  const handlersAlive = (series) => series.reduce((n, rs) => n + rs.isVisibleChanged.handlers.length, 0);
  async function waitFor(cond, maxFrames) {
    for (let i = 0; i < maxFrames; i++) { if (cond()) return true; await P.nextFrame(); }
    return !!cond();
  }

  // Runs in its own function so that no local variable keeps an old legend <div> alive afterwards.
  async function toggles(legend, series, roots) {
    let rebuilds = 0;
    const trace = [handlersAlive(series)];
    for (let t = 0; t < TOGGLES; t++) {
      const old = legend.div;
      old.querySelector('input[type="checkbox"]').click(); // hide / show series 1, as a user would
      if (await waitFor(() => legend.div && legend.div !== old, 30)) {
        rebuilds++;
        roots.push(new WeakRef(legend.div));
      }
      trace.push(handlersAlive(series));
    }
    return { rebuilds, trace };
  }

  async function runCase(label, chart, makeModifier) {
    const { sciChartSurface, series } = chart;
    const roots = [];
    const before = handlersAlive(series);
    const legendModifier = makeModifier();
    sciChartSurface.chartModifiers.add(legendModifier);
    const legend = legendModifier.sciChartLegend;
    if (!(await waitFor(() => legend.div, 60))) throw new Error(`${label}: the legend was not built`);
    roots.push(new WeakRef(legend.div));
    const afterBuild = handlersAlive(series);
    const r = await P.during(() => toggles(legend, series, roots));
    const { rebuilds, trace } = r.ret;
    const afterToggles = handlersAlive(series);
    const toggledSeriesHandlers = series[0].isVisibleChanged.handlers.length;
    sciChartSurface.chartModifiers.remove(legendModifier);
    await P.idleFrames(3);
    const afterRemove = handlersAlive(series);
    const res = {
      before, afterBuild, afterToggles, afterRemove, rebuilds, toggledSeriesHandlers,
      perRebuild: rebuilds ? (afterToggles - afterBuild) / rebuilds : 0,
      subscribes: r.total("EventHandler.subscribe"),
      unsubscribes: r.total("EventHandler.unsubscribe"),
      trace,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return { res, roots };
  }

  P.status("Creating two charts with 10 series each…");
  const shippedChart = await makeChart("chartShipped");
  const fixedChart = await makeChart("chartFixed");
  await P.sleep(500);

  P.status("As shipped: toggling a legend checkbox 10 times…");
  const shipped = await runCase("as shipped", shippedChart, () => new LegendModifier({ showCheckboxes: true }));
  P.status("With the workaround: toggling a legend checkbox 10 times…");
  const fixed = await runCase("with workaround", fixedChart, () => new LegendModifier({ showCheckboxes: true, legend: new LegendReleasingHandlers() }));

  P.status("Forcing a garbage collection where the browser allows it…");
  const gcOk = await P.gc();
  const detachedAlive = (roots) => roots.filter((w) => { const el = w.deref(); return el && !el.isConnected; }).length;
  const shippedRetained = gcOk ? detachedAlive(shipped.roots) : null;
  const fixedRetained = gcOk ? detachedAlive(fixed.roots) : null;
  P.log(`detached legend roots alive after GC: as shipped ${shippedRetained} of ${shipped.roots.length}, with workaround ${fixedRetained} of ${fixed.roots.length} (gc available: ${gcOk})`);

  const s = shipped.res, f = fixed.res;
  const rebuiltOk = s.rebuilds >= TOGGLES * 0.8 && f.rebuilds >= TOGGLES * 0.8;
  const leakOk = s.perRebuild >= SERIES * 0.8 && s.afterRemove - s.before >= SERIES * (s.rebuilds + 1) * 0.8;
  const fixOk = f.perRebuild <= SERIES * 0.1 && f.afterRemove - f.before <= SERIES * 0.1;
  const reproduced = rebuiltOk && leakOk && fixOk;
  const verdict = !rebuiltOk ? "inconclusive" : reproduced ? "reproduced" : "not-reproduced";
  P.report({
    verdict,
    headline: verdict === "reproduced"
      ? `Each legend rebuild added ${s.perRebuild.toFixed(1)} isVisibleChanged handlers (${SERIES} series): ${s.afterBuild} after the first build, ${s.afterToggles} after ${s.rebuilds} rebuilds, still ${s.afterRemove} after the LegendModifier was removed. With the workaround: ${f.afterToggles} after the toggles, ${f.afterRemove} after removal.` + (gcOk ? ` Detached legend roots surviving GC: ${shippedRetained} vs ${fixedRetained}.` : "")
      : verdict === "inconclusive"
        ? `The legend did not rebuild on every toggle (${s.rebuilds} and ${f.rebuilds} of ${TOGGLES}), so the leak could not be measured.`
        : `Expected about ${SERIES} new handlers per rebuild that survive removal; measured ${s.perRebuild.toFixed(1)} per rebuild and ${s.afterRemove - s.before} left after removal (workaround: ${f.perRebuild.toFixed(1)}, ${f.afterRemove - f.before}).`,
    columns: ["As shipped", "With workaround"],
    rows: [
      ["Legend rebuilds (one per checkbox click)", s.rebuilds, f.rebuilds],
      ["isVisibleChanged handlers on the 10 series: before the LegendModifier", s.before, f.before],
      ["...after the first legend build", s.afterBuild, f.afterBuild],
      [`...after ${TOGGLES} checkbox clicks`, s.afterToggles, f.afterToggles],
      ["...after chartModifiers.remove(legendModifier)", s.afterRemove, f.afterRemove],
      ["Net handlers added per rebuild", s.perRebuild, f.perRebuild],
      ["Handlers run by each later toggle of series 1", s.toggledSeriesHandlers, f.toggledSeriesHandlers],
      ["EventHandler.subscribe calls during the clicks", s.subscribes, f.subscribes],
      ["EventHandler.unsubscribe calls during the clicks", s.unsubscribes, f.unsubscribes],
      ["Detached legend root <div>s alive after a forced GC", gcOk ? `${shippedRetained} of ${shipped.roots.length}` : "n/a (no forced GC here)", gcOk ? `${fixedRetained} of ${fixed.roots.length}` : "n/a (no forced GC here)"],
    ],
    notes: [
      "The handler counts are read from the series' own EventHandler lists, so they do not depend on hardware or on garbage-collection timing. Each leaked handler shares its closure context with the item's delete(), which captures the checkbox element, so the old legend subtree cannot be collected while the series lives.",
      "The GC row needs a page that can force a collection (the headless verifier runs Chrome with --expose-gc); on JSFiddle it shows n/a and the verdict does not use it.",
      "There is no timing row: the cost is memory and an ever longer handler list that every isVisible change walks.",
    ],
    metrics: { shipped: s, fixed: f, gc: gcOk, shippedRetained, fixedRetained, shippedRoots: shipped.roots.length, fixedRoots: fixed.roots.length },
  });
}
