const META = {
  id: "082",
  title: "A wrong wasm Content-Type makes SciChart fetch scichart.wasm twice and compile from an ArrayBuffer, silently",
  issue: "issues/082-wasm-streaming-fallback-silent-refetch.md",
  severity: "low",
  claim: "getCompiledWasmModule() wraps WebAssembly.compileStreaming(fetch(url)) in .catch(() => fetchAndCompile(url)): when streaming compile fails (for example because the server sends application/octet-stream), the library fetches the file again, waits for the whole body, compiles from an ArrayBuffer, and drops the error without a console message.",
  method: "<p>A page cannot change the headers jsDelivr sends (it sends <code>application/wasm</code>), so the demo downloads the real scichart.wasm once and serves the same bytes from two same-origin Blob URLs: one typed <code>application/octet-stream</code>, as a misconfigured server would send, and one typed <code>application/wasm</code> as the control. For each URL it calls SciChartSurface.configure({ wasmUrl }) and creates a createSingle() chart, which loads the binary through preloadWasm() and getCompiledWasmModule().</p><p>Counted per run: fetch() calls for that URL, WebAssembly.compileStreaming() calls and how each settled (with the rejection message the library receives), WebAssembly.compile() calls (the ArrayBuffer path), and console warnings or errors that mention wasm, streaming, MIME or compile.</p><p>No times are compared: Blob URLs are read from memory and V8 compiles wasm lazily, so here both paths finish in a few milliseconds. On a network the fallback costs a second request and a compile that starts only after the last byte, which this page cannot reproduce faithfully.</p>",
};

async function demo(P) {
  const { SciChartSurface, NumericAxis, FastLineRenderableSeries, XyDataSeries } = P.SciChart;
  const CDN_WASM = "https://cdn.jsdelivr.net/npm/scichart@6.0.6/_wasm/scichart.wasm";

  P.status("Downloading scichart.wasm once to serve it from Blob URLs…");
  const bytes = await (await fetch(CDN_WASM)).arrayBuffer();
  const wrongUrl = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const rightUrl = URL.createObjectURL(new Blob([bytes], { type: "application/wasm" }));

  // Local hooks: fetch per URL, streaming compile outcomes, ArrayBuffer compiles, console.
  const fetches = new Map();
  P.hookMethod(window, "fetch", {
    name: "fetch (any)",
    onCall(a) { const u = String((a[0] && a[0].url) || a[0]); fetches.set(u, (fetches.get(u) || 0) + 1); },
  });
  const streaming = [];
  P.hookMethod(WebAssembly, "compileStreaming", {
    name: "WebAssembly.compileStreaming",
    onCall(a, self, ret) {
      const rec = { outcome: "pending", t0: P.now() };
      streaming.push(rec);
      Promise.resolve(ret).then(() => { rec.outcome = "compiled"; rec.ms = P.now() - rec.t0; },
        (e) => { rec.outcome = "rejected: " + ((e && e.message) || e); rec.ms = P.now() - rec.t0; });
    },
  });
  let compileMs = 0;
  P.hookMethod(WebAssembly, "compile", {
    name: "WebAssembly.compile (ArrayBuffer)",
    bytes: (a) => (a[0] && a[0].byteLength) || 0,
    onCall(a, self, ret) { const t0 = P.now(); Promise.resolve(ret).then(() => { compileMs += P.now() - t0; }, () => {}); },
  });
  const consoleHits = [];
  ["warn", "error"].forEach((m) => P.hookMethod(console, m, {
    name: "console." + m,
    onCall(a) { const s = Array.from(a).map(String).join(" "); if (/wasm|webassembly|streaming|mime|compile/i.test(s)) consoleHits.push(s.slice(0, 200)); },
  }));

  async function run(label, url, div) {
    SciChartSurface.configure({ wasmUrl: url });
    const s0 = streaming.length, c0 = consoleHits.length;
    compileMs = 0;
    const t0 = P.now();
    const r = await P.during(async () => {
      const { sciChartSurface, wasmContext } = await P.createSurface(div, undefined, true);
      sciChartSurface.xAxes.add(new NumericAxis(wasmContext));
      sciChartSurface.yAxes.add(new NumericAxis(wasmContext));
      const xs = Array.from({ length: 300 }, (_, i) => i);
      sciChartSurface.renderableSeries.add(new FastLineRenderableSeries(wasmContext, {
        dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 20)), isSorted: true, containsNaN: false }),
        stroke: label === "wrong" ? "#e15759" : "#59a14f", strokeThickness: 2,
      }));
    });
    await P.sleep(300); // let the streaming-compile promise outcomes settle in the log
    const res = {
      fetches: fetches.get(url) || 0,
      streaming: streaming.slice(s0),
      arrayBufferCompiles: r.total("WebAssembly.compile (ArrayBuffer)"),
      arrayBufferBytes: r.total("WebAssembly.compile (ArrayBuffer)", "bytes"),
      console: consoleHits.slice(c0),
      compileMs,
      createMs: r.ms,
      t0,
    };
    P.log(`${label}: ${res.fetches} fetch(es); compileStreaming: ${res.streaming.map((x) => x.outcome).join(" | ") || "none"}; ` +
      `WebAssembly.compile(ArrayBuffer): ${res.arrayBufferCompiles}; matching console messages: ${res.console.length}; create ${res.createMs.toFixed(0)} ms`);
    return res;
  }

  P.status("createSingle() with the wasm served as application/octet-stream…");
  const wrong = await run("wrong", wrongUrl, "chartWrong");
  P.status("createSingle() with the wasm served as application/wasm…");
  const right = await run("right", rightUrl, "chartRight");
  SciChartSurface.loadWasmFromCDN(); // restore the harness's configuration

  const rejected = wrong.streaming.filter((x) => x.outcome.startsWith("rejected"));
  const reproduced = wrong.fetches >= 2 && rejected.length >= 1 && wrong.arrayBufferCompiles >= 1 && wrong.console.length === 0 &&
    right.fetches === 1 && right.arrayBufferCompiles === 0;
  const reason = rejected.length ? rejected[0].outcome.replace(/^rejected: /, "") : "–";
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `With the wrong Content-Type the library fetched the binary ${wrong.fetches} times and compiled it from an ArrayBuffer after the streaming compile failed ("${reason}"), and logged nothing (${wrong.console.length} console messages). With application/wasm: ${right.fetches} fetch, streaming compile, no ArrayBuffer compile.`
      : `Expected 2 fetches, a rejected streaming compile, one ArrayBuffer compile and no console message for the wrong type; measured ${wrong.fetches} fetches, ${rejected.length} rejection(s), ${wrong.arrayBufferCompiles} ArrayBuffer compile(s), ${wrong.console.length} console message(s).`,
    columns: ["application/octet-stream", "application/wasm (control)"],
    rows: [
      ["fetch() calls for the wasm URL", wrong.fetches, right.fetches],
      ["WebAssembly.compileStreaming() calls", wrong.streaming.length, right.streaming.length],
      ["…of which rejected (error dropped by the library)", rejected.length, right.streaming.filter((x) => x.outcome.startsWith("rejected")).length],
      ["WebAssembly.compile(ArrayBuffer) calls (fallback path)", wrong.arrayBufferCompiles, right.arrayBufferCompiles],
      ["Bytes compiled from an ArrayBuffer", wrong.arrayBufferBytes, right.arrayBufferBytes],
      ["Console warnings/errors about wasm, streaming or MIME", wrong.console.length, right.console.length],
    ],
    notes: [
      `Rejection the library swallows: ${reason}`,
      `Times seen here (in-memory Blob, lazy compile, not comparable to a network load): ArrayBuffer compile ${wrong.compileMs.toFixed(1)} ms; createSingle() ${wrong.createMs.toFixed(0)} ms vs ${right.createMs.toFixed(0)} ms.`,
      "The counts do not depend on hardware. On a real server the second request downloads the file again unless the first response was cacheable, and only a streamed compile can feed V8's wasm code cache, so every later visit compiles again. The issue's fix adds one console warning on this path; serving .wasm as application/wasm (no parameters) avoids it.",
    ],
    metrics: { wrong: { ...wrong, streaming: wrong.streaming.map((x) => x.outcome) }, right: { ...right, streaming: right.streaming.map((x) => x.outcome) } },
  });
  URL.revokeObjectURL(wrongUrl);
  URL.revokeObjectURL(rightUrl);
}
