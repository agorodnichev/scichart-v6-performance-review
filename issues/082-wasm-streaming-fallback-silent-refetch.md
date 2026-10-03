# 082 · When streaming compile fails (for example a wrong MIME type), the compiled-module cache silently fetches again and compiles from an ArrayBuffer, losing the overlap and the wasm code cache with no console message

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/wasmModuleCache.js:28` |
| Severity | **low** |
| Pipeline stage | Network (`network`) |
| Metric | startup |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/db03a15b3837d32ef5aa9ad61d4eb861/): reproduced on WebGL and WebGPU ([source](../demos/082-wasm-streaming-fallback-silent-refetch/)) |
| Rule | TASK-14 (also SC-36) (web-performance skill) |
| Effort to fix | small |

## Code

```js
    const entry = typeof WebAssembly.compileStreaming === "function"
        ? WebAssembly.compileStreaming(fetch(url)).catch(() => fetchAndCompile(url))
        : fetchAndCompile(url);
```

## Call path and frequency

create()/createSingle()/app preloadWasm() -> preloadWasm (createMaster.js:314 / createSingle.js:57 / preloadWasm.js:44) -> getCompiledWasmModule (wasmModuleCache.js:23) -> compileStreaming(fetch(url)) rejects -> fetchAndCompile (wasmModuleCache.js:39-48): a second fetch, response.arrayBuffer() and WebAssembly.compile(buffer). The compiled module is then passed to Emscripten through instantiateWasm (buildInstantiateWasmHook), so Emscripten's own logging fallback never runs. Once per page load per binary.

## Why it costs

v6 replaced Emscripten's instantiateStreaming path, which logs 'wasm streaming compile failed ... falling back to ArrayBuffer instantiation' (_glue-pretty/scichart.js:146-147), with this cache, and the catch drops the error. On that path compile starts only after the full download, nothing enters V8's wasm code cache on any visit, and the second fetch downloads again when the response is not cacheable. The console check that SC-36 relies on cannot see any of this.

**Scale where it matters:** Any deployment that serves .wasm without `Content-Type: application/wasm` (dev servers, misconfigured CDNs or object stores). Affects the 1.56 MB core binary on every visit.

## Fix (library side)

```diff
-        ? WebAssembly.compileStreaming(fetch(url)).catch(() => fetchAndCompile(url))
+        ? WebAssembly.compileStreaming(fetch(url)).catch(err => {
+            console.warn(`SciChart: streaming compile of ${url} failed (${err === null || err === void 0 ? void 0 : err.message}); ` +
+                "falling back to ArrayBuffer compile without the wasm code cache. Serve .wasm as application/wasm.");
+            return fetchAndCompile(url);
+        })
```

**Trade-off:** Misconfigured servers get one console warning per binary per page load. The fix removes no cost by itself; it makes the misconfiguration visible so the deployer can fix the content type.

## App-side workaround

Serve .wasm with `Content-Type: application/wasm` (no parameters) and check the response headers in DevTools.

## Verify

measure.md#start, cold then warm, once with the server sending application/octet-stream and once with application/wasm. Pass: with the wrong type, list_console_messages shows the warning; with the right type there is no warning, and the warm load's compile time in trace-summary.mjs is lower than the cold one.

## Other locations

- `_glue-pretty/scichart.js:146` — Emscripten's own fallback logs the reason; bypassed by the instantiateWasm hook

## Review notes

- Found by reviewer slice `s02-init-loading`.
- Adversarial verification (corrected): Quote is wasmModuleCache.js:28-30 (reviewer cited 29), primary corrected. Confirmed the catch discards the error and fetchAndCompile re-fetches and compiles from an ArrayBuffer (:39-48). Confirmed both createMaster.js:314 and createSingle.js:57 go through preloadWasm -> getCompiledWasmModule and pass the result through buildInstantiateWasmHook, so Emscripten's instantiateAsync (_glue-pretty/scichart.js:137-151, which logs) is never used. Checked TASK-14/SC-36: the Avoid of TASK-14 names exactly this silent fallback risk. Low severity kept: once per page load, only on misconfigured servers.

