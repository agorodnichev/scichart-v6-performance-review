const META = {
  id: "040",
  title: "TableDataSeries renumbers every remaining row with one wasm set() call per row after each removeRow",
  issue: "issues/040-table-renumber-rows-embind-set-per-row.md",
  severity: "medium",
  claim: "After a remove or insert, a tabular TableDataSeries rewrites the row positions 0..n-1 from the change point to the end through xValues.set(i, i), one embind call per row. Removing row 0 of a 100,000-row live table costs 100,000 JS-to-wasm calls, on top of the native shift.",
  method: "<p>A tabular TableDataSeries (built from <code>columns</code>: a numeric <code>value</code> column and a string <code>label</code> column) with 100,000 rows, plotted as a line through <code>yArrayFilter: \"value\"</code>. Each frame handles 4 messages as a live table does: <code>appendRow</code> plus <code>removeRow(0)</code> per message. Pass 1 (20 frames per variant) counts wasm <code>SCRTDoubleVector.set</code> calls (whole page) and <code>renumberRowPositions</code> calls; pass 2 (40 frames per variant, no per-call counter) times the remove calls.</p><p>Variants: as shipped; the issue's library fix, <code>renumberRowPositions</code> patched to write the sequence through a Float64Array view taken after the native edit; and the issue's app-side workaround, one <code>appendRows(4)</code> plus one <code>removeRows(0, 4)</code> per frame. After each variant the demo checks that every row position equals its index.</p>",
};

async function demo(P) {
  const { NumericAxis, TableDataSeries, FastLineRenderableSeries, EAutoRange, vectorToArrayViewF64 } = P.SciChart;
  const N = 100000, PER_FRAME = 4, COUNT_FRAMES = 20, TIME_FRAMES = 40;

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
  let msg = 0;
  const row = () => { const k = msg++; return { value: Math.sin(k / 2000) + 0.3 * Math.sin(k / 61), label: "order " + (k % 997) }; };
  const values = [], labels = [];
  for (let i = 0; i < N; i++) { const r = row(); values.push(r.value); labels.push(r.label); }
  const table = new TableDataSeries(wasmContext, { columns: [{ name: "value", values }, { name: "label", values: labels }] });
  sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, { dataSeries: table, yArrayFilter: "value", stroke: "#4e79a7", strokeThickness: 1.5 }));
  await P.sleep(500);

  const proto = TableDataSeries.prototype;
  const renumber = proto.renumberRowPositions;
  // The issue's fix: write the positions through a Float64Array view, taken after the native edit and not kept.
  const renumberWithView = function (fromIndex) {
    const n = this.count();
    const xView = vectorToArrayViewF64(this.getNativeXValues(), this.webAssemblyContext);
    for (let i = Math.max(0, fromIndex); i < n; i++) xView[i] = i;
  };
  const variants = {
    shipped: { label: "as shipped", impl: renumber, frame: (ms) => { for (let k = 0; k < PER_FRAME; k++) { table.appendRow(row()); const t0 = P.now(); table.removeRow(0); ms.t += P.now() - t0; } } },
    fixed: { label: "view-based renumber (fix)", impl: renumberWithView, frame: (ms) => variants.shipped.frame(ms) },
    batched: {
      label: "batched removeRows (workaround)", impl: renumber,
      frame: (ms) => { const rows = []; for (let k = 0; k < PER_FRAME; k++) rows.push(row()); table.appendRows(rows); const t0 = P.now(); table.removeRows(0, PER_FRAME); ms.t += P.now() - t0; },
    },
  };
  const positionsOk = () => { const x = vectorToArrayViewF64(table.getNativeXValues(), wasmContext); for (let i = 0; i < x.length; i++) if (x[i] !== i) return false; return x.length === table.count(); };

  let current = renumber;
  proto.renumberRowPositions = function () { P.count("renumberRowPositions calls"); return current.apply(this, arguments); };
  async function run(key, frames) {
    const v = variants[key];
    current = v.impl;
    await P.idleFrames(2);
    const ms = { t: 0 };
    const r = await P.frames(frames, () => v.frame(ms));
    const res = {
      sets: r.total("wasm SCRTDoubleVector.set") / frames,
      renumbers: r.total("renumberRowPositions calls") / frames,
      removeMs: ms.t / frames, p95: r.frameP95, rows: table.count(), positionsOk: positionsOk(),
    };
    P.log(`${v.label}, ${frames} frames: ${JSON.stringify(res)}`);
    return res;
  }

  // Pass 1: counts.
  const undoSet = P.hookMethod(wasmContext.SCRTDoubleVector.prototype, "set", { name: "wasm SCRTDoubleVector.set" });
  const counts = {};
  for (const key of ["shipped", "fixed", "batched"]) { P.status(`Counting: ${variants[key].label}…`); counts[key] = await run(key, COUNT_FRAMES); }
  undoSet();
  // Pass 2: timing without the per-call counter.
  const times = {};
  for (const key of ["shipped", "fixed", "batched"]) { P.status(`Timing: ${variants[key].label}…`); times[key] = await run(key, TIME_FRAMES); }
  proto.renumberRowPositions = renumber;

  const s = counts.shipped, f = counts.fixed, b = counts.batched;
  const perRemove = (r) => r.sets / PER_FRAME;
  const reproduced = perRemove(s) >= 0.95 * (N - 1) && f.sets <= 0.001 * N && s.positionsOk && f.positionsOk && b.positionsOk;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Each removeRow(0) on a ${N.toLocaleString("en-US")}-row table makes ${Math.round(perRemove(s)).toLocaleString("en-US")} wasm set() calls to renumber the rows (${Math.round(s.sets).toLocaleString("en-US")} per frame at ${PER_FRAME} messages). With the view-based renumber: ${Math.round(f.sets)}; with one batched removeRows: ${Math.round(b.sets).toLocaleString("en-US")} per frame.`
      : `Expected about ${(N - 1).toLocaleString("en-US")} set() calls per removeRow(0); measured ${perRemove(s).toFixed(0)} (fix: ${perRemove(f).toFixed(0)}).`,
    columns: ["As shipped", "View-based renumber (fix)", "Batched removeRows (workaround)"],
    rows: [
      ["Rows in the table", s.rows, f.rows, b.rows],
      ["Rows removed per frame", PER_FRAME, PER_FRAME, PER_FRAME],
      ["renumberRowPositions calls per frame", s.renumbers, f.renumbers, b.renumbers],
      ["wasm SCRTDoubleVector.set calls per frame (whole page)", s.sets, f.sets, b.sets],
      ["wasm set() calls per removed row", perRemove(s), perRemove(f), perRemove(b)],
      ["Row positions equal 0..n-1 afterwards", s.positionsOk ? "yes" : "no", f.positionsOk ? "yes" : "no", b.positionsOk ? "yes" : "no"],
      ["Time in remove calls per frame, ms (timing pass)", times.shipped.removeMs, times.fixed.removeMs, times.batched.removeMs],
      ["Frame interval p95, ms (timing pass)", times.shipped.p95, times.fixed.p95, times.batched.p95],
    ],
    notes: [
      "The remove time includes the native shift of every column (the same in all columns) and the string column's bookkeeping. Counts do not depend on hardware; times do.",
      "The batched workaround still renumbers the whole table once per frame through set(); the view-based fix removes the per-row wasm calls entirely.",
    ],
    metrics: { counts, times, rows: N, perFrame: PER_FRAME },
  });
}
