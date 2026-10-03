const META = {
  id: "055",
  title: "WebGPU: every deleted chart's canvas stays referenced from wasmContext.specialHTMLTargets",
  issue: "issues/055-webgpu-specialhtmltargets-retains-deleted-canvases.md",
  severity: "medium",
  claim: "Under WebGPU, addNativeDestination() registers each chart canvas as specialHTMLTargets[\"#<root>_2D\"] so C++ can find it by selector. Nothing deletes the key on delete(), and the shared wasm module lives for the session, so with a new root id per mount every deleted chart leaves a detached canvas reachable from the module.",
  method: "<p>Ten mount/unmount cycles of a create() chart, three ways: (1) a new root div id each time, as a component list or router with generated ids does; (2) the same root id each time, the workaround from the issue; (3) new ids again, with the issue's library fix applied from outside (after delete(), delete wasmContext.specialHTMLTargets[\"#\" + canvasId]). After each set the demo counts the \"#&lt;root&gt;_2D\" keys in wasmContext.specialHTMLTargets and how many of them point at canvases no longer in the document.</p><p>Secondary, headless verifier only: a WeakRef to each deleted canvas is checked after a forced garbage collection, to see whether the canvas could be freed.</p><p>The registration exists only on the WebGPU path; on WebGL the page reports the (empty) registry and an inconclusive verdict.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries } = P.SciChart;
  const CYCLES = 10;
  const host = document.getElementById("mount");
  let ctx = null;
  const xs = Array.from({ length: 200 }, (_, i) => i);

  const targets = () => (ctx ? ctx.specialHTMLTargets : null);
  const census = () => {
    const t = targets();
    if (!t) return { keys: 0, detached: 0 };
    // chart canvases are registered as "#<rootId>_2D"; the module's own "#canvas" entry is not counted
    const keys = Object.keys(t).filter((k) => /^#.+_2D$/.test(k));
    return { keys: keys.length, detached: keys.filter((k) => t[k] && t[k].isConnected === false).length };
  };

  async function mountUnmount(rootId, applyFix, refs) {
    const div = P.quiet(() => { const d = document.createElement("div"); d.id = rootId; d.className = "probe-chart small"; host.appendChild(d); return d; });
    const { sciChartSurface, wasmContext } = await P.createSurface(rootId);
    ctx = wasmContext;
    sciChartSurface.xAxes.add(new NumericAxis(wasmContext));
    sciChartSurface.yAxes.add(new NumericAxis(wasmContext));
    sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, {
      dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 12)), isSorted: true, containsNaN: false }),
      stroke: "#4e79a7", strokeThickness: 2,
    }));
    await P.idleFrames(3);
    const canvas = sciChartSurface.domCanvas2D;
    const canvasId = canvas.id;
    sciChartSurface.delete();
    if (applyFix) delete wasmContext.specialHTMLTargets["#" + canvasId];
    P.quiet(() => div.remove());
    const i = P.surfaces.indexOf(sciChartSurface); // the harness keeps surfaces for console debugging
    if (i >= 0) P.surfaces.splice(i, 1);
    refs.push(new WeakRef(canvas));
  }

  async function phase(label, idFor, applyFix) {
    const refs = [];
    const before = census();
    for (let c = 0; c < CYCLES; c++) {
      P.status(`${label}: mount/unmount ${c + 1} / ${CYCLES}…`);
      await mountUnmount(idFor(c), applyFix, refs);
    }
    await P.idleFrames(2);
    const after = census();
    const gcOk = await P.gc();
    await P.sleep(100);
    const alive = gcOk ? refs.filter((r) => r.deref() !== undefined).length : null;
    const res = { addedKeys: after.keys - before.keys, keys: after.keys, detached: after.detached, aliveAfterGc: alive };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  const unique = await phase("new root id per mount", (c) => `mount055_a${c}`, false);
  const stable = await phase("same root id (workaround)", () => "mount055_stable", false);
  const fixed = await phase("new ids + key deleted after delete() (fix)", (c) => `mount055_c${c}`, true);

  const isWebGPU = P.renderer() === "WebGPU";
  const gcNote = unique.aliveAfterGc == null
    ? "No forced GC in this browser (only the headless verifier has one), so the WeakRef row is empty."
    : `After a forced GC, ${unique.aliveAfterGc} of ${CYCLES} canvases from the first set were still alive, ${fixed.aliveAfterGc} of ${CYCLES} with the fix.`;
  let verdict, headline;
  if (!isWebGPU) {
    verdict = "inconclusive";
    headline = `This run used ${P.renderer()}: SciChart registers canvases in specialHTMLTargets only on the WebGPU path, and the registry holds ${unique.keys} chart-canvas keys after ${CYCLES} mounts. Choose Renderer: WebGPU to test the claim.`;
  } else {
    const reproduced = unique.addedKeys >= CYCLES && unique.detached >= CYCLES && stable.addedKeys <= 1 && fixed.addedKeys === 0;
    verdict = reproduced ? "reproduced" : "not-reproduced";
    headline = reproduced
      ? `${CYCLES} mounts with new root ids left ${unique.addedKeys} new keys in specialHTMLTargets, ${unique.detached} of them pointing at detached canvases. Same root id: ${stable.addedKeys} new key; deleting the key after delete(): ${fixed.addedKeys}.`
      : `Expected ${CYCLES} retained keys with new ids; measured ${unique.addedKeys} (${unique.detached} detached), same id ${stable.addedKeys}, with the fix ${fixed.addedKeys}.`;
  }
  P.report({
    verdict,
    headline,
    columns: ["New root id per mount", "Same root id (workaround)", "New ids + key deleted (fix)"],
    rows: [
      [`New "#<root>_2D" keys in specialHTMLTargets after ${CYCLES} mounts`, unique.addedKeys, stable.addedKeys, fixed.addedKeys],
      ["…pointing at canvases no longer in the document", unique.detached, stable.detached - unique.detached, fixed.detached - stable.detached],
      ["Chart-canvas keys in the registry after the set", unique.keys, stable.keys, fixed.keys],
      [`Deleted canvases still alive after forced GC (of ${CYCLES})`, unique.aliveAfterGc, stable.aliveAfterGc, fixed.aliveAfterGc],
    ],
    notes: [
      `Renderer: ${P.renderer()}. The key counts do not depend on hardware. ${gcNote}`,
      "How much each retained canvas costs depends on what its WebGPU canvas context still holds after the native swap chain is released (C++ side); the retention itself is what is counted here. The registry belongs to the shared module, which lives for the session because autoDisposeWasmContext defaults to false.",
    ],
    metrics: { isWebGPU, unique, stable, fixed },
  });
}
