const META = {
  id: "085",
  title: "insertRange with metadata rebuilds the whole metadata array; the generator branch reads the global `length`",
  issue: "issues/085-insert-metadata-range-copies-whole-array.md",
  severity: "low",
  claim: "BaseDataSeries.insertMetadataRange builds a new metadata array on every insert from two slices and a concat (about 2n+m slots for n existing and m inserted points) and drops the old n-slot array. When metadata comes from a generator it sizes the new metadata with an undeclared `length`, which resolves to window.length (usually 0), so the metadata falls behind the X values.",
  method: "<p>An XyDataSeries of 300,000 points whose metadata objects carry their own X value, plotted as a line. Ten <code>insertRange(0, 1,000 points, metadata)</code> calls prepend older history. While <code>insertMetadataRange</code> runs, the demo counts <code>Array.prototype.slice</code>/<code>concat</code> calls and the array slots they return, checks whether the series' metadata array was replaced, and times the call. After the inserts it checks that every metadata object still matches the X value at its index.</p><p>Second check: a 1,000-point series with a metadata generator (<code>setMetadataGenerator</code>) gets <code>insertRange(0, 100 points)</code> without metadata; the demo compares the metadata length with <code>count()</code>.</p><p>A/B: the issue's fix applied as a runtime patch of <code>insertMetadataRange</code>: grow the existing array in place and shift the tail with a backward loop; the inserted count is taken from the metadata or, for the generator branch, from the rows the native insert just added (the issue passes <code>xValues.length</code> from <code>insertRangeN</code>; the value is the same).</p>",
};

async function demo(P) {
  const { NumericAxis, XyDataSeries, FastLineRenderableSeries, EAutoRange, vectorToArrayViewF64 } = P.SciChart;
  const N = 300000, M = 1000, INSERTS = 10, GEN_N = 1000, GEN_M = 100;

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
  const yAt = (x) => Math.sin(x / 6000) + 0.3 * Math.sin(x / 211);
  let firstX = 10000000;
  const make = (x0, n) => {
    const xs = new Float64Array(n), ys = new Float64Array(n), md = new Array(n);
    for (let i = 0; i < n; i++) { const x = x0 + i; xs[i] = x; ys[i] = yAt(x); md[i] = { isSelected: false, x }; }
    return { xs, ys, md };
  };
  const init = make(firstX, N);
  const ds = new XyDataSeries(wasmContext, { xValues: init.xs, yValues: init.ys, metadata: init.md, isSorted: true, containsNaN: false });
  sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries: ds, stroke: "#4e79a7", strokeThickness: 1.5 }));
  await P.sleep(500);

  // Counters: slice/concat inside insertMetadataRange.
  const baseProto = Object.getPrototypeOf(XyDataSeries.prototype); // BaseDataSeries (not exported)
  let inside = false;
  P.hookMethod(Array.prototype, "slice", { name: "Array.slice (all)", onCall: (a, self, ret) => { if (inside) P.count("slice in insertMetadataRange", 1, ret.length); } });
  P.hookMethod(Array.prototype, "concat", { name: "Array.concat (all)", onCall: (a, self, ret) => { if (inside) P.count("concat in insertMetadataRange", 1, ret.length); } });
  const shippedInsert = baseProto.insertMetadataRange;
  let impl = shippedInsert;
  baseProto.insertMetadataRange = function () {
    inside = true;
    const t0 = P.now();
    try { return impl.apply(this, arguments); } finally { inside = false; P.count("insertMetadataRange time x1000", Math.round((P.now() - t0) * 1000)); }
  };

  const aligned = (series) => {
    const md = series.metadataProperty, x = vectorToArrayViewF64(series.getNativeXValues(), wasmContext);
    if (!md || md.length !== x.length) return false;
    for (let i = 0; i < x.length; i++) if (!md[i] || md[i].x !== x[i]) return false;
    return true;
  };
  async function prepend(label) {
    let replaced = 0, droppedSlots = 0;
    const totalMs = [];
    const r = await P.during(async () => {
      for (let k = 0; k < INSERTS; k++) {
        firstX -= M;
        const b = make(firstX, M);
        const before = ds.metadataProperty, beforeLen = before.length;
        const t0 = P.now();
        ds.insertRange(0, b.xs, b.ys, b.md);
        totalMs.push(P.now() - t0);
        if (ds.metadataProperty !== before) { replaced++; droppedSlots += beforeLen; }
        await P.nextFrame();
      }
    });
    totalMs.sort((a, b) => a - b);
    const res = {
      sliceCalls: r.total("slice in insertMetadataRange") / INSERTS, concatCalls: r.total("concat in insertMetadataRange") / INSERTS,
      slots: (r.total("slice in insertMetadataRange", "bytes") + r.total("concat in insertMetadataRange", "bytes")) / INSERTS,
      replaced, droppedPerInsert: droppedSlots / INSERTS,
      metaUs: r.total("insertMetadataRange time x1000") / INSERTS, insertMs: totalMs[Math.floor(totalMs.length / 2)],
      n: ds.count(), aligned: aligned(ds),
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }
  async function generatorCheck(label) {
    const xs = new Float64Array(GEN_N), ys = new Float64Array(GEN_N);
    for (let i = 0; i < GEN_N; i++) { xs[i] = 1000 + i; ys[i] = 0; }
    const g = new XyDataSeries(wasmContext, { xValues: xs, yValues: ys, isSorted: true, containsNaN: false });
    g.setMetadataGenerator({ getSingleMetadata: () => ({ isSelected: false }) });
    const ix = new Float64Array(GEN_M), iy = new Float64Array(GEN_M);
    for (let i = 0; i < GEN_M; i++) ix[i] = 800 + i;
    g.insertRange(0, ix, iy);
    const res = { count: g.count(), metadataLength: g.metadataProperty.length };
    g.delete();
    P.log(`${label}, generator-backed insert of ${GEN_M}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Prepending 10 x 1,000 points with metadata, as shipped…");
  const shipped = await prepend("as shipped");
  const genShipped = await generatorCheck("as shipped");

  // The issue's fix: grow in place, shift the tail with a backward loop.
  impl = function (startIndex, metadata) {
    const length = metadata ? metadata.length : this.count() - (this.metadataProperty ? this.metadataProperty.length : 0);
    if (!metadata) {
      if (!this.metadataGeneratorProperty) return;
      metadata = Array(length).fill(1).map(() => this.metadataGeneratorProperty.getSingleMetadata());
    }
    this.fillMetadataIfUndefined();
    const md = this.metadataProperty, oldLength = md.length;
    md.length = oldLength + length;
    for (let i = oldLength - 1; i >= startIndex; i--) md[i + length] = md[i];
    for (let i = 0; i < length; i++) md[startIndex + i] = metadata[i];
  };
  P.status("Prepending 10 x 1,000 points with metadata, with the fix…");
  const fixed = await prepend("with fix");
  const genFixed = await generatorCheck("with fix");
  baseProto.insertMetadataRange = shippedInsert;

  const reproduced = shipped.sliceCalls >= 2 && shipped.concatCalls >= 1 && shipped.slots >= 2 * (N - M) && shipped.replaced === INSERTS
    && fixed.slots === 0 && fixed.replaced === 0 && shipped.aligned && fixed.aligned;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each insertRange(0, ${M.toLocaleString("en-US")}) with metadata on a ${N.toLocaleString("en-US")}-point series allocates ${Math.round(shipped.slots).toLocaleString("en-US")} array slots (2 slices + concat) and replaces the metadata array (${INSERTS} of ${INSERTS} inserts). With the in-place fix: ${fixed.slots} slots, ${fixed.replaced} replacements. A generator-backed insert of ${GEN_M} adds ${genShipped.metadataLength - GEN_N} metadata entries (window.length = ${window.length}).`
      : `Expected about 2n+m slots and a new metadata array per insert; measured ${shipped.slots.toFixed(0)} slots, ${shipped.replaced} replacements (fix: ${fixed.slots.toFixed(0)} / ${fixed.replaced}).`,
    columns: ["As shipped", "In-place fix"],
    rows: [
      ["Array.slice calls per insert (inside insertMetadataRange)", shipped.sliceCalls, fixed.sliceCalls],
      ["Array.concat calls per insert", shipped.concatCalls, fixed.concatCalls],
      ["Array slots allocated by slice/concat per insert", shipped.slots, fixed.slots],
      ["Metadata array replaced, of " + INSERTS + " inserts", shipped.replaced, fixed.replaced],
      ["Old metadata slots dropped per insert", shipped.droppedPerInsert, fixed.droppedPerInsert],
      ["Time in insertMetadataRange per insert, µs", shipped.metaUs, fixed.metaUs],
      ["insertRange() time, median ms (native insert included)", shipped.insertMs, fixed.insertMs],
      ["Metadata still matches X at every index", shipped.aligned ? "yes" : "no", fixed.aligned ? "yes" : "no"],
      [`Generator-backed insertRange of ${GEN_M}: count()`, genShipped.count, genFixed.count],
      [`… metadata length (should equal count())`, genShipped.metadataLength, genFixed.metadataLength],
    ],
    notes: [
      `In the generator branch the shipped code calls Array(length) with no local 'length', so it reads window.length (${window.length} here: the number of child frames). It generates no metadata and the metadata array falls ${genShipped.count - genShipped.metadataLength} entries behind the X values; in a Worker it would throw.`,
      `Time in insertMetadataRange: ${shipped.metaUs.toFixed(0)} µs as shipped vs ${fixed.metaUs.toFixed(0)} µs with the fix (timer resolution is about 100 µs in a normal page). The fixed version still shifts the n existing entries once per insert (O(n)), so at this size it is not clearly faster; what it removes is the ~2n+m slots of garbage per insert and the dropped n-slot old-generation array, which is GC work that this timing does not include. V8 may still reallocate the backing store when the length grows past its capacity.`,
      "Counts do not depend on hardware; times do.",
    ],
    metrics: { shipped, fixed, genShipped, genFixed, n: N, m: M, windowLength: window.length },
  });
}
