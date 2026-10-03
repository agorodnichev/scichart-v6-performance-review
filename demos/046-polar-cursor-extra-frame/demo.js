const META = {
  id: "046",
  title: "PolarCursorModifier updates after the render and its tooltip id changes every call, so each full render schedules one more frame",
  issue: "issues/046-polar-cursor-post-render-update-extra-frame.md",
  severity: "medium",
  claim: "PolarCursorModifier runs update() in onParentSurfaceRendered, after the renderer has re-armed invalidation. The default tooltip template stamps Date.now() into its filter id, so the new SVG string never equals the old one: each full render with the pointer over a hit series requests a DOM-only frame that re-parses the tooltip. Each pointer move also hit-tests every series twice (in the handler, then after the render the moved cursor lines cause).",
  method: "<p>A polar chart with 8 ring-shaped line series (so the resting pointer is always within the hit radius of one) and PolarCursorModifier({ showTooltip: true }); next to it a cartesian chart with CursorModifier({ showTooltip: true }) as a control (same tooltip annotation and template, but update() runs in onParentSurfaceLayoutComplete).</p><p><b>Pointer at rest:</b> the pointer rests over the plot of both charts, then 20 isolated full renders are triggered (invalidateElement(), then 6 idle frames). Per full render the demo counts DOM-only renders (SciChartRenderer.renderDomOnly), tooltip SVG creations (CursorTooltipSvgAnnotation.create) and update() calls. <b>Pointer moving:</b> 90 frames with one pointermove per frame along a chord above the centre of the polar chart (so the radial and circular cursor lines move on every step); it counts series hit tests (PolarCursorModifier.hitTestRenderableSeries) and update() calls per move.</p><p><b>A/B:</b> both phases run again with the issue's fix applied at runtime: update() moved from onParentSurfaceRendered to onParentSurfaceLayoutComplete, pointer moves only invalidate when the radial/circular lines exist, and the tooltip template uses a filter id that is stable per annotation. Everything is restored afterwards.</p>",
};

async function demo(P) {
  const { NumericAxis, NumberRange, FastLineRenderableSeries, XyDataSeries, CursorModifier, SciChartPolarSurface, PolarNumericAxis, EPolarAxisMode, PolarLineRenderableSeries, PolarCursorModifier, CursorTooltipSvgAnnotation, SciChartRenderer, defaultCursorTooltipSvgTemplate } = P.SciChart;
  const SERIES = 8, RENDERS = 20, MOVES = 90;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7"];
  const xs = Array.from({ length: 181 }, (_, i) => i * 2);

  // Cartesian control chart (also tells the harness which renderer is active).
  const { sciChartSurface: cart, wasmContext } = await P.createSurface("cart");
  cart.xAxes.add(new NumericAxis(wasmContext));
  cart.yAxes.add(new NumericAxis(wasmContext));
  for (let k = 0; k < SERIES; k++) {
    cart.renderableSeries.add(new FastLineRenderableSeries(wasmContext, {
      dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => k + 1 + 0.15 * Math.sin(x / 20)), isSorted: true, containsNaN: false }),
      stroke: COLORS[k], strokeThickness: 1,
    }));
  }
  const cartCursor = new CursorModifier({ showTooltip: true });
  cart.chartModifiers.add(cartCursor);

  // Polar chart: 8 rings, radial range 0..9.
  const { sciChartSurface: polar } = await SciChartPolarSurface.create("polar");
  polar.xAxes.add(new PolarNumericAxis(wasmContext, { polarAxisMode: EPolarAxisMode.Angular, visibleRange: new NumberRange(0, 360) }));
  polar.yAxes.add(new PolarNumericAxis(wasmContext, { polarAxisMode: EPolarAxisMode.Radial, visibleRange: new NumberRange(0, 9) }));
  for (let k = 0; k < SERIES; k++) {
    polar.renderableSeries.add(new PolarLineRenderableSeries(wasmContext, {
      dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => k + 1 + 0.15 * Math.sin(x / 20)), isSorted: true, containsNaN: false }),
      stroke: COLORS[k], strokeThickness: 1,
    }));
  }
  const polarCursor = new PolarCursorModifier({ showTooltip: true });
  polar.chartModifiers.add(polarCursor);
  await P.sleep(800);

  // ---- counters
  const who = (surface) => (surface === polar ? "polar" : surface === cart ? "cartesian" : null);
  P.hookMethod(SciChartRenderer.prototype, "render", { name: "render", onCall: (a, self) => { const w = who(self.sciChartSurface); if (w) P.count(`${w}: full renders`); } });
  P.hookMethod(SciChartRenderer.prototype, "renderDomOnly", { name: "renderDomOnly", onCall: (a, self) => { const w = who(self.sciChartSurface); if (w) P.count(`${w}: DOM-only renders`); } });
  P.hookMethod(CursorTooltipSvgAnnotation.prototype, "create", { name: "tooltip create", onCall: (a, self) => {
    if (self.cursorModifier === polarCursor) P.count("polar: tooltip SVG created");
    else if (self.cursorModifier === cartCursor) P.count("cartesian: tooltip SVG created");
  } });
  const PCM = PolarCursorModifier.prototype;
  let updateMs = 0;
  const shippedUpdate = PCM.update;
  PCM.update = function () { const t0 = P.now(); try { return shippedUpdate.apply(this, arguments); } finally { updateMs += P.now() - t0; P.count("polar: update()"); } };
  P.hookMethod(CursorModifier.prototype, "update", { name: "cartesian: update()" });
  P.hookMethod(PCM, "hitTestRenderableSeries", { name: "polar: series hit tests" });

  const polarPtr = P.pointer(polar), cartPtr = P.pointer(cart);
  const REST_X = 0.62, REST_Y = 0.5; // inside the rings, right of the centre

  async function atRest(label) {
    polarPtr.enter(REST_X, REST_Y);
    cartPtr.enter(0.5, 0.5);
    await P.idleFrames(10);
    const hitSeries = (polarCursor.tooltipAnnotation.seriesInfos || []).filter((si) => si.isHit).length;
    const cartHitSeries = (cartCursor.tooltipAnnotation.seriesInfos || []).filter((si) => si.isHit).length;
    const r = await P.during(async () => {
      for (let i = 0; i < RENDERS; i++) {
        polar.invalidateElement();
        cart.invalidateElement();
        await P.idleFrames(6);
      }
    });
    const per = (name, renders) => r.total(name) / Math.max(1, renders);
    const pr = r.total("polar: full renders"), cr = r.total("cartesian: full renders");
    const res = {
      hitSeries, cartHitSeries,
      polarRenders: pr, polarDomOnly: per("polar: DOM-only renders", pr), polarCreates: per("polar: tooltip SVG created", pr), polarUpdates: per("polar: update()", pr),
      cartRenders: cr, cartDomOnly: per("cartesian: DOM-only renders", cr), cartCreates: per("cartesian: tooltip SVG created", cr), cartUpdates: per("cartesian: update()", cr),
    };
    P.log(`${label}, pointer at rest: ${JSON.stringify(res)}`);
    polarPtr.leave();
    cartPtr.leave();
    await P.idleFrames(5);
    return res;
  }
  // A chord above the centre, inside the rings: every move changes both the angle and the radius,
  // so the radial and circular cursor lines move on every step.
  const chordX = (i) => { const k = (i % 30) / 30; return 0.32 + 0.36 * (k < 0.5 ? k * 2 : 2 - k * 2); };
  const CHORD_Y = 0.38;
  async function moving(label) {
    polarPtr.enter(chordX(0), CHORD_Y);
    await P.idleFrames(5);
    updateMs = 0;
    const r = await P.frames(MOVES, (i) => polarPtr.move(chordX(i), CHORD_Y));
    const res = {
      hitTestsPerMove: r.perFrame("polar: series hit tests"),
      updatesPerMove: r.perFrame("polar: update()"),
      rendersPerMove: r.perFrame("polar: full renders"),
      domOnlyPerMove: r.perFrame("polar: DOM-only renders"),
      updateMsPerMove: updateMs / MOVES,
      p95: r.frameP95,
    };
    P.log(`${label}, pointer moving: ${JSON.stringify(res)}`);
    polarPtr.leave();
    await P.idleFrames(5);
    return res;
  }

  P.status("Pointer at rest, isolated full renders, library as shipped…");
  const restShipped = await atRest("as shipped");
  P.status("Pointer moving over the polar chart, library as shipped…");
  const moveShipped = await moving("as shipped");

  // ---- the fix from the issue
  const shipped = { rendered: PCM.onParentSurfaceRendered, layoutOwn: Object.prototype.hasOwnProperty.call(PCM, "onParentSurfaceLayoutComplete"), layout: PCM.onParentSurfaceLayoutComplete, move: PCM.modifierMouseMove };
  PCM.onParentSurfaceRendered = function () {};
  PCM.onParentSurfaceLayoutComplete = function () { this.update(); }; // like CursorModifier: before invalidation is re-armed
  PCM.modifierMouseMove = function (args) {
    if (!(this.radialAnnotation || this.circularAnnotation)) return shipped.move.call(this, args);
    // radial/circular lines are render-context annotations: a full render follows and runs update() once
    const surface = this.parentSurface;
    this.update = function () { surface.invalidateElement(); };
    try { return shipped.move.call(this, args); } finally { delete this.update; }
  };
  const tooltip = polarCursor.tooltipAnnotation;
  const shippedTemplate = tooltip.tooltipSvgTemplate;
  tooltip.tooltipSvgTemplate = (seriesInfos, svgAnnotation) => defaultCursorTooltipSvgTemplate(seriesInfos, svgAnnotation).replace(/id_\d+/g, `id_${svgAnnotation.id}`);

  P.status("Pointer at rest, isolated full renders, with the fix…");
  const restFixed = await atRest("with fix");
  P.status("Pointer moving over the polar chart, with the fix…");
  const moveFixed = await moving("with fix");
  PCM.onParentSurfaceRendered = shipped.rendered;
  if (shipped.layoutOwn) PCM.onParentSurfaceLayoutComplete = shipped.layout; else delete PCM.onParentSurfaceLayoutComplete;
  PCM.modifierMouseMove = shipped.move;
  PCM.update = shippedUpdate;
  tooltip.tooltipSvgTemplate = shippedTemplate;

  const scenarioOk = restShipped.hitSeries > 0 && restFixed.hitSeries > 0;
  const reproduced = scenarioOk && restShipped.polarDomOnly >= 0.8 && restFixed.polarDomOnly <= 0.1
    && moveShipped.hitTestsPerMove >= 1.8 * SERIES && moveFixed.hitTestsPerMove <= 1.1 * SERIES;
  P.report({
    verdict: !scenarioOk ? "inconclusive" : reproduced ? "reproduced" : "not-reproduced",
    headline: !scenarioOk
      ? "The resting pointer did not hit any polar series, so the default template returned its constant empty SVG; move REST_X/REST_Y onto a ring and run again."
      : reproduced
        ? `With the pointer at rest, each full render of the polar chart is followed by ${restShipped.polarDomOnly.toFixed(2)} DOM-only frames that re-create the tooltip (${restShipped.polarCreates.toFixed(1)} tooltip SVGs per render; the cartesian CursorModifier: ${restShipped.cartDomOnly.toFixed(2)} and ${restShipped.cartCreates.toFixed(1)}). Each pointer move hit-tests the ${SERIES} series ${(moveShipped.hitTestsPerMove / SERIES).toFixed(1)} times. With the fix: ${restFixed.polarDomOnly.toFixed(2)} extra frames, ${(moveFixed.hitTestsPerMove / SERIES).toFixed(1)} hit-test passes per move.`
        : `Expected one DOM-only frame per full render and two hit-test passes per move; measured ${restShipped.polarDomOnly.toFixed(2)} and ${(moveShipped.hitTestsPerMove / SERIES).toFixed(2)} (with the fix: ${restFixed.polarDomOnly.toFixed(2)} and ${(moveFixed.hitTestsPerMove / SERIES).toFixed(2)}).`,
    columns: ["Polar, as shipped", "Polar, with fix", "Cartesian CursorModifier (control)"],
    rows: [
      ["Pointer at rest: series hit at the resting point", restShipped.hitSeries, restFixed.hitSeries, restShipped.cartHitSeries],
      ["  full renders triggered", restShipped.polarRenders, restFixed.polarRenders, restShipped.cartRenders],
      ["  extra DOM-only renders per full render", restShipped.polarDomOnly, restFixed.polarDomOnly, restShipped.cartDomOnly],
      ["  tooltip SVG creations per full render", restShipped.polarCreates, restFixed.polarCreates, restShipped.cartCreates],
      ["  cursor update() calls per full render", restShipped.polarUpdates, restFixed.polarUpdates, restShipped.cartUpdates],
      [`Pointer moving: series hit tests per move (${SERIES} series)`, moveShipped.hitTestsPerMove, moveFixed.hitTestsPerMove, null],
      ["  update() calls per move", moveShipped.updatesPerMove, moveFixed.updatesPerMove, null],
      ["  full renders per move", moveShipped.rendersPerMove, moveFixed.rendersPerMove, null],
      ["  DOM-only renders per move", moveShipped.domOnlyPerMove, moveFixed.domOnlyPerMove, null],
      ["  time in update() per move, ms", moveShipped.updateMsPerMove, moveFixed.updateMsPerMove, null],
      ["  frame interval p95, ms", moveShipped.p95, moveFixed.p95, null],
    ],
    notes: [
      "Counts do not depend on hardware; times do. A DOM-only render tears down and re-parses the tooltip SVG (with a new filter id) and repaints it, one animation frame after the full render. While the pointer keeps moving (or data arrives before every frame), the next full invalidation usually cancels that frame, which is why the moving phase shows few DOM-only renders; the extra frame lands whenever a full render is not followed by another full invalidation before the next frame: after the pointer stops, or after an occasional data update under a resting pointer, as here.",
      "Polar line hit tests loop over every point in JavaScript (PolarLineSeriesHitTestProvider), so the second pass per move costs as much as the first. The control shows the same template's Date.now() id without the extra frame: CursorModifier updates in onParentSurfaceLayoutComplete, before invalidation is re-armed.",
    ],
    metrics: { restShipped, restFixed, moveShipped, moveFixed, series: SERIES },
  });
}
