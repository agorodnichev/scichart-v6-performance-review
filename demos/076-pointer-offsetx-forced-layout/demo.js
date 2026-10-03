const META = {
  id: "076",
  title: "Every pointer event reads MouseEvent.offsetX/offsetY, forcing a synchronous layout when the page has pending DOM writes",
  issue: "issues/076-pointer-offsetx-forced-layout-per-event.md",
  severity: "medium",
  claim: "ModifierMouseArgs.fromPointerEvent (also fromWheelEvent and fromMouseEvent) computes the mouse point from event.offsetX/offsetY. In Chromium that getter brings style and layout up to date first, so when anything wrote to the DOM since the last frame, the pointer handler runs that layout synchronously, and the frame lays out again after SciChart's own SVG writes.",
  method: "<p>A chart with CursorModifier({ showTooltip: true }) and, below it, a live table of 300 rows x 6 cells (auto table layout). Each frame the demo waits for the frame to finish, then, in separate tasks, (1) optionally writes a new value into one table cell, as a feed handler would, and (2) dispatches one pointermove over the plot. The pointer is created with realOffsets: true, so the browser's own offsetX getter runs. 90 moves per run.</p><p>Per pointer event the demo counts MouseEvent.offsetX/offsetY reads, and the layout reads made inside the pointer handler while the page had uncommitted DOM writes (forced layouts); it times the offsetX getter and the whole synchronous dispatch. Layout reads made later by SciChart itself (getBBox after the tooltip SVG is rebuilt, in the animation frame) are counted separately.</p><p><b>A/B:</b> the issue's fix applied at runtime: ModifierMouseArgs.fromPointerEvent, fromWheelEvent and fromMouseEvent compute the point as (clientX - left, clientY - top) from a canvas origin cached once and invalidated by ResizeObserver, scroll and pointerenter. The demo checks that both versions produce the same mouse points, then restores the originals.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, CursorModifier, ModifierMouseArgs, Point, DpiHelper } = P.SciChart;
  const MOVES = 90, ROWS = 300, COLS = 6;
  P.watch.layout(); // MouseEvent.offsetX/Y (timed), layout reads, DOM writes

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext));
  const xs = Array.from({ length: 500 }, (_, i) => i);
  ["#4e79a7", "#f28e2b", "#59a14f"].forEach((stroke, k) => sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, {
    dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 40 + k) + k), isSorted: true, containsNaN: false }), stroke, strokeThickness: 2,
  })));
  sciChartSurface.chartModifiers.add(new CursorModifier({ showTooltip: true }));

  // The page's own live content: an auto-layout table that a feed updates between frames.
  const cells = P.quiet(() => {
    const table = document.createElement("table");
    table.className = "feed";
    const out = [];
    for (let r = 0; r < ROWS; r++) {
      const tr = table.insertRow();
      for (let c = 0; c < COLS; c++) { const td = tr.insertCell(); td.textContent = c === 0 ? `Instrument ${r + 1}` : (r * 7.31 + c).toFixed(2); out.push(td); }
    }
    document.getElementById("feed").appendChild(table);
    return out;
  });
  const feedCell = cells[3]; // first row, fourth column
  await P.sleep(600);

  const FORCED = "layout reads after a DOM write (forced layout)";
  const counter = (name, field = "n") => { const r = P.snap()[name]; return r ? r[field] : 0; };
  const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));
  let mousePoints = [];
  P.hookMethod(ModifierMouseArgs, "fromPointerEvent", { name: "fromPointerEvent (log)", onCall: (a, self, ret) => { if (a[0].type === "pointermove") mousePoints.push(ret.mousePoint); } });

  const pointer = P.pointer(sciChartSurface, { realOffsets: true });
  async function run(label, feed) {
    pointer.enter(0.5, 0.5);
    await P.idleFrames(5);
    mousePoints = [];
    let handlerForced = 0, dispatchMs = 0;
    const r = await P.frames(MOVES, async (i) => {
      await nextTask(); // after this frame's rendering
      await nextTask(); // and after the harness clears its dirty flag
      if (feed) feedCell.textContent = i % 2 ? "1.5" : "1234567.891011"; // a feed message; the column width changes
      await nextTask(); // the pointer event is a separate task
      const f0 = counter(FORCED), t0 = P.now();
      pointer.move(pointer.sweepX(i, 30), 0.5);
      dispatchMs += P.now() - t0;
      handlerForced += counter(FORCED) - f0;
    });
    const res = {
      offsetReads: (r.total("MouseEvent.offsetX") + r.total("MouseEvent.offsetY")) / MOVES,
      handlerForced: handlerForced / MOVES,
      otherForced: (r.total(FORCED) - handlerForced) / MOVES,
      getterMs: (r.total("MouseEvent.offsetX", "t") + r.total("MouseEvent.offsetY", "t")) / MOVES,
      dispatchMs: dispatchMs / MOVES,
      rectReads: r.total("getBoundingClientRect") / MOVES,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    const points = mousePoints.map((p) => [p.x, p.y]);
    pointer.leave();
    await P.idleFrames(5);
    return { res, points };
  }

  P.status("Pointer moves on an idle page, as shipped…");
  const idle = await run("as shipped, idle page", false);
  P.status("Pointer moves while the page writes DOM between frames, as shipped…");
  const busy = await run("as shipped, page writes DOM", true);

  // ---- the fix: mouse point from clientX/Y and a cached canvas origin
  const origin = new Map();
  const invalidate = () => origin.clear();
  const canvas = sciChartSurface.mouseManager.canvas;
  const ro = new ResizeObserver(invalidate);
  ro.observe(canvas);
  window.addEventListener("scroll", invalidate, { passive: true, capture: true });
  canvas.addEventListener("pointerenter", invalidate);
  const originOf = (el) => {
    let o = origin.get(el);
    if (!o) {
      const r = el.getBoundingClientRect(); // offsetX is from the padding edge, the rect from the border edge
      o = { left: r.left + el.clientLeft, top: r.top + el.clientTop };
      origin.set(el, o);
    }
    return o;
  };
  const pointOf = (e) => { const o = originOf(e.target); return new Point((e.clientX - o.left) * DpiHelper.PIXEL_RATIO, (e.clientY - o.top) * DpiHelper.PIXEL_RATIO); };
  const shipped = { pointer: ModifierMouseArgs.fromPointerEvent, wheel: ModifierMouseArgs.fromWheelEvent, mouse: ModifierMouseArgs.fromMouseEvent };
  ModifierMouseArgs.fromPointerEvent = function (e) {
    const args = new ModifierMouseArgs(pointOf(e), { button: e.button, pointerId: e.pointerId, pointerType: e.pointerType, target: e.target, isMaster: true, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, nativeEvent: e });
    if (e.type === "pointermove") mousePoints.push(args.mousePoint);
    return args;
  };
  ModifierMouseArgs.fromWheelEvent = function (e) {
    return new ModifierMouseArgs(pointOf(e), { mouseWheelDelta: e.deltaY, target: e.target, isMaster: true, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, nativeEvent: e });
  };
  ModifierMouseArgs.fromMouseEvent = function (e) {
    return new ModifierMouseArgs(pointOf(e), { target: e.target, isMaster: true, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, nativeEvent: e });
  };
  await P.idleFrames(3); // let the ResizeObserver deliver its initial observation before measuring
  P.status("Pointer moves while the page writes DOM between frames, with the cached origin…");
  const fixed = await run("with fix, page writes DOM", true);
  ModifierMouseArgs.fromPointerEvent = shipped.pointer;
  ModifierMouseArgs.fromWheelEvent = shipped.wheel;
  ModifierMouseArgs.fromMouseEvent = shipped.mouse;
  ro.disconnect();
  window.removeEventListener("scroll", invalidate, { capture: true });
  canvas.removeEventListener("pointerenter", invalidate);

  // Same pointer positions in every run, so the mouse points must match.
  const maxDiff = (a, b) => a.length !== b.length ? Infinity : a.reduce((m, p, i) => Math.max(m, Math.abs(p[0] - b[i][0]), Math.abs(p[1] - b[i][1])), 0);
  const diffFixed = maxDiff(busy.points, fixed.points);
  const I = idle.res, B = busy.res, F = fixed.res;
  const reproduced = B.offsetReads >= 1 && B.handlerForced >= 0.9 && I.handlerForced <= 0.1 && F.offsetReads === 0 && F.handlerForced <= 0.1 && diffFixed <= 0.5;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `While the page writes DOM between frames, ${(B.handlerForced * 100).toFixed(0)}% of pointer events force a synchronous layout inside SciChart's handler (offsetX getter ${B.getterMs.toFixed(3)} ms per event vs ${I.getterMs.toFixed(3)} ms on an idle page). With the cached origin: ${F.handlerForced.toFixed(2)} forced layouts and ${F.offsetReads} offsetX reads per event, same mouse points (max difference ${diffFixed.toFixed(2)} px).`
      : `Expected one forced layout per pointer event while the page has pending DOM writes; measured ${B.handlerForced.toFixed(2)} (idle page ${I.handlerForced.toFixed(2)}, with the fix ${F.handlerForced.toFixed(2)}, point difference ${diffFixed} px).`,
    columns: ["As shipped, idle page", "As shipped, page writes DOM", "With fix, page writes DOM"],
    rows: [
      ["MouseEvent.offsetX/offsetY reads per pointer event", I.offsetReads, B.offsetReads, F.offsetReads],
      ["Forced layouts inside the pointer handler per event", I.handlerForced, B.handlerForced, F.handlerForced],
      ["getBoundingClientRect calls per event (the fix reads it once per enter/resize/scroll)", I.rectReads, B.rectReads, F.rectReads],
      ["Mouse points vs the shipped run (max difference, px)", "reference", "reference", diffFixed],
      ["Time in the offsetX/offsetY getters per event, ms", I.getterMs, B.getterMs, F.getterMs],
      ["Synchronous pointermove dispatch per event, ms", I.dispatchMs, B.dispatchMs, F.dispatchMs],
      ["Layout reads after DOM writes elsewhere per event (SciChart's own, in the animation frame)", I.otherForced, B.otherForced, F.otherForced],
      ["Frame interval p95, ms", I.p95, B.p95, F.p95],
    ],
    notes: [
      "Counts do not depend on hardware; times do. A read counts as a forced layout when a DOM or style write happened since the last frame (the harness tracks writes through the DOM APIs it hooks); the getter time shows where the layout ran: on the idle page the getter is cheap, after the feed write it includes laying out the table.",
      "SciChart then rebuilds the cursor tooltip in its animation frame and measures it with getBBox, so a frame with a forced layout in the pointer handler lays out at least twice. With the fix the feed write and the tooltip write are laid out together. The browser's own end-of-frame layout is not visible to page scripts and is not counted.",
    ],
    metrics: { idle: I, busy: B, fixed: F, diffFixed },
  });
}
