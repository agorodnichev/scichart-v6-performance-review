const META = {
  id: "029",
  title: "The scichart.wasm download starts only after the WebGPU adapter and device requests resolve",
  issue: "issues/029-wasm-fetch-waits-for-webgpu-device-and-glue.md",
  severity: "medium",
  claim: "On the WebGPU path (IS_WEB_GPU=1, or auto mode on any Mac) the first create() awaits navigator.gpu.requestAdapter() and adapter.requestDevice() before createMaster() calls preloadWasm(), so the 1.56 MB wasm request waits for both, although its URL does not depend on the renderer.",
  method: "<p>Each run needs a fresh page state (the device and the compiled module are cached per page), so each runs in its own same-origin iframe that loads the same SciChart 6.0.6 bundle and the page's renderer setting. In each frame the demo wraps navigator.gpu.requestAdapter, GPUAdapter.requestDevice and fetch, and records on one clock when each was called and resolved, when the scichart.wasm request started (fetch call and PerformanceResourceTiming), when create() resolved and when the chart drew its first frame.</p><p>Run 1, as shipped: SciChartSurface.create(). Run 2, the app-side workaround from the issue: preloadWasm() right before create(). Each run uses its own query string on the wasm URL, so neither gets the file or its compiled code from the browser cache of the other.</p><p>The verdict rests on order (did the wasm request start before or after the device was ready?), which does not depend on hardware; the milliseconds are secondary.</p>",
};

async function demo(P) {
  const UMD = "https://cdn.jsdelivr.net/npm/scichart@6.0.6/index.min.js";
  const CDN_WASM = "https://cdn.jsdelivr.net/npm/scichart@6.0.6/_wasm/scichart.wasm";
  const frames = document.getElementById("frames");

  // One isolated page state per run: an iframe with its own SciChart, WebGPU device and module cache.
  async function isolatedRun(label, withPreload, tag) {
    const frame = P.quiet(() => {
      const fig = document.createElement("figure");
      fig.innerHTML = `<figcaption>${label}</figcaption>`;
      const f = document.createElement("iframe");
      f.title = label;
      fig.appendChild(f);
      frames.appendChild(fig);
      return f;
    });
    frame.srcdoc = "<!doctype html><html><head><style>html,body{margin:0;height:100%;background:#fff}#chart{width:100%;height:100%}</style></head><body><div id=\"chart\"></div></body></html>";
    await new Promise((r) => { frame.onload = r; });
    const w = frame.contentWindow, d = frame.contentDocument;
    const t = { adapterCalls: 0, deviceCalls: 0 };
    const url = `${CDN_WASM}?demo029=${tag}-${Date.now()}`;
    if (w.GPU) {
      const ra = w.GPU.prototype.requestAdapter;
      w.GPU.prototype.requestAdapter = function () {
        t.adapterCalls++; if (t.adapterCall == null) t.adapterCall = P.now();
        return ra.apply(this, arguments).then((a) => { if (t.adapterDone == null) t.adapterDone = P.now(); return a; });
      };
    }
    if (w.GPUAdapter) {
      const rd = w.GPUAdapter.prototype.requestDevice;
      w.GPUAdapter.prototype.requestDevice = function () {
        t.deviceCalls++; if (t.deviceCall == null) t.deviceCall = P.now();
        return rd.apply(this, arguments).then((x) => { if (t.deviceDone == null) t.deviceDone = P.now(); return x; });
      };
    }
    const f = w.fetch;
    w.fetch = function (input) {
      if (String((input && input.url) || input) === url && t.fetch == null) t.fetch = P.now();
      return f.apply(this, arguments);
    };
    const cs = w.WebAssembly.compileStreaming;
    w.WebAssembly.compileStreaming = function () {
      return cs.apply(this, arguments).then((m) => { if (t.compiled == null) t.compiled = P.now(); return m; });
    };
    await new Promise((res, rej) => {
      const s = d.createElement("script");
      s.src = UMD; s.crossOrigin = "anonymous"; s.onload = res; s.onerror = () => rej(new Error("Could not load " + UMD));
      d.head.appendChild(s);
    });
    const S = w.SciChart;
    S.SciChartSurface.configure({ wasmUrl: url });
    S.SciChartSurface.UseCommunityLicense();
    if (S.SciChartDefaults) S.SciChartDefaults.performanceWarnings = false;

    t.start = P.now();
    if (withPreload) S.preloadWasm().catch(() => { /* create() reports errors */ });
    const { sciChartSurface, wasmContext } = await S.SciChartSurface.create(d.getElementById("chart"));
    t.created = P.now();
    const first = new Promise((r) => { const tok = sciChartSurface.rendered.subscribe(() => { if (t.firstFrame == null) t.firstFrame = P.now(); r(); }); });
    sciChartSurface.xAxes.add(new S.NumericAxis(wasmContext));
    sciChartSurface.yAxes.add(new S.NumericAxis(wasmContext));
    const xs = Array.from({ length: 300 }, (_, i) => i);
    sciChartSurface.renderableSeries.add(new S.FastLineRenderableSeries(wasmContext, {
      dataSeries: new S.XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 20)), isSorted: true, containsNaN: false }),
      stroke: withPreload ? "#59a14f" : "#e15759", strokeThickness: 2,
    }));
    await Promise.race([first, P.sleep(3000)]);
    t.renderer = S.WebGpuHelper.getWebGpuSupported() ? "WebGPU" : "WebGL";
    const rel = (v) => (v == null ? null : +(v - t.start).toFixed(1));
    const out = {
      renderer: t.renderer, adapterCalls: t.adapterCalls, deviceCalls: t.deviceCalls,
      adapterCall: rel(t.adapterCall), adapterDone: rel(t.adapterDone), deviceCall: rel(t.deviceCall), deviceDone: rel(t.deviceDone),
      fetch: rel(t.fetch), compiled: rel(t.compiled), created: rel(t.created), firstFrame: rel(t.firstFrame),
    };
    P.log(`${label}: ${JSON.stringify(out)}`);
    return out;
  }

  // The first WebGPU adapter/device request of a browser session is much slower than later ones.
  // Pay it here, once, so both runs below see the same (warm) GPU process; report it separately.
  let cold = null;
  const flag = (() => { try { return localStorage.getItem("IS_WEB_GPU"); } catch (e) { return null; } })();
  const willTryWebGPU = !!navigator.gpu && (flag === "1" || (flag !== "0" && /Mac/i.test(navigator.userAgent)));
  if (willTryWebGPU) {
    P.status("Warming up the GPU process (first adapter and device request)…");
    const t0 = P.now();
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    const t1 = P.now();
    const device = adapter ? await adapter.requestDevice() : null;
    const t2 = P.now();
    if (device) device.destroy();
    cold = { adapter: t1 - t0, device: t2 - t1 };
    P.log(`warm-up: first requestAdapter ${cold.adapter.toFixed(1)} ms, requestDevice ${cold.device.toFixed(1)} ms`);
  }

  P.status("Run 1 (as shipped): create() in a fresh frame…");
  const shipped = await isolatedRun("As shipped: create()", false, "run1");
  const wentWebGPU = shipped.adapterCalls > 0;
  P.status("Run 2 (workaround): preloadWasm() then create() in a fresh frame…");
  const pre = await isolatedRun("Workaround: preloadWasm(); create()", true, "run2");

  const gpuReady = (r) => (r.deviceDone != null ? r.deviceDone : r.adapterDone);
  const waited = (r) => r.fetch != null && gpuReady(r) != null && r.fetch >= gpuReady(r);
  const overlapped = (r) => r.fetch != null && r.adapterDone != null && r.fetch < r.adapterDone;
  let verdict, headline;
  if (!wentWebGPU) {
    verdict = "inconclusive";
    headline = `This run used the ${shipped.renderer} path: create() made no WebGPU adapter or device request, and the wasm request started ${shipped.fetch} ms after create() was called. The issue applies to WebGPU (Renderer: WebGPU, or auto on a Mac).`;
  } else if (waited(shipped) && overlapped(pre)) {
    verdict = "reproduced";
    headline = `As shipped, the scichart.wasm request started only after requestAdapter() and requestDevice() resolved (device ready ${gpuReady(shipped)} ms after create(), request at ${shipped.fetch} ms). With preloadWasm() first it started at ${pre.fetch} ms, before the adapter resolved. The serial wait equals the adapter + device latency: ${gpuReady(shipped)} ms in this run` +
      (cold ? ` (the page's own first request this session took ${(cold.adapter + cold.device).toFixed(1)} ms).` : ".");
  } else {
    verdict = "not-reproduced";
    headline = `Expected the wasm request to wait for the WebGPU device as shipped; it started at ${shipped.fetch} ms with the device ready at ${gpuReady(shipped)} ms (workaround: ${pre.fetch} ms vs adapter ${pre.adapterDone} ms).`;
  }
  const yesNo = (b) => (b ? "yes" : "no");
  P.report({
    verdict,
    headline,
    columns: ["As shipped", "preloadWasm() first"],
    rows: [
      ["Renderer used", shipped.renderer, pre.renderer],
      ["requestAdapter / requestDevice calls", `${shipped.adapterCalls} / ${shipped.deviceCalls}`, `${pre.adapterCalls} / ${pre.deviceCalls}`],
      ["Wasm request started before the WebGPU device was ready", wentWebGPU ? yesNo(!waited(shipped)) : "n/a", wentWebGPU ? yesNo(!waited(pre)) : "n/a"],
      ["requestAdapter() resolved, ms after start", shipped.adapterDone, pre.adapterDone],
      ["requestDevice() resolved, ms after start", shipped.deviceDone, pre.deviceDone],
      ["scichart.wasm fetch() called, ms after start", shipped.fetch, pre.fetch],
      ["scichart.wasm downloaded and compiled (compileStreaming resolved), ms", shipped.compiled, pre.compiled],
      ["create() resolved, ms", shipped.created, pre.created],
      ["First frame drawn, ms", shipped.firstFrame, pre.firstFrame],
      ["First adapter + device request of this browser session (warm-up), ms", cold ? cold.adapter + cold.device : null, null],
    ],
    notes: [
      "Start = the moment create() (or preloadWasm() then create()) was called. Order rows do not depend on hardware; the times depend on the GPU, the network and other work on the machine. The wasm URLs carry a per-run query string, so both runs download and compile the file from scratch. Before the runs the page makes one adapter + device request of its own, because the first one in a browser session is much slower than later ones and would otherwise land only in run 1; on a cold page load the shipped path waits that long.",
      "create() and first-frame times also differ by run order (the second frame starts with warmer browser caches and JIT), so only the request-start rows isolate this issue; the most the workaround can save is the measured adapter + device wait. On Intel Macs in auto mode the adapter is then rejected as non-Apple and the chart falls back to WebGL, so the wait buys nothing. The wasm64 part of the claim (the glue chunk import) is not exercised: useWasm64 defaults to Never.",
    ],
    metrics: { shipped, pre, cold },
  });
}
