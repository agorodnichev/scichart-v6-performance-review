const META = {
  id: "043",
  title: "The resampling cache key is rebuilt per series per frame: JSON.stringify plus split(\"\") and a callback per character",
  issue: "issues/043-resampling-hash-json-split-per-frame.md",
  severity: "medium",
  claim: "Every render, each resampled series (every FIFO series) recomputes its resampling hash: JSON.stringify of the ResamplingParams object, then generateHash splits that string, the series id and three numbers into one-character arrays and folds them with a reduce callback per character. All of it is short-lived garbage, every frame, for every series.",
  method: "<p>50 FIFO line series on one surface (<code>fifoCapacity: 1,000</code>; FIFO forces resampling), each receiving one point per frame for 60 frames. The demo wraps <code>ExtremeResamplerHelper.calculateResamplingHash</code> (counted and timed) and, only while it runs, counts <code>JSON.stringify</code> calls and output characters, and <code>String.prototype.split(\"\")</code> calls and the array entries they create (one reduce callback runs per entry).</p><p>A/B: the issue's fix applied at runtime: <code>hashUtils.generateHash</code> (and the three helpers that call it internally) replaced by a plain loop over <code>charCodeAt</code> that returns the same values. The whole-object <code>JSON.stringify</code> key stays, as the issue intends. Before the runs, old and new hash functions are compared on 2,000 strings, including the real JSON keys.</p>",
};

async function demo(P) {
  const { NumericAxis, XyDataSeries, FastLineRenderableSeries, ExtremeResamplerHelper, hashUtils, EAutoRange } = P.SciChart;
  const SERIES = 50, CAP = 1000, FRAMES = 60;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"];

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
  let t = 0;
  const series = [];
  for (let s = 0; s < SERIES; s++) {
    const xs = new Float64Array(CAP), ys = new Float64Array(CAP);
    for (let i = 0; i < CAP; i++) { xs[i] = i; ys[i] = Math.sin(i / 50 + s) + s * 0.2; }
    const ds = new XyDataSeries(wasmContext, { fifoCapacity: CAP, xValues: xs, yValues: ys, isSorted: true, containsNaN: false });
    series.push(ds);
    sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries: ds, stroke: COLORS[s % COLORS.length], strokeThickness: 1 }));
  }
  t = CAP;
  await P.sleep(500);

  // Original and fixed hash functions; check that they agree.
  const orig = { ...hashUtils };
  const loopHash = (str) => { let a = 0; for (let i = 0; i < str.length; i++) a = ((a << 5) - a + str.charCodeAt(i)) | 0; return a; };
  const fixedUtils = {
    generateHash: loopHash,
    generateObjectHash: (obj) => loopHash(JSON.stringify(obj)),
    generateBooleanHash: (v) => loopHash(v === false ? "0" : v === true ? "1" : "-1"),
    generateNumberHash: (v) => loopHash(v.toString(10)),
  };
  let mismatches = 0, checked = 0;
  const samples = [];
  sciChartSurface.renderableSeries.asArray().slice(0, 3).forEach((rs) => samples.push(rs.dataSeries.id));
  const seen = [];
  const capture = ExtremeResamplerHelper.calculateResamplingHash;
  ExtremeResamplerHelper.calculateResamplingHash = function (rs, rp) { if (seen.length < 5) seen.push(JSON.stringify(rp)); return capture.apply(this, arguments); };
  for (let k = 0; k < 3; k++) { for (const ds of series) ds.append(t, Math.sin(t / 50)); t++; await P.idleFrames(2); } // renders happen only on data change
  ExtremeResamplerHelper.calculateResamplingHash = capture;
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 2000; i++) {
    let str = "";
    const len = Math.floor(rnd() * 400);
    for (let k = 0; k < len; k++) str += String.fromCharCode(rnd() < 0.9 ? 32 + Math.floor(rnd() * 95) : Math.floor(rnd() * 0xd7ff));
    samples.push(str);
  }
  samples.push(...seen, "", "0", "1", "-1", "123456789");
  samples.forEach((str) => { checked++; if (orig.generateHash(str) !== loopHash(str)) mismatches++; });
  const keyLength = seen.length ? seen[0].length : 0;
  P.log(`hash check: ${checked} strings, ${mismatches} mismatches; a ResamplingParams key is ${keyLength} characters`);

  // Counters, attributed to calculateResamplingHash.
  sciChartSurface.rendered.subscribe(() => P.count("renders"));
  let inside = false;
  const calc = ExtremeResamplerHelper.calculateResamplingHash;
  ExtremeResamplerHelper.calculateResamplingHash = function () {
    inside = true;
    const t0 = P.now();
    try { return calc.apply(this, arguments); } finally { inside = false; P.count("calculateResamplingHash", 1); P.count("hash time x1000", Math.round((P.now() - t0) * 1000)); }
  };
  P.hookMethod(JSON, "stringify", { name: "JSON.stringify (all)", onCall: (a, self, ret) => { if (inside) P.count("JSON.stringify in hash", 1, typeof ret === "string" ? ret.length : 0); } });
  P.hookMethod(String.prototype, "split", { name: "String.split (all)", onCall: (a, self, ret) => { if (inside && a[0] === "") P.count("split('') in hash", 1, ret.length); } });

  async function stream(label) {
    const r = await P.frames(FRAMES, () => { for (const ds of series) ds.append(t, Math.sin(t / 50)); t++; });
    const renders = Math.max(1, r.total("renders")), hashes = Math.max(1, r.total("calculateResamplingHash"));
    const res = {
      renders: r.total("renders"),
      hashesPerRender: r.total("calculateResamplingHash") / renders,
      stringifyPerHash: r.total("JSON.stringify in hash") / hashes,
      jsonCharsPerHash: r.total("JSON.stringify in hash", "bytes") / hashes,
      splitsPerHash: r.total("split('') in hash") / hashes,
      entriesPerHash: r.total("split('') in hash", "bytes") / hashes,
      hashUsPerRender: r.total("hash time x1000") / renders,
      p95: r.frameP95,
    };
    res.entriesPerRender = res.entriesPerHash * res.hashesPerRender;
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Streaming 50 FIFO series, as shipped…");
  const shipped = await stream("as shipped");
  Object.assign(hashUtils, fixedUtils);
  P.status("Streaming 50 FIFO series, with the loop-based hash…");
  const fixed = await stream("with loop hash");
  Object.assign(hashUtils, orig);
  ExtremeResamplerHelper.calculateResamplingHash = calc;

  const reproduced = shipped.renders >= FRAMES * 0.5 && shipped.hashesPerRender >= SERIES * 0.9 && shipped.stringifyPerHash >= 0.9
    && keyLength > 0 && shipped.entriesPerHash >= 0.9 * keyLength && fixed.splitsPerHash === 0 && mismatches === 0;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Every render recomputes ${shipped.hashesPerRender.toFixed(0)} resampling hashes (one per FIFO series): each runs JSON.stringify (${shipped.jsonCharsPerHash.toFixed(0)} characters) and ${shipped.splitsPerHash.toFixed(0)} split("") calls creating ${shipped.entriesPerHash.toFixed(0)} one-character strings, ${Math.round(shipped.entriesPerRender).toLocaleString("en-US")} per render. With the loop hash: ${fixed.entriesPerRender.toFixed(0)} entries, same hash values.`
      : `Expected one JSON.stringify and about ${keyLength} split("") entries per series per render; measured ${shipped.hashesPerRender.toFixed(1)} hashes per render, ${shipped.stringifyPerHash.toFixed(2)} stringify and ${shipped.entriesPerHash.toFixed(0)} entries per hash.`,
    columns: ["As shipped", "Loop hash (fix)"],
    rows: [
      ["Renders", shipped.renders, fixed.renders],
      ["calculateResamplingHash calls per render (" + SERIES + " FIFO series)", shipped.hashesPerRender, fixed.hashesPerRender],
      ["JSON.stringify calls per hash", shipped.stringifyPerHash, fixed.stringifyPerHash],
      ["JSON characters produced per hash", shipped.jsonCharsPerHash, fixed.jsonCharsPerHash],
      ["split(\"\") calls per hash", shipped.splitsPerHash, fixed.splitsPerHash],
      ["One-character array entries (and reduce callbacks) per hash", shipped.entriesPerHash, fixed.entriesPerHash],
      ["… per render, all series", shipped.entriesPerRender, fixed.entriesPerRender],
      ["Time in calculateResamplingHash per render, µs", shipped.hashUsPerRender, fixed.hashUsPerRender],
      ["Frame interval p95, ms", shipped.p95, fixed.p95],
    ],
    notes: [
      `Hash check: the loop-based generateHash returns the same value as the shipped one for ${checked} strings (random ASCII and BMP, and real ResamplingParams keys): ${mismatches} mismatches.`,
      "The JSON.stringify key is kept by the fix on purpose (TableDataSeries notes that hand-listed fields caused stale caches), so one ~" + Math.round(shipped.jsonCharsPerHash) + "-character string per series per render remains in both columns.",
      "Counts do not depend on hardware; times do and include the counting hooks. The absolute cost is small per series; it scales with the number of resampled series.",
    ],
    metrics: { shipped, fixed, series: SERIES, keyLength, mismatches, checked },
  });
}
