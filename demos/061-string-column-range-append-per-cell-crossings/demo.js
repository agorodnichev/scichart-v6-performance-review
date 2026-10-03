const META = {
  id: "061",
  title: "XyTextDataSeries.appendRange writes its text one cell at a time, about 5 wasm calls per row",
  issue: "issues/061-string-column-range-append-per-cell-crossings.md",
  severity: "medium",
  claim: "A range append on a string column first writes blank codes in bulk, then rewrites every row through StringColumnStore.setValueAt: size() (bounds check), get(), AddRef(), Release() of the blank and set(), so appendRange crosses into wasm per row while the numeric columns cross once per batch.",
  method: "<p>An XyTextDataSeries with <code>fifoCapacity: 10,000</code>, pre-filled to capacity, drawn by a FastTextRenderableSeries (the X axis follows the newest 60 points). Every frame appends 200 rows with <code>appendRange(x, y, text)</code>; the labels cycle through 100 distinct strings, so after warm-up no new dictionary entries are needed. Pass 1 (30 frames per variant) counts every call into the string column's native objects (<code>SCRTIntFifoVector</code> and <code>SCRTStringDictionary</code> methods) made inside <code>appendRange</code>; pass 2 (60 frames, without those counters) times <code>appendRange</code>.</p><p>A/B: the issue's library fix applied at runtime: a bulk <code>setValuesAt</code> on the store (encode all, then write the codes through one Int32Array view, releasing only non-blank codes) and <code>writeText</code> patched to call it. After each variant the demo checks that the last 10,000 labels read back as appended.</p>",
};

async function demo(P) {
  const { NumericAxis, XyTextDataSeries, FastTextRenderableSeries, NumberRange } = P.SciChart;
  const CAP = 10000, BATCH = 200, COUNT_FRAMES = 30, TIME_FRAMES = 60, DISTINCT = 100;

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  const xAxis = new NumericAxis(wasmContext);
  sciChartSurface.xAxes.add(xAxis);
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { visibleRange: new NumberRange(-1.4, 1.4) }));
  const label = (i) => `${["buy", "sell", "hold", "ask", "bid"][i % 5]} ${i % DISTINCT}`;
  let t = 0;
  const batch = (n) => {
    const xs = new Float64Array(n), ys = new Float64Array(n), texts = new Array(n);
    for (let i = 0; i < n; i++, t++) { xs[i] = t; ys[i] = Math.sin(t / 9) * 0.9; texts[i] = label(t); }
    return { xs, ys, texts };
  };
  const ds = new XyTextDataSeries(wasmContext, { fifoCapacity: CAP, isSorted: true, containsNaN: false });
  const first = batch(CAP);
  ds.appendRange(first.xs, first.ys, first.texts);
  sciChartSurface.renderableSeries.add(new FastTextRenderableSeries(wasmContext, {
    dataSeries: ds, dataLabels: { style: { fontFamily: "Arial", fontSize: 12 }, color: "#4e79a7" },
  }));
  const follow = () => { xAxis.visibleRange = new NumberRange(t - 60, t + 2); };
  follow();
  await P.sleep(500);

  // Labels read back as appended?
  const labelsOk = () => {
    const values = ds.textValues, n = ds.count();
    if (values.length !== n) return false;
    for (let i = 0; i < n; i++) if (values[i] !== label(t - n + i)) return false;
    return true;
  };

  // The issue's fix: bulk setValuesAt on the store (StringColumnStore is not exported; patch its prototype via an instance).
  const store = ds.stringColumns.get("text");
  const storeProto = Object.getPrototypeOf(store);
  const setValuesAt = function (firstRow, values) {
    this.throwIfDeleted();
    const n = values.length;
    if (!(firstRow >= 0 && firstRow + n <= this.codes.size())) throw new Error("rows must be within the column");
    const newCodes = new Int32Array(n);
    for (let i = 0; i < n; i++) newCodes[i] = this.encode(values[i]); // AddRef before any Release, as setValueAt
    const cap = this.fifoCapacity, start = cap ? this.codes.getStartIndex() : 0;
    const view = this.rawCodesView(); // after encode(): an Append may grow the heap
    const released = [];
    for (let i = 0; i < n; i++) {
      const p = cap ? (start + firstRow + i) % cap : firstRow + i;
      if (view[p] >= 0) released.push(view[p]); // blanks (-1) need no Release
      view[p] = newCodes[i];
    }
    for (const code of released) this.dictionary.Release(code);
  };
  const writeText = XyTextDataSeries.prototype.writeText;
  const writeTextBulk = function (startIndex, textValues) {
    if (!textValues) return;
    const s = this.stringColumns.get("text");
    const written = Math.min(textValues.length, this.count() - Math.max(startIndex, 0));
    if (!s || written <= 0) return;
    const dropped = textValues.length - written;
    s.setValuesAt(Math.max(startIndex, 0), dropped === 0 && written === textValues.length ? textValues : textValues.slice(dropped, dropped + written));
  };
  const setVariant = (fixed) => {
    if (fixed) { storeProto.setValuesAt = setValuesAt; XyTextDataSeries.prototype.writeText = writeTextBulk; }
    else { delete storeProto.setValuesAt; XyTextDataSeries.prototype.writeText = writeText; }
  };

  let inAppend = false; // wasm calls are attributed to appendRange only (text rendering also reads codes)
  async function stream(label2, frames) {
    const ms = [];
    const r = await P.frames(frames, () => {
      const b = batch(BATCH);
      inAppend = true;
      const t0 = P.now();
      try { ds.appendRange(b.xs, b.ys, b.texts); } finally { inAppend = false; }
      ms.push(P.now() - t0);
      follow();
    });
    ms.sort((a, b) => a - b);
    const calls = {};
    Object.keys(r.delta).filter((k) => k.indexOf("wasm ") === 0).forEach((k) => { calls[k.slice(5)] = r.delta[k].n / (frames * BATCH); });
    const total = Object.values(calls).reduce((a, b) => a + b, 0);
    const pick = (re) => Object.keys(calls).filter((k) => re.test(k)).reduce((a, k) => a + calls[k], 0);
    const res = {
      perRow: total, size: pick(/^SCRTIntFifoVector\.size$/), get: pick(/^SCRTIntFifoVector\.get$/), set: pick(/^SCRTIntFifoVector\.set$/),
      addRef: pick(/AddRef$/), release: pick(/Release$/), setValueAt: r.total("setValueAt calls") / (frames * BATCH),
      appendMs: ms[Math.floor(ms.length / 2)], p95: r.frameP95, ok: labelsOk(), calls,
    };
    res.other = res.perRow - res.size - res.get - res.set - res.addRef - res.release;
    P.log(`${label2}: ${JSON.stringify(res)}`);
    return res;
  }

  // Pass 1: counts of every call into the string column's native objects.
  const undo = [];
  const hookAll = (cls, methods) => methods.forEach((m) => {
    if (typeof wasmContext[cls].prototype[m] === "function")
      undo.push(P.hookMethod(wasmContext[cls].prototype, m, { name: `all calls ${cls}.${m}`, onCall: () => { if (inAppend) P.count(`wasm ${cls}.${m}`); } }));
  });
  hookAll("SCRTIntFifoVector", ["size", "capacity", "get", "set", "getRaw", "dataPtr", "dataPtrZero", "notifyAppend", "getStartIndex", "resizeFast", "push_back"]);
  hookAll("SCRTStringDictionary", ["Append", "AddRef", "Release", "Count", "LiveCount", "DeadCount", "GetTextAt", "ByteSize"]);
  undo.push(P.hookMethod(storeProto, "setValueAt", { name: "all setValueAt calls", onCall: () => { if (inAppend) P.count("setValueAt calls"); } }));
  P.status("Counting wasm calls, as shipped…");
  setVariant(false);
  const shipped = await stream("counts, as shipped", COUNT_FRAMES);
  P.status("Counting wasm calls, with bulk setValuesAt…");
  setVariant(true);
  const fixed = await stream("counts, with bulk setValuesAt", COUNT_FRAMES);
  undo.forEach((u) => u());
  // Pass 2: timing.
  P.status("Timing appendRange, as shipped…");
  setVariant(false);
  const shippedT = await stream("timing, as shipped", TIME_FRAMES);
  P.status("Timing appendRange, with bulk setValuesAt…");
  setVariant(true);
  const fixedT = await stream("timing, with bulk setValuesAt", TIME_FRAMES);
  setVariant(false);

  const removed = shipped.perRow - fixed.perRow;
  const reproduced = shipped.setValueAt >= 0.99 && shipped.set >= 0.99 && removed >= 3.5 && fixed.set === 0 && shipped.ok && fixed.ok;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `appendRange of ${BATCH} text rows into a full ${CAP.toLocaleString("en-US")}-row FIFO calls setValueAt once per row and makes ${shipped.perRow.toFixed(1)} wasm calls per row on the text column (${Math.round(shipped.perRow * BATCH).toLocaleString("en-US")} per batch). A bulk setValuesAt removes ${removed.toFixed(1)} per row (size, get, set and the Release of the blank), leaving ${fixed.perRow.toFixed(1)}: one AddRef per value plus the FIFO eviction.`
      : `Expected about 4 per-row wasm calls removed by a bulk write; measured ${shipped.perRow.toFixed(2)} per row as shipped, ${fixed.perRow.toFixed(2)} with the fix, setValueAt ${shipped.setValueAt.toFixed(2)} per row.`,
    columns: ["As shipped", "Bulk setValuesAt (fix)"],
    rows: [
      ["Rows appended per frame", BATCH, BATCH],
      ["StringColumnStore.setValueAt calls per row", shipped.setValueAt, fixed.setValueAt],
      ["wasm calls per appended row, text column (all methods)", shipped.perRow, fixed.perRow],
      ["… codes size() per row (bounds check)", shipped.size, fixed.size],
      ["… codes get() per row (previous code; FIFO eviction)", shipped.get, fixed.get],
      ["… codes set() per row", shipped.set, fixed.set],
      ["… dictionary AddRef() per row", shipped.addRef, fixed.addRef],
      ["… dictionary Release() per row (blank; FIFO eviction)", shipped.release, fixed.release],
      ["… other calls per row (per batch, amortised)", shipped.other, fixed.other],
      ["Labels read back as appended (last 10,000)", shipped.ok ? "yes" : "no", fixed.ok ? "yes" : "no"],
      ["appendRange() time, median ms (timing pass)", shippedT.appendMs, fixedT.appendMs],
      ["Frame interval p95, ms (timing pass)", shippedT.p95, fixedT.p95],
    ],
    notes: [
      "Each row of a full FIFO also costs one get() + one Release() to free the evicted row (releaseEvictedBy) in both columns; the issue's fix does not change that. Release() of the blank code (-1) does no work but is still a crossing. The numeric X/Y columns cross once per batch in both columns. TableDataSeries string columns use the same per-cell loop (writeStringCells).",
      "Counts do not depend on hardware; times do. At 200 rows per batch the absolute time is small; the per-row crossings scale with batch size and with the number of string columns.",
    ],
    metrics: { shipped, fixed, shippedT, fixedT, batch: BATCH, cap: CAP },
  });
}
