const META = {
  id: "017",
  title: "MetadataPaletteProvider re-parses the same color strings for every point on every render",
  issue: "issues/017-parsecolor-uncached-per-point-palette.md",
  severity: "high",
  claim: "parseColorToUIntArgb has no cache, and MetadataPaletteProvider has no shouldUpdatePalette, so a scatter series with string colors in its metadata parses two color strings (regex match, substr, 4-5 parseInt, string building) per point on every render, including pan frames with no data change.",
  method: "<p>One XyScatterRenderableSeries (25,000 points, all visible) with <code>paletteProvider: new MetadataPaletteProvider()</code>; each point's metadata holds a stroke and a fill color string taken from 8 hex colors. The X axis pans a little every frame for 60 frames; no data changes. <code>parseColorToUIntArgb</code> is a module-internal function and cannot be wrapped, so the demo counts what it does: calls of <code>String.prototype.match</code> with the parser's hex-color regex (one per parse) and calls of the global <code>parseInt</code>. It also counts <code>overridePointMarkerArgb</code> calls. A second pass of 60 frames per variant, with the per-parse counters removed, times <code>applyStrokeFillPaletting</code> (the per-point palette loop).</p><p>A/B: (1) <code>overridePointMarkerArgb</code> patched to memoize the parsed number per color string (the effect of the issue's cache in <code>parseColorToUIntArgb</code>); (2) the original code with the issue's app-side workaround, numeric ARGB colors in metadata (parsed once).</p>",
};

async function demo(P) {
  const { NumericAxis, XyDataSeries, XyScatterRenderableSeries, EllipsePointMarker, MetadataPaletteProvider, PointMarkerDrawingProvider, NumberRange, parseColorToUIntArgb } = P.SciChart;
  const POINTS = 25000, FRAMES = 60;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7"];

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  const xAxis = new NumericAxis(wasmContext, { visibleRange: new NumberRange(-10, 110) });
  sciChartSurface.xAxes.add(xAxis);
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { visibleRange: new NumberRange(-1.2, 1.2) }));

  // Deterministic pseudo-random scatter in x 0..100, y -1..1, sorted by x.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const xs = [], ys = [], metadata = [], strokeIdx = [];
  for (let i = 0; i < POINTS; i++) {
    xs.push((i / POINTS) * 100);
    ys.push(Math.sin(i / 900) * 0.6 + (rnd() - 0.5) * 0.7);
    const k = Math.floor(rnd() * COLORS.length);
    strokeIdx.push(k);
    metadata.push({ isSelected: false, stroke: COLORS[k], fill: COLORS[(k + 3) % COLORS.length] });
  }
  const dataSeries = new XyDataSeries(wasmContext, { xValues: xs, yValues: ys, metadata, isSorted: true, containsNaN: false });
  sciChartSurface.renderableSeries.add(new XyScatterRenderableSeries(wasmContext, {
    dataSeries,
    pointMarker: new EllipsePointMarker(wasmContext, { width: 5, height: 5, strokeThickness: 1, stroke: "#333333", fill: "#999999" }),
    paletteProvider: new MetadataPaletteProvider(),
  }));
  await P.sleep(500);

  // Variants: the shipped provider, a provider that memoizes parsed colors, and numeric colors in metadata.
  const mpp = MetadataPaletteProvider.prototype;
  const markerArgb = mpp.overridePointMarkerArgb;
  const cache = new Map();
  const cachedParse = (c) => { let v = cache.get(c); if (v === undefined) { v = parseColorToUIntArgb(c); cache.set(c, v); } return v; };
  const cachedMarkerArgb = function (xValue, yValue, index, opacity, md) {
    if (!md) return undefined;
    return { stroke: typeof md.stroke === "string" ? cachedParse(md.stroke) : md.stroke, fill: typeof md.fill === "string" ? cachedParse(md.fill) : md.fill };
  };
  let impl = markerArgb;
  mpp.overridePointMarkerArgb = function () { P.count("overridePointMarkerArgb calls"); return impl.apply(this, arguments); };
  const numeric = COLORS.map((c) => parseColorToUIntArgb(c));
  function setVariant(name) {
    impl = name === "cached" ? cachedMarkerArgb : markerArgb;
    const asNumbers = name === "numeric";
    P.quiet(() => {
      for (let i = 0; i < POINTS; i++) {
        const md = dataSeries.getMetadataAt(i), k = strokeIdx[i], f = (k + 3) % COLORS.length;
        md.stroke = asNumbers ? numeric[k] : COLORS[k];
        md.fill = asNumbers ? numeric[f] : COLORS[f];
      }
    });
  }

  sciChartSurface.rendered.subscribe(() => P.count("renders"));
  // applyStrokeFillPaletting is inherited from BaseSeriesDrawingProvider (not exported by the UMD bundle).
  P.hookMethod(PointMarkerDrawingProvider.prototype, "applyStrokeFillPaletting", { name: "palette loop", time: true });

  async function pan(label) {
    await P.idleFrames(3);
    const r = await P.frames(FRAMES, (i) => { const d = 5 * Math.sin(i / 6); xAxis.visibleRange = new NumberRange(-10 + d, 110 + d); });
    const renders = Math.max(1, r.total("renders"));
    const res = {
      renders: r.total("renders"),
      markers: r.total("overridePointMarkerArgb calls") / renders,
      parses: r.total("color-string parses") / renders,
      parseInts: r.total("parseInt calls") / renders,
      loopMs: r.total("palette loop", "t") / renders,
      p95: r.frameP95,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  // Pass 1: counts. String.match with the parser's hex regex = one color parse.
  const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.source;
  const undoMatch = P.hookMethod(String.prototype, "match", { name: "String.match (all)", onCall: (a) => { if (a[0] instanceof RegExp && a[0].source === HEX_RE) P.count("color-string parses"); } });
  const undoParseInt = P.hookMethod(window, "parseInt", { name: "parseInt calls" });
  const counts = {}, times = {};
  for (const v of ["shipped", "cached", "numeric"]) {
    P.status(`Panning (counting), ${v}…`);
    setVariant(v);
    counts[v] = await pan(`counts, ${v}`);
  }
  undoMatch();
  undoParseInt();
  // Pass 2: timing, without the per-parse hooks.
  for (const v of ["shipped", "cached", "numeric"]) {
    P.status(`Panning (timing), ${v}…`);
    setVariant(v);
    times[v] = await pan(`timing, ${v}`);
  }
  setVariant("shipped");
  mpp.overridePointMarkerArgb = markerArgb;
  const sameColors = COLORS.every((c, k) => cachedParse(c) === parseColorToUIntArgb(c) && numeric[k] === parseColorToUIntArgb(c));

  const s = counts.shipped, c = counts.cached, n = counts.numeric;
  const reproduced = s.renders >= FRAMES * 0.5 && s.markers >= POINTS * 0.9 && s.parses >= 1.8 * s.markers
    && c.parses <= 0.01 * c.markers + 4 && n.parses <= 0.01 * n.markers + 4;
  const per = (r) => r.parses / Math.max(1, r.markers);
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Every pan frame parses ${Math.round(s.parses).toLocaleString("en-US")} color strings for ${Math.round(s.markers).toLocaleString("en-US")} markers (${COLORS.length} distinct colors, no data change). With a parse cache: ${Math.round(c.parses)}; with numeric metadata: ${Math.round(n.parses)}.`
      : `Expected about 2 color parses per visible marker per render; measured ${s.parses.toFixed(0)} parses for ${s.markers.toFixed(0)} markers.`,
    columns: ["As shipped", "With parse cache", "Numeric metadata"],
    rows: [
      ["Renders (counting pass)", s.renders, c.renders, n.renders],
      ["overridePointMarkerArgb calls per render", s.markers, c.markers, n.markers],
      ["Color-string parses per render (hex regex matches)", s.parses, c.parses, n.parses],
      ["Color parses per marker per render", per(s), per(c), per(n)],
      ["parseInt calls per render", s.parseInts, c.parseInts, n.parseInts],
      ["Time in the palette loop per render, ms (timing pass)", times.shipped.loopMs, times.cached.loopMs, times.numeric.loopMs],
      ["Frame interval p95, ms (timing pass)", times.shipped.p95, times.cached.p95, times.numeric.p95],
    ],
    notes: [
      `Data and colors do not change during the pan; the palette loop still runs for every visible point on every render because MetadataPaletteProvider defines no shouldUpdatePalette. The few parses left per render in the right-hand columns are the series-level point-marker stroke and fill. Cached, numeric and library colors identical for all ${COLORS.length} colors: ${sameColors ? "yes" : "no"}.`,
      "Counts do not depend on hardware; times do. The timing pass has no per-parse hooks; it keeps one counting wrapper per marker call, the same in every column.",
    ],
    metrics: { counts, times, points: POINTS, colors: COLORS.length, sameColors },
  });
}
