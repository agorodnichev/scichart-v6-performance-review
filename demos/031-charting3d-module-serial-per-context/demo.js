const META = {
  id: "031",
  title: "The 3D module loads after the core, compiles from bytes, and repeats for every wasm context",
  issue: "issues/031-charting3d-module-serial-nonstreaming-per-context.md",
  severity: "medium",
  claim: "ensureModule() fetches scichart-charting3d.wasm only after the core wasm is downloaded, compiled and instantiated, reads it into an ArrayBuffer, copies it into MEMFS (no canOwn) and compiles it with WebAssembly.instantiate(bytes): no streaming compile, no code cache, and nothing shared between wasm contexts, so every SciChart3DSurface.createSingle() repeats the fetch, the compile and the MEMFS copy.",
  method: "<p>Before any chart exists the demo wraps fetch and WebAssembly.compileStreaming / instantiateStreaming / compile / instantiate, recording each call's time, its argument type (compiled Module or raw bytes) and size. Then it creates three SciChart3DSurface.createSingle() charts, one after another, and afterwards three SciChart3DSurface.create() charts, the workaround from the issue (one shared context). For every context it reads the size of /charting3d.wasm in that context's MEMFS (the copy kept for the life of the context).</p><p>For the first 3D chart it also records the order of events: core wasm compiled, core instantiated, 3D module requested. The 3D module's URL is known before any of that happens (it sits next to scichart.wasm), so the gap is time the request could have overlapped.</p>",
};

async function demo(P) {
  const { NumericAxis3D } = P.SciChart;
  const N = 3;
  const isModule = (u) => /scichart-charting3d[^/]*\.wasm/.test(u);
  const isCore = (u) => /\/scichart(-nosimd|-64)?\.wasm/.test(u);
  const ev = [];
  const mark = (what, extra) => ev.push(Object.assign({ t: P.now(), what }, extra));

  P.hookMethod(window, "fetch", {
    name: "fetch (any)",
    onCall(a) {
      const u = String((a[0] && a[0].url) || a[0]);
      if (isModule(u)) { P.count("3D module fetches"); mark("module fetch"); } else if (isCore(u)) mark("core fetch");
    },
  });
  P.hookMethod(WebAssembly, "compileStreaming", {
    name: "WebAssembly.compileStreaming",
    onCall(a, self, ret) {
      Promise.resolve(a[0]).then((r) => {
        if (r && isModule(r.url)) P.count("3D module streaming compiles");
        ret.then(() => { if (r && isCore(r.url)) mark("core compiled"); }, () => {});
      }, () => {});
    },
  });
  P.hookMethod(WebAssembly, "instantiateStreaming", { name: "WebAssembly.instantiateStreaming" });
  P.hookMethod(WebAssembly, "compile", { name: "WebAssembly.compile" });
  let moduleCompileMs = 0;
  P.hookMethod(WebAssembly, "instantiate", {
    name: "WebAssembly.instantiate",
    onCall(a, self, ret) {
      const t0 = P.now();
      if (a[0] instanceof WebAssembly.Module) {
        P.count("instantiate(compiled Module)");
        ret.then(() => mark("core instantiated"), () => {});
      } else {
        P.count("instantiate(bytes): compile from bytes", 1, (a[0] && a[0].byteLength) || 0);
        ret.then(() => { moduleCompileMs += P.now() - t0; mark("module compiled"); }, () => {});
      }
    },
  });

  const memfsBytes = (ctx) => { try { return ctx.FS.stat("/charting3d.wasm").size; } catch (e) { return 0; } };
  async function make3D(div, single) {
    const r = await P.createSurface3D(div, undefined, single);
    r.sciChart3DSurface.xAxis = new NumericAxis3D(r.wasmContext);
    r.sciChart3DSurface.yAxis = new NumericAxis3D(r.wasmContext);
    r.sciChart3DSurface.zAxis = new NumericAxis3D(r.wasmContext);
    return r;
  }
  async function phase(label, single, ids) {
    moduleCompileMs = 0;
    const ctxs = new Set();
    const r = await P.during(async () => {
      for (const id of ids) {
        P.status(`${label}: ${id}…`);
        const s = await make3D(id, single);
        ctxs.add(s.wasmContext);
        await P.idleFrames(2);
      }
    });
    const copies = Array.from(ctxs).map(memfsBytes).filter((b) => b > 0);
    const res = {
      contexts: ctxs.size,
      fetches: r.total("3D module fetches"),
      fromBytes: r.total("instantiate(bytes): compile from bytes"),
      bytesCompiled: r.total("instantiate(bytes): compile from bytes", "bytes"),
      streaming: r.total("3D module streaming compiles") + r.total("WebAssembly.instantiateStreaming"),
      memfsCopies: copies.length,
      memfsBytes: copies.reduce((a, b) => a + b, 0),
      compileMs: moduleCompileMs,
      ms: r.ms,
    };
    P.log(`${label}: ${JSON.stringify(res)}`);
    return res;
  }

  const t0 = P.now();
  const single = await phase("createSingle() x3", true, ["s3d1", "s3d2", "s3d3"]);
  // Order of events for the very first 3D chart (all relative to the first core fetch).
  const first = (what) => { const e = ev.find((x) => x.what === what); return e ? e.t : null; };
  const order = { coreFetch: first("core fetch"), coreCompiled: first("core compiled"), coreInstantiated: first("core instantiated"), moduleFetch: first("module fetch"), moduleCompiled: first("module compiled") };
  const rel = (v) => (v == null || order.coreFetch == null ? null : v - order.coreFetch);
  P.log(`first 3D chart, ms after the core request: ${JSON.stringify(Object.fromEntries(Object.entries(order).map(([k, v]) => [k, rel(v) == null ? null : +rel(v).toFixed(1)])))}`);
  const multi = await phase("create() x3", false, ["m3d1", "m3d2", "m3d3"]);

  const serial = order.moduleFetch != null && order.coreInstantiated != null && order.moduleFetch > order.coreInstantiated;
  const reproduced = single.fetches >= N && single.fromBytes >= N && single.streaming === 0 && single.memfsCopies >= N && serial &&
    multi.fetches <= 1 && multi.fromBytes <= 1;
  const kb = (b) => Math.round(b / 1024);
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `${N} createSingle() 3D charts fetched the 3D module ${single.fetches} times, compiled it from bytes ${single.fromBytes} times (${kb(single.bytesCompiled / single.fromBytes)} KB each, 0 streaming compiles) and keep ${single.memfsCopies} MEMFS copies (${kb(single.memfsBytes)} KB). The first request started ${rel(order.moduleFetch).toFixed(0)} ms after the core request, after the core was compiled and instantiated. ${N} create() charts: ${multi.fetches} fetch, ${multi.fromBytes} compile.`
      : `Expected ${N} fetches, ${N} byte compiles and ${N} MEMFS copies for ${N} createSingle 3D charts, after the core; measured ${single.fetches}, ${single.fromBytes}, ${single.memfsCopies} (serial: ${serial}); create(): ${multi.fetches} fetch(es).`,
    columns: [`${N} x createSingle() 3D`, `${N} x create() 3D (workaround)`],
    rows: [
      ["wasm contexts", single.contexts, multi.contexts],
      ["scichart-charting3d.wasm fetches", single.fetches, multi.fetches],
      ["Compiles from bytes (WebAssembly.instantiate(Uint8Array))", single.fromBytes, multi.fromBytes],
      ["KB compiled from bytes", kb(single.bytesCompiled), kb(multi.bytesCompiled)],
      ["Streaming compiles of the module", single.streaming, multi.streaming],
      ["MEMFS copies of the module kept by live contexts", single.memfsCopies, multi.memfsCopies],
      ["KB held in MEMFS", kb(single.memfsBytes), kb(multi.memfsBytes)],
      ["Time in those compiles, ms (total)", single.compileMs, multi.compileMs],
      ["First chart: core compiled, ms after the core request", rel(order.coreCompiled), null],
      ["First chart: core instantiated, ms after the core request", rel(order.coreInstantiated), null],
      ["First chart: 3D module requested, ms after the core request", rel(order.moduleFetch), null],
      ["First chart: 3D module compiled, ms after the core request", rel(order.moduleCompiled), null],
    ],
    notes: [
      `Renderer: ${P.renderer()}. Counts and sizes do not depend on hardware; times do. Fetches after the first are served by the HTTP cache here, so the repeated cost per context is the compile from bytes and the MEMFS copy, not the network. V8 may reuse machine code for identical bytes within a page, which keeps repeated compiles short, but only a streamed compile can feed the persistent wasm code cache across visits.`,
      "The issue's preload-link workaround (overlap the module download with the core) needs a fresh page load to show and is not run here; the create() column shows the other workaround, one shared context.",
    ],
    metrics: { single, multi, order: Object.fromEntries(Object.entries(order).map(([k, v]) => [k, rel(v)])) },
  });
}
