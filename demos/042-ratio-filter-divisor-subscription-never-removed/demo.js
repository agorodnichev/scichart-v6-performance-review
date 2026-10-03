const META = {
  id: "042",
  title: "XyRatioFilter never unsubscribes from its divisor: deleted filters stay alive and throw on divisor updates",
  issue: "issues/042-ratio-filter-divisor-subscription-never-removed.md",
  severity: "medium",
  claim: "XyRatioFilter subscribes to divisorSeries.dataChanged in its constructor and never unsubscribes; neither delete() nor detachFromOriginalSeries() touches the divisor. After a ratio series is removed, the divisor keeps the deleted filter alive and calls it on every update, where it throws a TypeError out of the app's append and stops later handlers from running.",
  method: "<p>Two charts, each with a plotted divisor XyDataSeries (500 points). On each chart, 10 cycles of: create a numerator series and an <code>XyRatioFilter</code> over the shared divisor, plot it, wait two frames, then <code>renderableSeries.remove()</code> it (which deletes the series, the filter and the numerator). The demo records the number of handlers on <code>divisor.dataChanged</code> after each cycle and, through <code>WeakRef</code>s, whether the removed filters can be garbage-collected (only where a forced GC is available). Then a live ratio series is added and 20 updates are streamed: <code>numerator.append()</code>, then <code>divisor.append()</code>; the demo counts divisor appends that throw, calls into deleted filters, and the points the live ratio series received.</p><p>Left: as shipped. Right: the issue's fix applied as a runtime patch, <code>XyRatioFilter.prototype.delete</code> and <code>detachFromOriginalSeries</code> unsubscribe from the divisor first.</p>",
};

async function demo(P) {
  const { NumericAxis, XyDataSeries, FastLineRenderableSeries, XyRatioFilter, EAutoRange } = P.SciChart;
  const BASE = 500, CYCLES = 10, UPDATES = 20;
  const proto = XyRatioFilter.prototype;

  // Count calls that reach a filter after it was deleted.
  const filterOnAppend = proto.filterOnAppend;
  proto.filterOnAppend = function () { if (this.getIsDeleted()) P.count("calls into deleted filters"); return filterOnAppend.apply(this, arguments); };

  async function scenario(div, label) {
    const { sciChartSurface, wasmContext } = await P.createSurface(div);
    sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
    sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
    let n = 0;
    const div0 = (x) => 2 + Math.sin(x / 40), num0 = (x) => 3 + Math.cos(x / 25);
    const xs = [], ds = [];
    for (; n < BASE; n++) { xs.push(n); ds.push(div0(n)); }
    const divisor = new XyDataSeries(wasmContext, { xValues: xs, yValues: ds, isSorted: true, containsNaN: false });
    sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries: divisor, stroke: "#4e79a7", strokeThickness: 1.5 }));
    await P.idleFrames(5);
    const baseline = divisor.dataChanged.handlers.length;

    const handlersAfter = [], refs = [];
    for (let c = 0; c < CYCLES; c++) {
      // Inner function so no strong reference to the filter survives the cycle in this scope.
      await (async () => {
        const count = divisor.count();
        const nx = [], ny = [];
        for (let i = 0; i < count; i++) { nx.push(i); ny.push(num0(i)); }
        const numerator = new XyDataSeries(wasmContext, { xValues: nx, yValues: ny, isSorted: true, containsNaN: false });
        const ratio = new XyRatioFilter(numerator, { divisorSeries: divisor });
        refs.push(new WeakRef(ratio));
        const rs = new FastLineRenderableSeries(wasmContext, { dataSeries: ratio, stroke: "#e15759", strokeThickness: 1 });
        sciChartSurface.renderableSeries.add(rs);
        await P.idleFrames(2);
        sciChartSurface.renderableSeries.remove(rs); // default: deletes the series, the filter and the numerator
      })();
      handlersAfter.push(divisor.dataChanged.handlers.length);
    }

    // A live ratio series added after the cycles, then a stream of updates to numerator and divisor.
    const count = divisor.count(), lx = [], ly = [];
    for (let i = 0; i < count; i++) { lx.push(i); ly.push(num0(i)); }
    const liveNum = new XyDataSeries(wasmContext, { xValues: lx, yValues: ly, isSorted: true, containsNaN: false });
    const live = new XyRatioFilter(liveNum, { divisorSeries: divisor });
    sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries: live, stroke: "#59a14f", strokeThickness: 2 }));
    await P.idleFrames(2);
    const liveStart = live.count();
    let throws = 0, firstError = "";
    const r = await P.during(async () => {
      for (let u = 0; u < UPDATES; u++, n++) {
        liveNum.append(n, num0(n));
        try { divisor.append(n, div0(n)); } catch (e) { throws++; if (!firstError) firstError = `${e.name}: ${e.message}`; }
        await P.nextFrame();
      }
    });

    const gcForced = await P.gc();
    const reachable = refs.filter((w) => w.deref() !== undefined).length;
    const res = {
      baseline, handlersAfter, handlersEnd: divisor.dataChanged.handlers.length, throws, firstError,
      deadCalls: r.total("calls into deleted filters"), liveReceived: live.count() - liveStart, sources: [liveNum.count(), divisor.count()],
      gcForced, reachable,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("10 add/remove cycles of a ratio series, as shipped…");
  const shipped = await scenario("chartA", "as shipped");

  // The issue's fix: unsubscribe from the divisor in delete() and detachFromOriginalSeries().
  const hadDelete = Object.prototype.hasOwnProperty.call(proto, "delete"), hadDetach = Object.prototype.hasOwnProperty.call(proto, "detachFromOriginalSeries");
  const del = proto.delete, detach = proto.detachFromOriginalSeries;
  proto.detachFromOriginalSeries = function () { this.divisorSeries.dataChanged.unsubscribe(this.onDivisorDataChanged); return detach.apply(this, arguments); };
  proto.delete = function () { this.divisorSeries.dataChanged.unsubscribe(this.onDivisorDataChanged); return del.apply(this, arguments); };
  P.status("10 add/remove cycles of a ratio series, with the fix…");
  const fixed = await scenario("chartB", "with fix");
  if (hadDelete) proto.delete = del; else delete proto.delete;
  if (hadDetach) proto.detachFromOriginalSeries = detach; else delete proto.detachFromOriginalSeries;
  proto.filterOnAppend = filterOnAppend;

  const leaked = (s) => s.handlersAfter[CYCLES - 1] - s.baseline; // measured before the live ratio series subscribes
  const reproduced = leaked(shipped) >= CYCLES && shipped.throws >= UPDATES * 0.9 && leaked(fixed) === 0 && fixed.throws === 0;
  const gcRow = (s) => (s.gcForced ? s.reachable : null);
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `After ${CYCLES} add/remove cycles the divisor still holds ${leaked(shipped)} handlers of deleted filters, and ${shipped.throws} of ${UPDATES} divisor.append() calls threw (${shipped.firstError}); the live ratio series received ${shipped.liveReceived} of ${UPDATES} points. With the fix: ${leaked(fixed)} handlers, ${fixed.throws} throws, ${fixed.liveReceived} of ${UPDATES} points.`
      : `Expected ${CYCLES} leftover divisor handlers and throwing divisor updates; measured ${leaked(shipped)} leftover handlers and ${shipped.throws} throws (fix: ${leaked(fixed)} / ${fixed.throws}).`,
    columns: ["As shipped", "With fix"],
    rows: [
      ["divisor.dataChanged handlers before the cycles", shipped.baseline, fixed.baseline],
      ["… after " + CYCLES + " add/remove cycles of a ratio series", shipped.handlersAfter[CYCLES - 1], fixed.handlersAfter[CYCLES - 1]],
      ["Handlers left by deleted filters", leaked(shipped), leaked(fixed)],
      ["Removed filters still reachable after a forced GC (verifier only)", gcRow(shipped), gcRow(fixed)],
      ["divisor.append() calls that threw, of " + UPDATES, shipped.throws, fixed.throws],
      ["Calls into deleted filters during the " + UPDATES + " updates", shipped.deadCalls, fixed.deadCalls],
      ["Points the live ratio series received, of " + UPDATES, shipped.liveReceived, fixed.liveReceived],
    ],
    notes: [
      `First error (as shipped): ${shipped.firstError || "none"}. The first dead handler throws inside EventHandler.raiseEvent, so handlers subscribed after it, here the live ratio series' own handler, never run, and the live ratio series silently falls behind its sources.`,
      `Handler count after each cycle, as shipped: ${shipped.handlersAfter.join(", ")}; with the fix: ${fixed.handlersAfter.join(", ")}.`,
      "Counts do not depend on hardware. The GC row needs --expose-gc (the headless verifier); in a normal browser it shows –.",
    ],
    metrics: { shipped, fixed, cycles: CYCLES, updates: UPDATES },
  });
}
