const META = {
  id: "066",
  title: "getFont walks the global label-style registry with for-in on every call (per text element, per frame)",
  issue: "issues/066-getfontkey-linear-style-registry-scan-per-getfont.md",
  severity: "medium",
  claim: "getFontKey turns {family, size, extras} into an id with labelCache.getStyleId, a for-in walk over every style ever registered (entries are only removed by resetCache). Every getFont call (each NativeTextAnnotation, axis, title, data label, every frame) pays that walk, which grows with the registry.",
  method: "<p>One chart with 300 NativeTextAnnotations and a streaming line series (one point per frame, so it redraws every frame). The demo wraps labelCache.getStyleId (an exported object) and, while it runs, counts Object.prototype.hasOwnProperty calls: getStyleId calls styleCache.hasOwnProperty(key) once per registry entry it visits, so this is the exact length of each walk. It also reads the registry size from that object. Four runs of 40 frames:</p><ol><li>the registry as the page created it;</li><li>after the registry has grown by 30 entries (one axis is given 30 distinct label colours in turn; every distinct label style ever used stays registered, as the styles of other charts in a dashboard would);</li><li>after the annotations switch to a font size not used before, so their font key is registered after the 30 new entries (as for any text style first used late in a session);</li><li>run 3 with the fix from the issue emulated at runtime: font-key lookups (providerId undefined) are answered from a Map keyed by family|size|extras, which returns the same ids without walking the registry.</li></ol>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, NativeTextAnnotation, EAutoRange, NumberRange, labelCache } = P.SciChart;
  const ANNOTATIONS = 300, FRAMES = 40, EXTRA_STYLES = 30;

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  const yAxis = new NumericAxis(wasmContext, { visibleRange: new NumberRange(0, 10), autoRange: EAutoRange.Never });
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
  sciChartSurface.yAxes.add(yAxis);
  const ds = new XyDataSeries(wasmContext, { fifoCapacity: 300, isSorted: true, containsNaN: false });
  for (let x = 0; x < 300; x++) ds.append(x, 5 + 3 * Math.sin(x / 25));
  sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries: ds, stroke: "#4e79a7", strokeThickness: 2 }));
  const annotations = [];
  for (let i = 0; i < ANNOTATIONS; i++) {
    const a = new NativeTextAnnotation({ x1: (i * 37) % 300, y1: 0.3 + ((i * 7) % 95) / 10, text: `t${i}`, fontSize: 12, textColor: "#59a14f" });
    sciChartSurface.annotations.add(a);
    annotations.push(a);
  }
  await P.sleep(700);

  // --- instrumentation ---------------------------------------------------------------
  let inScan = false, visited = 0, styleCache = null, scanMs = 0, fontKeyCalls = 0;
  const ohp = Object.prototype.hasOwnProperty;
  // getStyleId calls styleCache.hasOwnProperty(key) once per entry it visits; `this` is the registry itself.
  Object.prototype.hasOwnProperty = function (k) {
    if (inScan) { visited++; if (!styleCache) styleCache = this; }
    return ohp.call(this, k);
  };
  const shippedGetStyleId = labelCache.getStyleId;
  let impl = shippedGetStyleId;
  const isFontKey = (style) => style && style.providerId === undefined && typeof style.extras === "string";
  labelCache.getStyleId = function (style) {
    const fk = isFontKey(style);
    if (!fk) return impl.call(this, style); // label-provider styles: once per style change, not per frame
    inScan = true;
    const v0 = visited, t0 = P.now();
    try { return impl.call(this, style); } finally {
      inScan = false;
      scanMs += P.now() - t0;
      fontKeyCalls++;
      P.count("getStyleId calls from getFontKey");
      P.count("registry entries visited by those calls", visited - v0);
    }
  };
  const registrySize = () => (styleCache ? Object.keys(styleCache).length : NaN);

  let x = 300;
  const step = () => { x++; ds.append(x, 5 + 3 * Math.sin(x / 25)); };
  async function run(label) {
    await P.frames(8, step); // warm-up (registers new font keys)
    scanMs = 0;
    const r = await P.frames(FRAMES, step);
    const calls = r.perFrame("getStyleId calls from getFontKey");
    const res = {
      size: registrySize(),
      calls,
      visitedPerFrame: r.perFrame("registry entries visited by those calls"),
      visitedPerCall: calls ? r.perFrame("registry entries visited by those calls") / calls : 0,
      ms: scanMs / FRAMES,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  let base, grown, late, fixed;
  try {
    P.status("Redrawing with the registry as created…");
    base = await run("registry as created");

    P.status(`Registering ${EXTRA_STYLES} more label styles…`);
    const originalStyle = { ...yAxis.labelStyle };
    for (let i = 0; i < EXTRA_STYLES; i++) {
      const c = (0x204060 + i * 0x050301).toString(16).padStart(6, "0").slice(-6);
      yAxis.labelStyle = { ...originalStyle, color: `#${c}` };
      await P.idleFrames(2);
    }
    yAxis.labelStyle = originalStyle;
    await P.idleFrames(3);
    P.status("Redrawing with the grown registry…");
    grown = await run("grown registry");

    annotations.forEach((a) => { a.fontSize = 13; });
    P.status("Redrawing after a font size first used now…");
    late = await run("font key registered late");

    // The fix from the issue, emulated: font-key styles get an O(1) lookup with the same ids.
    const byKey = new Map();
    impl = function (style) {
      const key = `${style.fontFamily}|${style.fontSize}|${style.extras}`;
      let id = byKey.get(key);
      if (id === undefined) { id = shippedGetStyleId.call(this, style); byKey.set(key, id); }
      return id;
    };
    P.status("Same redraw with a Map lookup for font keys (fix)…");
    await run("fix warm-up (fills the map)");
    fixed = await run("with fix");
  } finally {
    impl = shippedGetStyleId;
    labelCache.getStyleId = shippedGetStyleId;
    Object.prototype.hasOwnProperty = ohp;
  }

  const cols = ["Registry as created", `+${EXTRA_STYLES} styles`, "+ font first used now", "+ Map lookup (fix)"];
  const row = (label, key) => [label, base[key], grown[key], late[key], fixed[key]];
  const reproduced = late.size >= EXTRA_STYLES && late.visitedPerCall >= 0.8 * (late.size - 1) && late.calls >= ANNOTATIONS && fixed.visitedPerFrame <= 0.01 * late.visitedPerFrame;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each getFont call walks the registry: with ${late.size} registered styles and a font first used late, ${late.calls.toFixed(0)} calls per frame visit ${late.visitedPerCall.toFixed(1)} entries each (${late.visitedPerFrame.toFixed(0)} per frame). A Map lookup visits ${fixed.visitedPerFrame.toFixed(0)}. Fonts registered before the registry grew stop after ${grown.visitedPerCall.toFixed(1)} entries.`
      : `Expected a walk of about the registry size (${late.size}) per getFont call for a late font key; measured ${late.visitedPerCall.toFixed(1)} entries per call (${late.calls.toFixed(0)} calls per frame).`,
    columns: cols,
    rows: [
      row("Styles in the global registry", "size"),
      row("getStyleId calls from getFontKey per frame", "calls"),
      row("Registry entries visited per call", "visitedPerCall"),
      row("Registry entries visited per frame", "visitedPerFrame"),
      row("Time in those getStyleId calls per frame, ms", "ms"),
      row("Frame interval p95, ms", "p95"),
    ],
    notes: [
      "Counts do not depend on hardware; times do. The walk stops at the first matching entry, so its length is the position of the font's entry in the registry: a font key registered early (runs 1-2) is found quickly however large the registry is, and one registered late (run 3) visits almost every entry. Before the walk, for-in also collects all integer-like keys of the registry, which the entry count does not include; the time row covers it.",
      "The registry is global (shared by every chart on the page) and keeps every distinct label style and font key until resetCache, so it only grows during a session.",
    ],
    metrics: { base, grown, late, fixed },
  });
}
