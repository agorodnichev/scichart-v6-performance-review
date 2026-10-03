const META = {
  id: "084",
  title: "StackedColumnCollection leaks an unused native drawing provider on every re-attach",
  issue: "issues/084-stacked-column-collection-unused-native-provider-leak.md",
  severity: "low",
  claim: "StackedColumnCollection.onAttach creates a new native SCRTStackedColumnSeriesDrawingProvider each time the collection is added to a surface, and onDetach never frees it. Nothing draws with it (each child series has its own provider), and the field is overwritten on the next attach, so the previous native object is never released; delete() frees only the last one.",
  method: "<p>A StackedColumnCollection with 3 layers of 50 columns is removed with renderableSeries.remove(collection, false) and added back 20 times, one frame apart. The demo records the provider handle that onAttach stores on the collection after each attach, checks each one with the embind isDeleted() call, and counts DrawPointsVec calls made on those handles versus on the child series' own providers. It then removes the collection with delete. The harness's native ledger (every embind handle created and deleted per class) gives a second, independent count.</p><p>Comparison: the same cycles with onAttach patched to the issue's fix (no allocation), and, as shipped, the issue's app-side workaround (toggle isVisible instead of remove/add). The original onAttach is restored.</p>",
};

async function demo(P) {
  const { NumericAxis, StackedColumnCollection, StackedColumnRenderableSeries, XyDataSeries, EAutoRange } = P.SciChart;
  const CYCLES = 20, S = 3, N = 50;
  const FILLS = ["#4e79a7", "#f28e2b", "#e15759"];
  const CLS = "SCRTStackedColumnSeriesDrawingProvider";

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { autoRange: EAutoRange.Always }));
  const xs = Array.from({ length: N }, (_, i) => i);
  function makeCollection() {
    const coll = new StackedColumnCollection(wasmContext);
    for (let s = 0; s < S; s++) {
      coll.add(new StackedColumnRenderableSeries(wasmContext, {
        dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => 1 + Math.abs(Math.sin(x / 6 + s))), isSorted: true, containsNaN: false }),
        fill: FILLS[s], stroke: "#2b2b2b", strokeThickness: 1,
      }));
    }
    return coll;
  }

  // Record every provider handle that onAttach leaves on a collection.
  const proto = StackedColumnCollection.prototype;
  const shippedOnAttach = proto.onAttach;
  const collProviders = new Set();
  let onAttachImpl = shippedOnAttach;
  proto.onAttach = function (scs) {
    const before = this.nativeDrawingProvider;
    const ret = onAttachImpl.call(this, scs);
    if (this.nativeDrawingProvider && this.nativeDrawingProvider !== before) collProviders.add(this.nativeDrawingProvider);
    return ret;
  };
  // Who draws: the collection's providers or the children's?
  P.hookMethod(wasmContext[CLS].prototype, "DrawPointsVec", {
    name: "DrawPointsVec (all)",
    onCall: (args, self) => P.count(collProviders.has(self) ? "DrawPointsVec on collection providers" : "DrawPointsVec on child providers"),
  });
  P.native.start();

  async function scenario(label, mode) {
    collProviders.clear();
    const ledger0 = (P.native.snapshot()[CLS] || { created: 0, deleted: 0 });
    const coll = makeCollection();
    sciChartSurface.renderableSeries.add(coll);
    await P.idleFrames(3);
    const r = await P.during(async () => {
      for (let k = 0; k < CYCLES; k++) {
        if (mode === "toggle") {
          coll.isVisible = false; await P.nextFrame();
          coll.isVisible = true; await P.idleFrames(2);
        } else {
          sciChartSurface.renderableSeries.remove(coll, false); await P.nextFrame();
          sciChartSurface.renderableSeries.add(coll); await P.idleFrames(2);
        }
      }
    });
    const handles = Array.from(collProviders);
    const liveAfterCycles = handles.filter((h) => !h.isDeleted()).length;
    const ledgerMid = P.native.snapshot()[CLS] || { created: 0, deleted: 0 };
    sciChartSurface.renderableSeries.remove(coll, true); // detach and delete()
    await P.idleFrames(2);
    const liveAfterDelete = handles.filter((h) => !h.isDeleted()).length;
    const ledger1 = P.native.snapshot()[CLS] || { created: 0, deleted: 0 };
    const res = {
      created: handles.length,
      liveAfterCycles,
      liveAfterDelete,
      drawsOnCollection: r.total("DrawPointsVec on collection providers"),
      drawsOnChildren: r.total("DrawPointsVec on child providers"),
      ledgerCreatedDuringCycles: ledgerMid.created - ledger0.created - S, // minus the children's own providers
      ledgerNetLeak: (ledger1.created - ledger0.created) - (ledger1.deleted - ledger0.deleted),
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Removing and re-adding the collection, library as shipped…");
  const memBefore = P.memory(wasmContext).wasmMemoryMB;
  const shipped = await scenario("as shipped, remove(collection, false) + add", "reattach");
  const memAfter = P.memory(wasmContext).wasmMemoryMB;

  P.status("Removing and re-adding the collection, with the fix…");
  const baseOnAttach = Object.getPrototypeOf(proto).onAttach; // BaseStackedCollection.onAttach
  onAttachImpl = function (scs) { baseOnAttach.call(this, scs); }; // the issue's fix: no allocation
  const fixed = await scenario("with fix (no allocation in onAttach)", "reattach");
  onAttachImpl = shippedOnAttach;

  P.status("Toggling isVisible instead (workaround), as shipped…");
  const toggled = await scenario("as shipped, isVisible toggled instead", "toggle");
  proto.onAttach = shippedOnAttach;
  P.native.stop();

  const reproduced = shipped.created >= CYCLES + 1 && shipped.liveAfterDelete >= CYCLES && shipped.drawsOnCollection === 0 && shipped.drawsOnChildren > 0;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `${CYCLES} remove/add cycles left ${shipped.created} native ${CLS} objects created by onAttach, never used for drawing; after delete() ${shipped.liveAfterDelete} are still alive. With the fix: ${fixed.created} created; toggling isVisible: ${toggled.liveAfterDelete} left.`
      : `Expected ${CYCLES + 1} providers created by onAttach and ${CYCLES} left after delete(); measured ${shipped.created} and ${shipped.liveAfterDelete}.`,
    columns: ["As shipped: remove + add", "With fix: remove + add", "As shipped: toggle isVisible"],
    rows: [
      ["Cycles", CYCLES, CYCLES, CYCLES],
      ["Native providers created by collection.onAttach", shipped.created, fixed.created, toggled.created],
      ["... still alive after the cycles (isDeleted() false)", shipped.liveAfterCycles, fixed.liveAfterCycles, toggled.liveAfterCycles],
      ["... still alive after remove(collection, true) / delete()", shipped.liveAfterDelete, fixed.liveAfterDelete, toggled.liveAfterDelete],
      ["DrawPointsVec calls on those providers", shipped.drawsOnCollection, fixed.drawsOnCollection, toggled.drawsOnCollection],
      ["DrawPointsVec calls on the child series' own providers", shipped.drawsOnChildren, fixed.drawsOnChildren, toggled.drawsOnChildren],
      [`Native ledger: ${CLS} created during the cycles`, shipped.ledgerCreatedDuringCycles, fixed.ledgerCreatedDuringCycles, toggled.ledgerCreatedDuringCycles],
      [`Native ledger: ${CLS} never deleted (whole scenario)`, shipped.ledgerNetLeak, fixed.ledgerNetLeak, toggled.ledgerNetLeak],
    ],
    notes: [
      `The leak is one small native object per re-attach, so the wasm heap size cannot show it (it grows in 64 KB pages): ${memBefore} MB before and ${memAfter} MB after the shipped run. The object is reachable only through a field that the next attach overwrites, and embind registers no finalizer for this raw-pointer class, so garbage collection cannot free it.`,
      "The collection's provider is referenced only by commented-out drawing code; the fix column draws the same chart (child DrawPointsVec calls continue).",
    ],
    metrics: { CYCLES, shipped, fixed, toggled, memBefore, memAfter },
  });
}
