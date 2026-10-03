const META = {
  id: "030",
  title: "DataValue sub-charts with an HTML wrapper write 4 styles, then read section sizes, every frame: one forced layout per sub-chart",
  issue: "issues/030-datavalue-subchart-wrapper-forced-layout-per-frame.md",
  severity: "medium",
  claim: "SciChartSubSurface.updateSubLayout runs on every render. In DataValue coordinate mode with a subChartContainerId it writes the wrapper's left/top/width/height inline styles, then getOffsets reads clientWidth/clientHeight of the *-section elements. While the parent pans the written values change, so each read forces a synchronous style and layout pass, once per sub-chart.",
  method: "<p>A parent chart with 6 sub-charts positioned in DataValue coordinates, each with an HTML wrapper (subChartContainerId) holding a top-section title and a left-section bar. Four runs of 60 frames: a redraw with no movement (control), a horizontal pan of the parent (visible range shifted back and forth each frame) as shipped, the same pan with the library fix from the issue applied at runtime (SciChartSubSurface.prototype.updateSubLayout replaced by the patched version: only changed styles are written and the sections are re-read only when the wrapper size string changes), and the pan with the section elements removed (the app-side workaround).</p><p>The wrapper elements' style.left/top/width/height setters are instrumented to record whether each write changed the value. The section elements' clientWidth/clientHeight getters are instrumented to count reads, and a read that follows a changed wrapper write in the same task is counted as a forced layout. The time spent in getOffsets, which includes any forced layout, is shown as a cross-check.</p><p>Issue 052 reports the same write-then-read; its page measures the polar sub-chart path and the float jitter of the wrapper width.</p>",
};

async function demo(P) {
  const { SciChartSubSurface, NumericAxis, FastLineRenderableSeries, XyDataSeries, NumberRange, EAutoRange, Rect, Thickness,
    ESubSurfacePositionCoordinateMode, translateToNotScaled, translateToNotScaledRect } = P.SciChart;
  const SUBS = 6, FRAMES = 60, STEP = 0.15;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#b07aa1"];
  const DataValue = ESubSurfacePositionCoordinateMode.DataValue;

  const { sciChartSurface: parent, wasmContext } = await P.createSurface("chart");
  const xAxis = new NumericAxis(wasmContext, { visibleRange: new NumberRange(0, 100), autoRange: EAutoRange.Never });
  parent.xAxes.add(xAxis);
  parent.yAxes.add(new NumericAxis(wasmContext, { visibleRange: new NumberRange(0, 10), autoRange: EAutoRange.Never }));
  const xs = Array.from({ length: 200 }, (_, i) => i * 0.6);
  parent.renderableSeries.add(new FastLineRenderableSeries(wasmContext, {
    dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => 1.5 + Math.sin(x / 6)), isSorted: true, containsNaN: false }),
    stroke: "#9aa3b2", strokeThickness: 1,
  }));
  const subs = [];
  for (let i = 0; i < SUBS; i++) {
    const sub = SciChartSubSurface.createSubSurface(parent, {
      position: new Rect(12 + i * 15, 8.8, 11, 5.6), // x, y (top), width, height in parent data units
      coordinateMode: DataValue,
      subChartContainerId: `wrap${i}`,
      isTransparent: false,
    });
    sub.xAxes.add(new NumericAxis(wasmContext, { drawMinorGridLines: false, drawLabels: false }));
    sub.yAxes.add(new NumericAxis(wasmContext, { drawMinorGridLines: false, drawLabels: false }));
    const sx = Array.from({ length: 100 }, (_, k) => k);
    sub.renderableSeries.add(new FastLineRenderableSeries(wasmContext, {
      dataSeries: new XyDataSeries(wasmContext, { xValues: sx, yValues: sx.map((k) => Math.sin(k / 10 + i)), isSorted: true, containsNaN: false }),
      stroke: COLORS[i], strokeThickness: 2,
    }));
    subs.push(sub);
  }
  await P.sleep(600);

  // --- instrumentation ---------------------------------------------------------------
  const wrappers = subs.map((s) => s.subChartContainer);
  if (wrappers.some((w) => !w)) throw new Error("subChartContainerId did not resolve to the wrapper elements");
  const sections = new Set();
  wrappers.forEach((w) => w.querySelectorAll("[class$='-section']").forEach((e) => sections.add(e)));
  let pending = false; // a wrapper style changed since the last section read
  // The browser's own rendering step lays out pending changes: clear the flag in a task after each frame.
  const raf = window.requestAnimationFrame.bind(window), timeout = window.setTimeout.bind(window);
  (function tick() { raf(() => { timeout(() => { pending = false; }, 0); tick(); }); })();
  // In current Chrome the CSS properties of a style object are named properties, not prototype accessors,
  // so the wrapper's own style object gets accessors that forward to setProperty/getPropertyValue.
  const setProp = CSSStyleDeclaration.prototype.setProperty, getProp = CSSStyleDeclaration.prototype.getPropertyValue;
  wrappers.forEach((w) => {
    const last = {};
    ["left", "top", "width", "height"].forEach((prop) => {
      Object.defineProperty(w.style, prop, {
        configurable: true, enumerable: true,
        get() { return getProp.call(this, prop); },
        set(v) {
          setProp.call(this, prop, v);
          P.count("wrapper style writes");
          if (last[prop] !== v) {
            if (last[prop] !== undefined && prop === "width" && Math.abs(parseFloat(v) - parseFloat(last[prop])) < 0.5) P.count("width string changed by < 0.5 px");
            last[prop] = v;
            P.count("wrapper style writes that changed the value");
            P.count(`wrapper ${prop} changed`);
            pending = true;
          }
        },
      });
    });
  });
  ["clientWidth", "clientHeight"].forEach((prop) => P.hookAccessor(Element.prototype, prop, {
    name: prop + " (attributed)",
    onGet: (self) => {
      if (!sections.has(self)) return;
      P.count("section size reads");
      if (pending) { P.count("section reads right after a changed wrapper write (forced layout)"); pending = false; }
    },
  }));
  P.hookMethod(SciChartSubSurface.prototype, "getOffsets", { name: "getOffsets", time: true });

  // updateSubLayout: outer counter + swappable implementation (shipped or patched)
  const proto = SciChartSubSurface.prototype;
  const shippedUpdate = proto.updateSubLayout;
  let updateImpl = shippedUpdate;
  proto.updateSubLayout = function () { P.count("updateSubLayout"); return updateImpl.apply(this, arguments); };
  // The library fix from issue 030, transcribed: write only changed styles, re-read sections only when the size changed.
  const px = (v) => `${v}px`;
  function fixedUpdateWrapper(sub, padding) {
    if (!sub.parentSurface || !sub.subChartContainer) return false;
    const { width: viewWidth, height: viewHeight } = translateToNotScaledRect(sub.parentSurface.viewRect);
    const style = sub.subChartContainer.style;
    const last = sub.__lastWrapperBox || (sub.__lastWrapperBox = {});
    const left = px(padding.left), top = px(padding.top);
    const width = px(viewWidth - padding.left - padding.right), height = px(viewHeight - padding.top - padding.bottom);
    if (last.left !== left) style.left = last.left = left;
    if (last.top !== top) style.top = last.top = top;
    const sizeChanged = last.width !== width || last.height !== height;
    if (sizeChanged) { style.width = last.width = width; style.height = last.height = height; }
    return sizeChanged;
  }
  function fixedUpdateSubLayout() {
    if (!this.offset || this.coordinateMode === DataValue || this.coordinateMode.includes(DataValue)) {
      const o = this.calcPadding();
      const unscaled = new Thickness(translateToNotScaled(o.top), translateToNotScaled(o.right), translateToNotScaled(o.bottom), translateToNotScaled(o.left));
      const sizeChanged = fixedUpdateWrapper(this, unscaled);
      if (sizeChanged || !this.__wrapperOffset) this.__wrapperOffset = this.getOffsets(this.subChartContainer);
      this.offset = Thickness.mergeAdd(o, this.__wrapperOffset);
    }
  }

  let frame = 0;
  const pan = () => { // triangle wave: +STEP for 30 frames, then -STEP for 30 frames
    const dir = Math.floor(frame++ / 30) % 2 === 0 ? 1 : -1;
    const r = xAxis.visibleRange;
    xAxis.visibleRange = new NumberRange(r.min + dir * STEP, r.max + dir * STEP);
  };
  const still = () => parent.invalidateElement();
  async function run(label, perFrame) {
    frame = 0;
    await P.frames(10, perFrame); // warm-up
    frame = 0;
    const r = await P.frames(FRAMES, perFrame);
    const res = {
      updates: r.perFrame("updateSubLayout"),
      writes: r.perFrame("wrapper style writes"),
      changed: r.perFrame("wrapper style writes that changed the value"),
      leftTop: r.perFrame("wrapper left changed") + r.perFrame("wrapper top changed"),
      size: r.perFrame("wrapper width changed") + r.perFrame("wrapper height changed"),
      jitter: r.perFrame("width string changed by < 0.5 px"),
      reads: r.perFrame("section size reads"),
      forced: r.perFrame("section reads right after a changed wrapper write (forced layout)"),
      offsetsMs: r.perFrame("getOffsets", "t"),
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Redraw without movement (control)…");
  const control = await run("no movement", still);
  P.status("Panning the parent, library as shipped…");
  const shipped = await run("pan, as shipped", pan);
  updateImpl = fixedUpdateSubLayout;
  P.status("Panning with the library fix from the issue…");
  const fixed = await run("pan, with fix", pan);
  updateImpl = shippedUpdate;
  subs.forEach((s) => { s.offset = undefined; s.__wrapperOffset = undefined; s.__lastWrapperBox = undefined; });
  // App-side workaround: no *-section elements in the wrapper, so getOffsets reads nothing.
  const removed = [];
  sections.forEach((e) => { removed.push([e, e.parentNode, e.nextSibling]); e.remove(); });
  P.status("Panning without section elements (workaround)…");
  const noSections = await run("pan, no sections", pan);
  removed.reverse().forEach(([e, p, next]) => p.insertBefore(e, next && next.parentNode === p ? next : null));
  proto.updateSubLayout = shippedUpdate;

  const cols = ["No movement", "Pan, as shipped", "Pan, with fix", "Pan, no sections"];
  const row = (label, key) => [label, control[key], shipped[key], fixed[key], noSections[key]];
  const reproduced = shipped.forced >= 0.8 * SUBS && control.forced <= 0.1 * SUBS && noSections.forced <= 0.1 * SUBS;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `While the parent pans, each frame forces ${shipped.forced.toFixed(1)} layouts from section reads (${SUBS} sub-charts: write wrapper styles, then read clientWidth/clientHeight). Without movement: ${control.forced.toFixed(1)}. With the issue's fix: ${fixed.forced.toFixed(1)}; without section elements: ${noSections.forced.toFixed(1)}.`
      : `Expected about ${SUBS} forced layouts per frame while panning; measured ${shipped.forced.toFixed(1)} (no movement ${control.forced.toFixed(1)}, fix ${fixed.forced.toFixed(1)}).`,
    columns: cols,
    rows: [
      row("updateSubLayout calls per frame (one per sub-chart render)", "updates"),
      row("Wrapper style writes per frame", "writes"),
      row("  that changed the value", "changed"),
      row("    left/top changes", "leftTop"),
      row("    width/height changes", "size"),
      row("    width changes smaller than 0.5 px (float jitter)", "jitter"),
      row("Section clientWidth/clientHeight reads per frame", "reads"),
      row("Section reads right after a changed wrapper write (forced layout), per frame", "forced"),
      row("Time in getOffsets per frame, ms (includes the forced layout)", "offsetsMs"),
      row("Frame interval p95, ms", "p95"),
    ],
    notes: [
      `Counts do not depend on hardware; times do. Without movement the same ${control.reads.toFixed(0)} section reads per frame take ${control.offsetsMs.toFixed(3)} ms in getOffsets, against ${shipped.offsetsMs.toFixed(3)} ms while panning: the written values are unchanged, Chromium does not invalidate style for them, and the reads find layout clean.`,
      `With the issue's fix the remaining forced layouts come from frames where the wrapper width string changed: during a pure pan the width is the difference of two float coordinates, and ${fixed.jitter.toFixed(2)} width changes per frame were smaller than 0.5 px. Issue 052 proposes a 0.5 px tolerance for that.`,
    ],
    metrics: { control, shipped, fixed, noSections, subs: SUBS },
  });
}
