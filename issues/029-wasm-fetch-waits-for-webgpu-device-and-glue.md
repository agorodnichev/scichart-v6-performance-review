# 029 · The core wasm download and compile start only after the WebGPU adapter and device requests (auto mode on every Mac) and, with wasm64, after the glue chunk import

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/createMaster.js:294` |
| Severity | **medium** |
| Pipeline stage | Network (`network`) |
| Metric | startup (time to first chart frame) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/f78111985edeb4f3ef5aa5074239a852/): reproduced on WebGPU (the code path does not exist on WebGL: inconclusive there by design) ([source](../demos/029-wasm-fetch-waits-for-webgpu-device/)) |
| Rule | TASK-16 (also TASK-14, SC-36) (web-performance skill) |
| Effort to fix | small |

## Code

```js
    let preinitializedWebGPUDevice;
    if (WebGpuHelper.getWebGpuSupported()) {
        preinitializedWebGPUDevice = await WebGpuHelper.initializeWebGPUDevice();
    }
    const useWasm64 = shouldUseWasm64();
    const WasmModule = await resolveWasmModule2D(useWasm64);
```

## Call path and frequency

SciChartSurface.create -> createMultichart (createMaster.js:91) -> `await WebGpuHelper.initializeWebGPUDevice()` (createMaster.js:96-98; IS_WEB_GPU is true in auto mode whenever the UA contains 'Mac', constants/app.js:32,37) -> createWebGPUDevice: requestAdapter (WebGpuHelper.js:43) + requestDevice (:66) -> initCanvas -> initializeChartEngine (createMaster.js:166, awaits the cached device again at :172) -> createMaster (:269) -> await device (:296) -> await resolveWasmModule2D (:299; dynamic import of _glue/scichart-64 at :53 when useWasm64) -> preloadWasm (:314) -> getCompiledWasmModule -> compileStreaming(fetch(url)) (wasmModuleCache.js:29). createSingleInternal has the same chain (createSingle.js:25-27, :35, :38-40, :57). Runs once per page load, for the first chart.

## Why it costs

preloadWasm resolves the URL from sciChartConfig, shouldUseWasm64 and shouldUseSimd only; the one union binary serves both WebGL and WebGPU, so the URL does not depend on the renderer. Even so, the fetch and streaming compile are chained behind requestAdapter/requestDevice and, for wasm64, behind the glue chunk's request. These awaits add their latencies in series before the biggest download starts, where they could overlap it. Not measured.

**Scale where it matters:** Every page load whose first chart runs in a Mac browser with navigator.gpu (WebGPU auto mode), or with localStorage IS_WEB_GPU=1, or with useWasm64. The request that waits is the 1.56 MB scichart.wasm, the largest file on the chart's critical path. On Intel Macs the adapter is then rejected as non-Apple (WebGpuHelper.js:48), so the wait buys nothing.

## Fix (library side)

```diff
--- esm/Charting/Visuals/createMaster.js (createMultichart)
     assertSameRootSurfaceReplaceable(divElement);
+    // The wasm URL does not depend on the renderer: start the download + streaming compile now.
+    // createMaster's preloadWasm(useWasm64) gets this same cached promise (keyed by URL).
+    preloadWasm(shouldUseWasm64()).catch(() => { /* reported by the awaited preloadWasm in createMaster */ });
     // Probe WebGPU support before canvas init so the runtime flag is resolved
     if (IS_WEB_GPU) {
         await WebGpuHelper.initializeWebGPUDevice();
     }
--- esm/Charting/Visuals/createMaster.js (createMaster)
-    let preinitializedWebGPUDevice;
-    if (WebGpuHelper.getWebGpuSupported()) {
-        preinitializedWebGPUDevice = await WebGpuHelper.initializeWebGPUDevice();
-    }
     const useWasm64 = shouldUseWasm64();
-    const WasmModule = await resolveWasmModule2D(useWasm64);
+    preloadWasm(useWasm64).catch(() => { }); // awaited, and its error reported, at the preloadWasm call below
+    const [preinitializedWebGPUDevice, WasmModule] = await Promise.all([
+        WebGpuHelper.getWebGpuSupported() ? WebGpuHelper.initializeWebGPUDevice() : Promise.resolve(undefined),
+        resolveWasmModule2D(useWasm64)
+    ]);
--- esm/Charting/Visuals/createSingle.js (createSingleInternal)
+    preloadWasm(shouldUseWasm64()).catch(() => { });
     // Probe WebGPU support before canvas init so the runtime flag is resolved
     if (IS_WEB_GPU) {
         await WebGpuHelper.initializeWebGPUDevice();
     }
```

**Trade-off:** The wasm download now runs alongside WebGPU setup and the other startup requests; it is needed with either renderer, so no bytes are wasted. SciChartSurface.configure must still run before create(), as now. On a broken deployment (404 or wrong bytes), an early attempt that has already failed and been evicted is followed by the awaited attempt, so up to twice as many failing wasm requests appear as today.

## App-side workaround

Call the exported preloadWasm() at app start or on chart-route intent, after SciChartSurface.configure and before the first create(). create() then reuses the cached compiled module.

## Verify

measure.md#load, cold and warm, in Chrome on macOS (or with localStorage IS_WEB_GPU=1), with an app:first-frame mark, 5 runs per side. Pass: the scichart.wasm request starts before requestAdapter/requestDevice resolve, and compare-runs gives 'win' on firstFrameMs.

## Other locations

- `esm/Charting/Visuals/createMaster.js:96` — first serial await of the device in createMultichart, before initCanvas and before createMaster runs
- `esm/Charting/Visuals/createMaster.js:314` — preloadWasm, the first point where the wasm fetch starts
- `esm/Charting/Visuals/createSingle.js:25` — same device-then-glue-then-preload chain for createSingle (:35, :39, :57)
- `esm/Core/WebGpuHelper.js:43` — requestAdapter, then requestDevice at :66

## Review notes

- Found by reviewer slice `s02-init-loading`.
- Adversarial verification (corrected): Re-read createMultichart (createMaster.js:91-161), initializeChartEngine (:166-197) and createMaster (:269-330): the code quote is lines 294-299 (reviewer cited 296, the middle line), so primary corrected to 294. Confirmed WebGpuHelper.initializeWebGPUDevice is memoised (WebGpuHelper.js:9-23), so the first await at createMaster.js:96-98 is the one that pays requestAdapter+requestDevice, and the wasm fetch only starts at :314. Confirmed preloadWasm (preloadWasm.js:37-45) and getLocateFile (SciChartSurfaceBase.js:884-925) depend on sciChartConfig/shouldUseWasm64/shouldUseSimd only, not on the renderer. IS_WEB_GPU = auto mode && /Mac/ UA (constants/app.js:31-37). createSingle.js chain confirmed. Corrected the trade-off: on a failing URL the fix can add one extra attempt, which the original text described as unchanged.

