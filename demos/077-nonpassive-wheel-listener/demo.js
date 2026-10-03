const META = {
  id: "077",
  title: "Every chart canvas gets a non-passive wheel listener, even when no modifier uses the wheel",
  issue: "issues/077-nonpassive-wheel-listener-on-every-chart.md",
  severity: "medium",
  claim: "MouseManager.subscribe adds its wheel listener to each chart canvas without { passive: true }. It calls preventDefault only when a wheel modifier handled the event, but the browser cannot know that, so a page scroll that starts over any chart has to wait for the main thread.",
  method: "<p>Four charts on one page: RolloverModifier only, no modifiers, ZoomPanModifier (drag only), and MouseWheelZoomModifier. The wheel-listener hook is installed before the first surface is created and records every wheel listener with its target and its passive flag. For each chart the demo counts the non-passive wheel listeners alive on its canvas, then dispatches 10 cancelable wheel events over the plot and counts how many the chart cancelled (defaultPrevented). A chart needs a blocking listener only if one of its modifiers overrides modifierMouseWheel.</p><p>Then it applies the issue's app-side workaround to the charts that cannot consume the wheel (re-add MouseManager.onMouseWheel with { passive: true }), counts again and checks that the wheel events still reach MouseManager.modifierMouseWheel. The original listeners are restored afterwards.</p><p>Scroll latency itself needs trusted input, which a page cannot create. To see the blocking regions, open DevTools > Rendering > Scrolling performance issues: every chart canvas is marked as a wheel event handler region.</p>",
};

async function demo(P) {
  // Must run before any surface exists: MouseManager subscribes in the surface constructor.
  P.watch.listeners();
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, RolloverModifier, ZoomPanModifier, MouseWheelZoomModifier, MouseManager } = P.SciChart;
  const EVENTS = 10;
  // ChartModifierBase is not exported by the UMD bundle: take the no-op modifierMouseWheel from the
  // prototype that owns it in RolloverModifier's chain (RolloverModifier does not override it).
  let owner = RolloverModifier.prototype;
  while (owner && !Object.prototype.hasOwnProperty.call(owner, "modifierMouseWheel")) owner = Object.getPrototypeOf(owner);
  const baseWheel = owner.modifierMouseWheel;

  // Our own registry of wheel listeners alive per element, with their passive flag.
  const wheelListeners = new Map(); // element -> [{ fn, capture, passive }]
  const captureOf = (o) => (typeof o === "boolean" ? o : !!(o && o.capture));
  P.hookMethod(EventTarget.prototype, "addEventListener", {
    name: "addEventListener (registry)",
    onCall: (a, self) => {
      if (a[0] !== "wheel") return;
      const list = wheelListeners.get(self) || [];
      const capture = captureOf(a[2]);
      if (list.some((l) => l.fn === a[1] && l.capture === capture)) return; // the browser ignores duplicates
      list.push({ fn: a[1], capture, passive: !!(a[2] && typeof a[2] === "object" && a[2].passive === true) });
      wheelListeners.set(self, list);
    },
  });
  P.hookMethod(EventTarget.prototype, "removeEventListener", {
    name: "removeEventListener (registry)",
    onCall: (a, self) => {
      if (a[0] !== "wheel" || !wheelListeners.has(self)) return;
      const capture = captureOf(a[2]);
      wheelListeners.set(self, wheelListeners.get(self).filter((l) => !(l.fn === a[1] && l.capture === capture)));
    },
  });
  const nonPassiveOn = (el) => (wheelListeners.get(el) || []).filter((l) => !l.passive).length;

  // Count wheel events that reach the modifiers, per surface.
  const routed = new Map();
  P.hookMethod(MouseManager.prototype, "modifierMouseWheel", {
    name: "MouseManager.modifierMouseWheel",
    onCall: (a, self) => routed.set(self.sciChartSurface, (routed.get(self.sciChartSurface) || 0) + 1),
  });

  const configs = [
    { div: "c1", label: "RolloverModifier only", mods: () => [new RolloverModifier()] },
    { div: "c2", label: "No modifiers", mods: () => [] },
    { div: "c3", label: "ZoomPanModifier (drag to pan)", mods: () => [new ZoomPanModifier()] },
    { div: "c4", label: "MouseWheelZoomModifier", mods: () => [new MouseWheelZoomModifier()] },
  ];
  const xs = Array.from({ length: 500 }, (_, i) => i);
  const charts = [];
  for (const [k, c] of configs.entries()) {
    const { sciChartSurface, wasmContext } = await P.createSurface(c.div);
    sciChartSurface.xAxes.add(new NumericAxis(wasmContext));
    sciChartSurface.yAxes.add(new NumericAxis(wasmContext));
    sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, {
      dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 30 + k)), isSorted: true, containsNaN: false }),
      stroke: "#4e79a7", strokeThickness: 2,
    }));
    c.mods().forEach((m) => sciChartSurface.chartModifiers.add(m));
    // The detector from the issue's fix: does any modifier override the no-op base modifierMouseWheel?
    const consumesWheel = sciChartSurface.chartModifiers.asArray().some((m) => m.modifierMouseWheel !== baseWheel);
    charts.push({ ...c, surface: sciChartSurface, canvas: sciChartSurface.mouseManager.canvas, consumesWheel });
  }
  await P.sleep(600);

  // Dispatch cancelable wheel events at the centre of the plot; return how many were cancelled.
  function wheelBurst(chart) {
    const el = chart.canvas;
    const r = P.quiet(() => el.getBoundingClientRect());
    let cancelled = 0;
    for (let i = 0; i < EVENTS; i++) {
      const ev = new WheelEvent("wheel", { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, deltaY: i % 2 ? -40 : 40, deltaMode: 0 });
      Object.defineProperty(ev, "offsetX", { value: r.width / 2 });
      Object.defineProperty(ev, "offsetY", { value: r.height / 2 });
      el.dispatchEvent(ev);
      if (ev.defaultPrevented) cancelled++;
    }
    return cancelled;
  }

  P.status("Counting wheel listeners and cancelled wheel events, as shipped…");
  for (const ch of charts) {
    ch.shippedNonPassive = nonPassiveOn(ch.canvas);
    ch.shippedListeners = (wheelListeners.get(ch.canvas) || []).length;
    routed.set(ch.surface, 0);
    ch.shippedCancelled = wheelBurst(ch);
    ch.shippedRouted = routed.get(ch.surface);
    P.log(`${ch.label}: ${ch.shippedNonPassive} non-passive of ${ch.shippedListeners} wheel listener(s) on the canvas, ${ch.shippedCancelled}/${EVENTS} wheel events cancelled, consumes wheel: ${ch.consumesWheel}`);
  }
  // Wheel listeners anywhere else on the page (window, document, chart divs)?
  const otherNonPassive = [...wheelListeners.entries()].filter(([el]) => !charts.some((c) => c.canvas === el)).reduce((s, [el]) => s + nonPassiveOn(el), 0);

  P.status("Applying the app-side workaround (passive listener on charts without a wheel modifier)…");
  const restore = [];
  for (const ch of charts) {
    if (ch.consumesWheel) continue;
    const mm = ch.surface.mouseManager, el = ch.canvas;
    el.removeEventListener("wheel", mm.onMouseWheel);
    el.addEventListener("wheel", mm.onMouseWheel, { passive: true });
    restore.push(() => { el.removeEventListener("wheel", mm.onMouseWheel); el.addEventListener("wheel", mm.onMouseWheel); });
  }
  for (const ch of charts) {
    ch.fixedNonPassive = nonPassiveOn(ch.canvas);
    routed.set(ch.surface, 0);
    ch.fixedCancelled = wheelBurst(ch);
    ch.fixedRouted = routed.get(ch.surface);
    P.log(`${ch.label} with workaround: ${ch.fixedNonPassive} non-passive, ${ch.fixedCancelled}/${EVENTS} cancelled, ${ch.fixedRouted}/${EVENTS} routed to modifiers`);
  }
  restore.forEach((f) => f());

  const idle = charts.filter((c) => !c.consumesWheel);
  const zoom = charts.filter((c) => c.consumesWheel);
  const sum = (arr, k) => arr.reduce((s, c) => s + c[k], 0);
  const reproduced = charts.every((c) => c.shippedNonPassive >= 1)
    && idle.every((c) => c.shippedCancelled === 0)
    && idle.every((c) => c.fixedNonPassive === 0 && c.fixedRouted === EVENTS)
    && zoom.every((c) => c.shippedCancelled > 0);
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `All ${charts.length} chart canvases carry a non-passive wheel listener, but only ${zoom.length} chart can consume the wheel: the other ${idle.length} cancelled ${sum(idle, "shippedCancelled")} of ${idle.length * EVENTS} wheel events. Re-adding their listener as passive keeps every event routed (${sum(idle, "fixedRouted")}/${idle.length * EVENTS}).`
      : `Expected a non-passive wheel listener on every chart canvas that never cancels without a wheel modifier; measured ${sum(charts, "shippedNonPassive")} non-passive listeners on ${charts.length} canvases, ${sum(idle, "shippedCancelled")} cancellations on charts without a wheel modifier.`,
    columns: ["Can consume the wheel", "Non-passive wheel listeners (as shipped)", `Wheel events cancelled (of ${EVENTS})`, "Non-passive with workaround", `Events still routed with workaround (of ${EVENTS})`],
    rows: charts.map((c) => [c.label, c.consumesWheel ? "yes" : "no", c.shippedNonPassive, c.shippedCancelled, c.fixedNonPassive, c.fixedRouted])
      .concat([["Non-passive wheel listeners elsewhere on the page", null, otherNonPassive, null, null, null]]),
    notes: [
      "A non-passive wheel listener makes its element a blocking wheel region: the compositor must send the first wheel event of each scroll there to the main thread and wait for the listener before it can scroll the page. Charts without a wheel modifier never call preventDefault (0 cancelled), so for them the wait buys nothing.",
      "The MouseWheelZoomModifier chart cancelling its wheel events also proves the listener really is non-passive: a passive listener's preventDefault would be ignored. The delay itself depends on main-thread load and needs trusted input to measure, so it is not timed here.",
    ],
    metrics: { charts: charts.map(({ label, consumesWheel, shippedNonPassive, shippedListeners, shippedCancelled, shippedRouted, fixedNonPassive, fixedCancelled, fixedRouted }) => ({ label, consumesWheel, shippedNonPassive, shippedListeners, shippedCancelled, shippedRouted, fixedNonPassive, fixedCancelled, fixedRouted })), otherNonPassive },
  });
}
