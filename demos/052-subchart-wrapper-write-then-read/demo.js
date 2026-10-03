const META = {
  id: "052",
  title: "Polar DataValue sub-charts with a wrapper force one layout per sub-chart per frame; the wrapper width jitters during a pan",
  issue: "issues/052-subchart-wrapper-write-then-read-per-frame.md",
  severity: "medium",
  claim: "SciChartPolarSubSurface.updateSubLayout (like the cartesian SciChartSubSurface) writes the wrapper's inline styles and then reads the *-section sizes on every render in DataValue mode. During a pan the wrapper width is the difference of two float coordinates, so its string changes in the last digits on many frames: a cache that compares sizes exactly still re-reads, while a 0.5 px tolerance removes the reads.",
  method: "<p>A cartesian parent chart with 4 polar sub-charts (SciChartPolarSubSurface) positioned in DataValue coordinates, each with an HTML wrapper (subChartContainerId) holding a top-section title and a left-section bar. The parent pans horizontally (visible range shifted back and forth each frame) for 60 frames in three runs: as shipped; with an exact-compare cache (sections re-read only when the wrapper width/height string changes, as in the fix proposed by issue 030); and with the fix proposed by this issue (re-read only when the wrapper size moved by 0.5 px or more, or the offset was reset, or updateSubLayout was called outside a render). Both fixes are applied by replacing SciChartPolarSubSurface.prototype.updateSubLayout at runtime and are removed afterwards.</p><p>The wrapper elements' style.left/top/width/height setters are instrumented to record whether each write changed the value, and how often the width changed by less than 0.5 px. The section elements' clientWidth/clientHeight getters count reads; a read that follows a changed wrapper write in the same task is counted as a forced layout. The time inside getOffsets (which includes that layout) is a secondary row.</p><p>Overlap: issue 030 reports the same write-then-read for the cartesian SciChartSubSurface, and its page measures that path. This page measures the polar path and the width jitter that decides which fix works.</p>",
};

async function demo(P) {
  const { SciChartPolarSubSurface, SciChartRenderer, NumericAxis, PolarNumericAxis, FastLineRenderableSeries, PolarLineRenderableSeries, XyDataSeries,
    NumberRange, EAutoRange, Rect, Thickness, ESubSurfacePositionCoordinateMode, translateToNotScaled, translateToNotScaledRect } = P.SciChart;
  const SUBS = 4, FRAMES = 60, STEP = 0.15;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#59a14f"];
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
    const sub = SciChartPolarSubSurface.createSubSurface(parent, {
      position: new Rect(10 + i * 22, 9, 16, 6.5), // x, y (top), width, height in parent data units
      coordinateMode: DataValue,
      subChartContainerId: `polarWrap${i}`,
      isTransparent: false,
    });
    sub.xAxes.add(new PolarNumericAxis(wasmContext, { drawLabels: false, drawMinorGridLines: false })); // angular
    sub.yAxes.add(new PolarNumericAxis(wasmContext, { drawLabels: false, drawMinorGridLines: false })); // radial
    const ax = Array.from({ length: 73 }, (_, k) => k * 5);
    sub.renderableSeries.add(new PolarLineRenderableSeries(wasmContext, {
      dataSeries: new XyDataSeries(wasmContext, { xValues: ax, yValues: ax.map((a) => 2 + Math.sin((a * Math.PI) / 60 + i)), isSorted: true, containsNaN: false }),
      stroke: COLORS[i], strokeThickness: 2,
    }));
    subs.push(sub);
  }
  await P.sleep(800);

  // --- instrumentation ---------------------------------------------------------------
  const wrappers = subs.map((s) => s.subChartContainer);
  if (wrappers.some((w) => !w)) throw new Error("subChartContainerId did not resolve to the wrapper elements");
  const sections = new Set();
  wrappers.forEach((w) => w.querySelectorAll("[class$='-section']").forEach((e) => sections.add(e)));
  let pending = false; // a wrapper style changed since the last section read
  const raf = window.requestAnimationFrame.bind(window), timeout = window.setTimeout.bind(window);
  (function tick() { raf(() => { timeout(() => { pending = false; }, 0); tick(); }); })(); // the browser lays out after each frame
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
            if (last[prop] !== undefined && prop === "width") {
              P.count("width string changed");
              if (Math.abs(parseFloat(v) - parseFloat(last[prop])) < 0.5) P.count("width string changed by < 0.5 px");
            }
            last[prop] = v;
            P.count("wrapper style writes that changed the value");
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
  const proto = SciChartPolarSubSurface.prototype;
  P.hookMethod(proto, "getOffsets", { name: "getOffsets", time: true });

  // updateSubLayout: outer counter + swappable implementation
  const shippedUpdate = proto.updateSubLayout;
  let updateImpl = shippedUpdate;
  proto.updateSubLayout = function () { P.count("updateSubLayout"); return updateImpl.apply(this, arguments); };
  // isDrawing: true while SciChartRenderer.render runs (the fix passes it from SciChartRenderer.js:149)
  let inRender = 0;
  const render = SciChartRenderer.prototype.render;
  SciChartRenderer.prototype.render = function () { inRender++; try { return render.apply(this, arguments); } finally { inRender--; } };

  const px = (v) => `${v}px`;
  const padOf = (sub) => {
    const o = sub.calcPadding();
    return { o, unscaled: new Thickness(translateToNotScaled(o.top), translateToNotScaled(o.right), translateToNotScaled(o.bottom), translateToNotScaled(o.left)) };
  };
  const isDataValue = (sub) => sub.coordinateMode === DataValue || sub.coordinateMode.includes(DataValue);
  // (a) exact-compare cache, as proposed by issue 030
  function exactUpdateSubLayout() {
    if (!this.offset || isDataValue(this)) {
      const { o, unscaled: p } = padOf(this);
      if (!this.parentSurface || !this.subChartContainer) { this.offset = o; return; }
      const { width: vw, height: vh } = translateToNotScaledRect(this.parentSurface.viewRect);
      const style = this.subChartContainer.style, last = this.__box || (this.__box = {});
      const left = px(p.left), top = px(p.top), width = px(vw - p.left - p.right), height = px(vh - p.top - p.bottom);
      if (last.left !== left) style.left = last.left = left;
      if (last.top !== top) style.top = last.top = top;
      const sizeChanged = last.width !== width || last.height !== height;
      if (sizeChanged) { style.width = last.width = width; style.height = last.height = height; }
      if (sizeChanged || !this.__wrapperOffset) this.__wrapperOffset = this.getOffsets(this.subChartContainer);
      this.offset = Thickness.mergeAdd(o, this.__wrapperOffset);
    }
  }
  // (b) the fix proposed by issue 052: styles written as shipped, sections re-read only on a >= 0.5 px size change
  function toleranceUpdateSubLayout(isDrawing = inRender > 0) {
    if (!this.offset || isDataValue(this)) {
      const { o, unscaled: p } = padOf(this);
      let size;
      if (this.parentSurface && this.subChartContainer) {
        const { width: vw, height: vh } = translateToNotScaledRect(this.parentSurface.viewRect);
        size = { width: vw - p.left - p.right, height: vh - p.top - p.bottom };
        const style = this.subChartContainer.style;
        style.left = px(p.left); style.top = px(p.top); style.width = px(size.width); style.height = px(size.height);
      }
      const last = this.__measuredSize;
      if (!isDrawing || !this.offset || !this.__offsetCache || !size || !last ||
        Math.abs(size.width - last.width) >= 0.5 || Math.abs(size.height - last.height) >= 0.5) {
        this.__offsetCache = this.getOffsets(this.subChartContainer);
        this.__measuredSize = size;
      }
      this.offset = Thickness.mergeAdd(o, this.__offsetCache);
    }
  }

  let frame = 0;
  const pan = () => { // triangle wave: +STEP for 30 frames, then -STEP for 30 frames
    const dir = Math.floor(frame++ / 30) % 2 === 0 ? 1 : -1;
    const r = xAxis.visibleRange;
    xAxis.visibleRange = new NumberRange(r.min + dir * STEP, r.max + dir * STEP);
  };
  async function run(label) {
    frame = 0;
    await P.frames(10, pan); // warm-up
    frame = 0;
    const r = await P.frames(FRAMES, pan);
    const res = {
      updates: r.perFrame("updateSubLayout"),
      writes: r.perFrame("wrapper style writes"),
      changed: r.perFrame("wrapper style writes that changed the value"),
      widthChanged: r.perFrame("width string changed"),
      jitter: r.perFrame("width string changed by < 0.5 px"),
      reads: r.perFrame("section size reads"),
      forced: r.perFrame("section reads right after a changed wrapper write (forced layout)"),
      offsetsMs: r.perFrame("getOffsets", "t"),
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Panning the parent, library as shipped…");
  const shipped = await run("as shipped");
  updateImpl = exactUpdateSubLayout;
  P.status("Panning with an exact-compare cache (issue 030's fix)…");
  const exact = await run("exact-compare cache");
  subs.forEach((s) => { s.offset = undefined; });
  updateImpl = toleranceUpdateSubLayout;
  P.status("Panning with a 0.5 px tolerance (this issue's fix)…");
  const tolerant = await run("0.5 px tolerance");
  proto.updateSubLayout = shippedUpdate;
  SciChartRenderer.prototype.render = render;
  subs.forEach((s) => { s.offset = undefined; });

  const cols = ["As shipped", "Exact-compare cache (030)", "0.5 px tolerance (052)"];
  const row = (label, key) => [label, shipped[key], exact[key], tolerant[key]];
  const reproduced = shipped.forced >= 0.8 * SUBS && tolerant.forced <= 0.1 * SUBS;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `While the parent pans, ${SUBS} polar sub-charts force ${shipped.forced.toFixed(1)} layouts per frame. The wrapper width string changed ${shipped.widthChanged.toFixed(2)} times per frame (${shipped.jitter.toFixed(2)} of them by less than 0.5 px), so an exact-compare cache still forces ${exact.forced.toFixed(2)} per frame; the 0.5 px tolerance forces ${tolerant.forced.toFixed(2)}.`
      : `Expected about ${SUBS} forced layouts per frame and some sub-pixel width changes; measured ${shipped.forced.toFixed(1)} forced and ${shipped.jitter.toFixed(2)} sub-pixel width changes (tolerance fix: ${tolerant.forced.toFixed(2)}).`,
    columns: cols,
    rows: [
      row("updateSubLayout calls per frame (one per polar sub-chart render)", "updates"),
      row("Wrapper style writes per frame", "writes"),
      row("  that changed the value", "changed"),
      row("Wrapper width string changes per frame", "widthChanged"),
      row("  of which smaller than 0.5 px (float jitter, no real resize)", "jitter"),
      row("Section clientWidth/clientHeight reads per frame", "reads"),
      row("Section reads right after a changed wrapper write (forced layout), per frame", "forced"),
      row("Time in getOffsets per frame, ms (includes the forced layout)", "offsetsMs"),
      row("Frame interval p95, ms", "p95"),
    ],
    notes: [
      "Counts do not depend on hardware; times do. The pan only moves the sub-charts; their data-space width is constant, so every width change seen here is floating-point noise in rightAbsolute - leftAbsolute.",
      "The tolerance fix keeps writing all four styles (as the issue's diff does); the changed left/top values are then laid out by the browser's own rendering step instead of inside getOffsets.",
    ],
    metrics: { shipped, exact, tolerant, subs: SUBS },
  });
}
