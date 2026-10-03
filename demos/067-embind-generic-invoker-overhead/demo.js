const META = {
  id: "067",
  title: "Every embind call runs two generic rest/spread layers (shared invokerFn + dynCall)",
  issue: "issues/067-embind-generic-invoker-per-call-alloc.md",
  severity: "medium",
  claim: "The glue is built without EMBIND_AOT (and with DYNAMIC_EXECUTION=0), so every bound C++ method is the same generic invokerFn(...args) with a rest array, an onDone closure and a spread call, and every signature that contains 'p' adds getDynCaller's (...args) => dynCall(...) layer. Dashboards make thousands of these calls per frame.",
  method: "<p><b>Structure (counts).</b> While the core module is instantiated, the demo wraps the module's <code>_embind_register_class_function</code> import to record each bound method's signature, raw C++ invoker and context (it forwards every call unchanged). It counts how many bound methods have a 'p' in their signature (dynCall layer) and how many distinct function bodies the bound methods share.</p><p><b>Calls per frame (counts).</b> A dashboard of 16 create() charts, each with axis labels and a line series with 50 data labels, is redrawn for 30 frames while every prototype method of every embind class (and every bound free function) is wrapped with a counter.</p><p><b>Cost per call (time).</b> After the counters are removed, one cheap method, SCRTDoubleVector.get(i), is called 200,000 times per trial in three ways, interleaved, 7 trials, median: as shipped; through a fixed-arity function plus a rebuilt copy of the dynCall layer (roughly what EMBIND_AOT alone would leave); and through a fixed-arity function straight into the same raw wasm invoker from the function table. Verdict threshold, set before measuring: the shipped call takes at least twice as long as the fixed-arity call into the same invoker.</p>",
};

async function demo(P) {
  const { NumericAxis, FastLineRenderableSeries, XyDataSeries, EDataLabelSkipMode } = P.SciChart;

  // ---- 1. Record embind registrations while the core module is instantiated (forwarding every call).
  const regs = [], classNames = new Map();
  let wasmExports = null;
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = function (mod, imports) {
    const env = imports && imports.env;
    if (!wasmExports && mod instanceof WebAssembly.Module && env && typeof env._embind_register_class_function === "function") {
      const rcf = env._embind_register_class_function, rc = env._embind_register_class;
      env._embind_register_class_function = function (rawClassType, methodName, argCount, rawArgTypesAddr, invokerSignature, rawInvoker, context) {
        regs.push({ cls: rawClassType >>> 0, name: methodName >>> 0, argCount, sig: invokerSignature >>> 0, invoker: rawInvoker >>> 0, context: context >>> 0 });
        return rcf.apply(this, arguments);
      };
      env._embind_register_class = function (rawType) { classNames.set(rawType >>> 0, arguments[10] >>> 0); return rc.apply(this, arguments); };
      return instantiate.apply(this, arguments).then((res) => {
        wasmExports = (res instanceof WebAssembly.Instance ? res : res.instance).exports;
        env._embind_register_class_function = rcf;
        env._embind_register_class = rc;
        return res;
      });
    }
    return instantiate.apply(this, arguments);
  };

  // ---- 2. Dashboard: 16 charts with axis labels and data labels.
  P.status("Creating 16 charts with data labels…");
  const grid = document.getElementById("grid");
  const surfaces = [];
  let wasmContext = null;
  const xs = Array.from({ length: 50 }, (_, i) => i);
  for (let k = 0; k < 16; k++) {
    const id = "d" + k;
    P.quiet(() => { const d = document.createElement("div"); d.id = id; d.className = "cell"; grid.appendChild(d); });
    const r = await P.createSurface(id);
    wasmContext = r.wasmContext;
    r.sciChartSurface.xAxes.add(new NumericAxis(r.wasmContext));
    r.sciChartSurface.yAxes.add(new NumericAxis(r.wasmContext, { growBy: new P.SciChart.NumberRange(0.2, 0.2) }));
    r.sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(r.wasmContext, {
      dataSeries: new XyDataSeries(r.wasmContext, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 6 + k)), isSorted: true, containsNaN: false }),
      stroke: "#4e79a7", strokeThickness: 1,
      dataLabels: { style: { fontFamily: "Arial", fontSize: 8 }, color: "#555555", skipMode: EDataLabelSkipMode.ShowAll },
    }));
    surfaces.push(r.sciChartSurface);
  }
  WebAssembly.instantiate = instantiate;
  await P.sleep(600);

  // ---- structure, from the registrations
  const mem = new Uint8Array(wasmExports.memory.buffer);
  const cstr = (p) => { let s = ""; while (mem[p]) s += String.fromCharCode(mem[p++]); return s; };
  const sigs = regs.map((r) => cstr(r.sig));
  const withP = sigs.filter((s) => s.includes("p")).length;

  // ---- 3. Count embind calls per frame: wrap every method of every embind class and every bound free function.
  const undo = [];
  const bodies = new Set();
  let wrapped = 0;
  for (const key of Object.keys(wasmContext)) {
    let v;
    try { v = wasmContext[key]; } catch (e) { continue; }
    if (typeof v !== "function") continue;
    if (v.prototype && typeof v.prototype.isAliasOf === "function") {
      const proto = v.prototype;
      for (const m of Object.getOwnPropertyNames(proto)) {
        const d = Object.getOwnPropertyDescriptor(proto, m);
        if (m === "constructor" || !d || typeof d.value !== "function") continue;
        if (!d.value.overloadTable) bodies.add(String(d.value));
        undo.push(P.hookMethod(proto, m, { name: "embind calls" }));
        wrapped++;
      }
    } else if (typeof v.argCount === "number") {
      undo.push(P.hookMethod(wasmContext, key, { name: "embind calls" }));
      wrapped++;
    }
  }
  P.status("Counting embind calls per frame on the 16-chart dashboard…");
  const FRAMES = 30;
  const perFrame = await P.frames(FRAMES, () => surfaces.forEach((s) => s.invalidateElement()));
  const callsPerFrame = perFrame.perFrame("embind calls");
  undo.forEach((u) => u());
  P.log(`registrations ${regs.length}, with 'p' ${withP}; wrapped ${wrapped} bound functions, ${bodies.size} distinct method bodies; ${callsPerFrame.toFixed(0)} embind calls per frame`);

  // ---- 4. Cost per call: SCRTDoubleVector.get(i), three ways.
  P.status("Timing SCRTDoubleVector.get() three ways…");
  let vecType = null;
  classNames.forEach((namePtr, rawType) => { if (cstr(namePtr) === "SCRTDoubleVector") vecType = rawType; });
  const rec = regs.find((r) => r.cls === vecType && cstr(r.name) === "get");
  const sig = cstr(rec.sig);
  const table = wasmExports.__indirect_function_table;
  const raw = table.get(rec.invoker);
  const vec = new wasmContext.SCRTDoubleVector();
  for (let i = 0; i < 1024; i++) vec.push_back(i * 0.5);
  const ptr = vec.$$.ptr, ctx = rec.context;
  const same = vec.get(77) === raw(ctx, ptr, 77);
  // fixed-arity invoker straight into the raw wasm invoker (EMBIND_AOT shape, no dynCall layer)
  const direct = { $$: vec.$$, get(i) { return raw(ctx, this.$$.ptr, i); } };
  // fixed-arity invoker + a rebuilt dynCall layer (rest array, spread, convert closure), as EMBIND_AOT alone would leave it
  const dynCall = (s, p, args) => { const f = table.get(p); const rtn = f(...args); const convert = (x) => (s[0] === "p" ? x >>> 0 : x); return convert(rtn); };
  const dynCaller = (...args) => dynCall(sig, rec.invoker, args);
  const aot = { $$: vec.$$, get(i) { return dynCaller(ctx, this.$$.ptr, i); } };
  const N = 200000;
  const variants = {
    shipped: () => { let s = 0; for (let i = 0; i < N; i++) s += vec.get(i & 1023); return s; },
    aot: () => { let s = 0; for (let i = 0; i < N; i++) s += aot.get(i & 1023); return s; },
    direct: () => { let s = 0; for (let i = 0; i < N; i++) s += direct.get(i & 1023); return s; },
  };
  const sums = Object.values(variants).map((f) => f()); // warm-up, and all three must agree
  const times = { shipped: [], aot: [], direct: [] };
  for (let trial = 0; trial < 7; trial++) {
    for (const [name, f] of Object.entries(variants)) { const t0 = P.now(); f(); times[name].push(((P.now() - t0) * 1e6) / N); }
    await P.sleep(10);
  }
  vec.delete();
  const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const ns = { shipped: median(times.shipped), aot: median(times.aot), direct: median(times.direct) };
  const agree = same && sums[0] === sums[1] && sums[1] === sums[2];
  P.log(`ns per call (median of 7): ${JSON.stringify(ns)}; results agree: ${agree}`);

  const ratio = ns.shipped / ns.direct;
  const msPerFrame = (callsPerFrame * (ns.shipped - ns.direct)) / 1e6;
  const msAotSaves = (callsPerFrame * (ns.shipped - ns.aot)) / 1e6;
  const reproduced = agree && ratio >= 2;
  P.report({
    verdict: reproduced ? "reproduced" : agree ? "not-reproduced" : "inconclusive",
    headline: reproduced
      ? `A bound method call costs ${ns.shipped.toFixed(0)} ns as shipped against ${ns.direct.toFixed(1)} ns for a fixed-arity call into the same wasm invoker (${ratio.toFixed(0)}x). ${withP} of ${regs.length} bound methods carry the dynCall layer, and the 16-chart dashboard makes ${callsPerFrame.toFixed(0)} embind calls per frame: about ${msPerFrame.toFixed(2)} ms of glue overhead per frame, ${msAotSaves.toFixed(2)} ms of it in the layer EMBIND_AOT would remove.`
      : agree ? `The shipped call took ${ns.shipped.toFixed(1)} ns against ${ns.direct.toFixed(1)} ns for a direct fixed-arity call (${ratio.toFixed(2)}x), under the 2x threshold.`
        : "The three call paths returned different results, so the timing comparison is not valid.",
    columns: ["Value"],
    rows: [
      ["Bound class methods registered by the core module", regs.length],
      ["…whose signature contains 'p' (adds the getDynCaller/dynCall layer)", withP],
      ["Distinct function bodies among the bound methods (generic invoker = 1)", bodies.size],
      ["Embind calls per frame, 16 charts with axis and data labels", callsPerFrame],
      ["Embind calls per frame per chart", callsPerFrame / 16],
      ["SCRTDoubleVector.get(i), ns per call: as shipped", ns.shipped],
      ["…fixed-arity invoker + rebuilt dynCall layer (≈ EMBIND_AOT alone)", ns.aot],
      ["…fixed-arity call straight into the wasm invoker", ns.direct],
      ["Shipped / fixed-arity direct", ratio],
      ["Estimated glue overhead per dashboard frame, ms", msPerFrame],
      ["…of which the generic invokerFn layer (EMBIND_AOT fix), ms", msAotSaves],
    ],
    notes: [
      `Renderer: ${P.renderer()}. Signature "${sig}" for SCRTDoubleVector.get. The registration and call counts do not depend on hardware; the nanoseconds do, and they also depend on the JIT. The rebuilt dynCall layer is monomorphic, while the real one is shared by every 'p' signature, so the EMBIND_AOT column is an optimistic estimate of what that fix alone leaves. The per-frame estimate multiplies the measured call count by this one cheap method's overhead; methods with string or object arguments add marshalling on top.`,
      "The rest arrays and closures are allocated in the source on every call; whether TurboFan removes them is not observable from a page, so allocation is not counted here. App-side mitigation from the issue: fewer embind calls (appendRange instead of per-point append, fewer data labels and render-context annotations).",
    ],
    metrics: { regs: regs.length, withP, bodies: bodies.size, wrapped, callsPerFrame, ns, ratio, msPerFrame, msAotSaves, sig, agree },
  });
}
