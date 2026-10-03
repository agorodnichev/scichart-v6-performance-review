const META = {
  id: "087",
  title: "With a painted listener, each surface creates a new MessageChannel every frame and never closes its ports",
  issue: "issues/087-painted-event-new-messagechannel-per-frame.md",
  severity: "low",
  claim: "While surface.painted has a subscriber, onRenderSurfaceDraw calls runAfterFramePaint on every rendered frame, and runAfterFramePaint creates a new MessageChannel, starts port1 with onmessage and posts on port2, without closing either port. That is one channel (two entangled, started ports) per surface per frame, released only by garbage collection.",
  method: "<p>Four create() charts, each receiving one appended point per frame, 60 frames per run. The harness replaces window.MessageChannel with a counting proxy; MessagePort.prototype.close and postMessage are counted too. Runs: (1) no painted subscribers (control); (2) a painted handler on each chart; (3) the app-side workaround from the issue: the painted handlers removed, a rendered handler on each chart posts to one MessageChannel owned by the page, whose onmessage plays the role of the painted callback. Callbacks delivered per frame are counted in runs 2 and 3 to show the workaround delivers the same after-paint signal.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, EAutoRange } = P.SciChart;
  const CHARTS = 4, FRAMES = 60;
  const charts = [];
  for (let i = 0; i < CHARTS; i++) {
    const { sciChartSurface, wasmContext } = await P.createSurface(`chart${i}`);
    sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
    sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
    const ds = new XyDataSeries(wasmContext, { fifoCapacity: 300, isSorted: true, containsNaN: false });
    for (let x = 0; x < 300; x++) ds.append(x, Math.sin(x / 20 + i));
    sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries: ds, stroke: "#4e79a7", strokeThickness: 2 }));
    charts.push({ surface: sciChartSurface, ds, x: 300 });
  }
  const step = () => charts.forEach((c, i) => { c.x++; c.ds.append(c.x, Math.sin(c.x / 20 + i)); });
  await P.sleep(500);

  P.watch.timers(); // counts "new MessageChannel"
  P.hookMethod(MessagePort.prototype, "close", { name: "MessagePort.close" });
  P.hookMethod(MessagePort.prototype, "postMessage", { name: "MessagePort.postMessage" });

  async function run(label) {
    await P.frames(5, step);
    const r = await P.frames(FRAMES, step);
    await P.sleep(50); // let the last after-paint tasks run
    const res = {
      channels: r.perFrame("new MessageChannel"),
      posts: r.perFrame("MessagePort.postMessage"),
      closes: r.perFrame("MessagePort.close"),
      callbacks: r.perFrame("after-paint callbacks delivered"),
      renders: r.perFrame("renders"),
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }
  charts.forEach((c) => c.surface.rendered.subscribe(() => P.count("renders")));

  P.status("Streaming with no painted subscribers…");
  const none = await run("no painted subscribers");

  const onPainted = () => P.count("after-paint callbacks delivered");
  charts.forEach((c) => c.surface.painted.subscribe(onPainted));
  P.status("Streaming with a painted handler on each chart…");
  const painted = await run("painted subscribed");
  charts.forEach((c) => c.surface.painted.unsubscribe(onPainted));

  // Workaround: rendered + one app-owned channel
  const appChannel = new MessageChannel();
  appChannel.port1.onmessage = () => P.count("after-paint callbacks delivered");
  const onRendered = () => appChannel.port2.postMessage(undefined);
  charts.forEach((c) => c.surface.rendered.subscribe(onRendered));
  P.status("Streaming with rendered + one app-owned MessageChannel…");
  const workaround = await run("workaround");
  charts.forEach((c) => c.surface.rendered.unsubscribe(onRendered));
  appChannel.port1.close(); appChannel.port2.close();

  const reproduced = painted.channels >= 0.9 * painted.renders && painted.renders >= 0.9 * CHARTS && painted.closes === 0 && none.channels <= 0.05 && workaround.channels <= 0.05 && workaround.callbacks >= 0.9 * painted.callbacks;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `With a painted handler on ${CHARTS} streaming charts, every frame creates ${painted.channels.toFixed(1)} new MessageChannels (${(painted.channels * 2).toFixed(0)} ports, ${(painted.channels * 60).toFixed(0)} channels per second at 60 Hz) and closes ${painted.closes.toFixed(0)} ports. Without painted subscribers: ${none.channels.toFixed(1)}. With rendered + one app-owned channel: ${workaround.channels.toFixed(1)} new channels for the same ${workaround.callbacks.toFixed(1)} callbacks per frame.`
      : `Expected one new MessageChannel per rendered chart per frame with painted subscribed; measured ${painted.channels.toFixed(2)} per frame for ${painted.renders.toFixed(2)} renders (closes ${painted.closes.toFixed(2)}).`,
    columns: ["No painted subscriber", "painted subscribed", "rendered + one app channel"],
    rows: [
      ["Renders per frame", none.renders, painted.renders, workaround.renders],
      ["new MessageChannel per frame", none.channels, painted.channels, workaround.channels],
      ["MessagePort.postMessage per frame", none.posts, painted.posts, workaround.posts],
      ["MessagePort.close per frame", none.closes, painted.closes, workaround.closes],
      ["After-paint callbacks delivered per frame", none.callbacks, painted.callbacks, workaround.callbacks],
      ["Frame interval p95, ms", none.p95, painted.p95, workaround.p95],
    ],
    notes: [
      "Counts do not depend on hardware. Each channel holds two started, entangled ports until garbage collection collects both, so the cost is allocation and GC churn per frame rather than an unbounded leak; this page does not measure the heap.",
      "The library itself never subscribes to painted; the path is taken when an app or a tool subscribes, or when PerformanceDebugHelper.enableDebug is true.",
    ],
    metrics: { none, painted, workaround, charts: CHARTS },
  });
}
