# 031 · The 3D side module (scichart-charting3d.wasm) is fetched only after the core is up, read into an ArrayBuffer, copied twice through MEMFS and compiled from bytes in every wasm context: no streaming compile, no code cache, no shared compiled module

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/moduleLoader.js:333` |
| Severity | **medium** |
| Pipeline stage | Script load (`script-load`) |
| Metric | startup (time to first 3D frame) (also memory) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Rule | TASK-14 (also TASK-16, SC-36) (web-performance skill) |
| Effort to fix | medium |

## Code

```js
        const fsPath = `/${moduleName}.wasm`;
        ctx.FS.writeFile(fsPath, bytes);
        await ctx.loadDynamicLibrary(fsPath, { loadAsync: true, global: true });
```

## Call path and frequency

SciChart3DSurface.create (SciChart3DSurface.js:155-163, requiresModule "charting3d") -> createMultichart -> `await initializeChartEngine` (createMaster.js:103: core fetch, compile, instantiate, callMain) -> `await ensureModule(wasmContext, "charting3d")` (createMaster.js:121-122) -> moduleLoader.js:285 `await import("./SciChartSurface")` -> :290 fetch -> :302 arrayBuffer -> :312 validateModuleBytes -> :334 FS.writeFile (MEMFS copies with buffer.slice because canOwn is not set) -> :335 loadDynamicLibrary -> loadLibData -> FS.readFile (second copy, _glue-pretty/scichart.js:3130 and FS.readFile body) -> loadWebAssemblyModule -> WebAssembly.instantiate(bytes) (_glue-pretty/scichart.js:743). Once per wasm context: once per page with create(), once per surface with SciChart3DSurface.createSingle (SciChart3DSurface.js:65-73 -> createSingle.js:116-118), because ensureModule state is per context (moduleLoader.js:100-106).

## Why it costs

(1) The module request starts only after the core is downloaded, compiled, instantiated and main() has run: a serial waterfall on the first 3D chart. (2) arrayBuffer() then WebAssembly.instantiate(bytes) compiles only after the last byte arrives, and only streamed compiles feed V8's wasm code cache, so this module compiles from scratch on every visit. (3) Nothing caches the compiled module or the bytes across contexts, unlike the core (wasmModuleCache.js). (4) FS.writeFile without canOwn keeps a full copy in MEMFS for the life of the context, and FS.readFile makes another transient copy. The `await import("./SciChartSurface")` adds one more promise hop. Not measured.

**Scale where it matters:** Every page with a 3D chart (457 KB SIMD module, 474 KB wasm64). With N createSingle 3D surfaces: N fetches (HTTP-cache hits at best), N compiles from bytes, and N MEMFS copies of about 457 KB each held for the life of each context.

## Fix (library side)

```diff
--- esm/Charting/Visuals/moduleLoader.js
+import { sciChartConfig } from "./sciChartConfig"; // leaf module (see its header): no cycle with SciChartSurface
+const moduleBytesCache = new Map(); // url -> Promise<Uint8Array>, shared by every wasm context on the page
+export const prefetchModuleBytes = (url) => {
+    let p = moduleBytesCache.get(url);
+    if (!p) {
+        p = fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
+            .then(b => new Uint8Array(b));
+        p.catch(() => moduleBytesCache.delete(url));
+        moduleBytesCache.set(url, p);
+    }
+    return p;
+};
@@ ensureModule
-        const { sciChartConfig } = await import("./SciChartSurface");
         const url = resolveModuleUrl(moduleName, sciChartConfig, variant);
-        response = await fetch(url); ... bytes = new Uint8Array(await response.arrayBuffer());
+        bytes = await prefetchModuleBytes(url); // wrapped in the same named-module / named-URL errors as today
@@
-        ctx.FS.writeFile(fsPath, bytes);
-        await ctx.loadDynamicLibrary(fsPath, { loadAsync: true, global: true });
+        ctx.FS.writeFile(fsPath, bytes, { canOwn: true }); // MEMFS references the bytes instead of copying them
+        try {
+            await ctx.loadDynamicLibrary(fsPath, { loadAsync: true, global: true });
+        } finally {
+            ctx.FS.unlink(fsPath); // LDSO tracks the library by name from here on; the file is not read again
+        }
--- esm/Charting/Visuals/createMaster.js (createMultichart; same in createSingleInternal)
+    if (!isStaticBuild() && family.requiresModule) {
+        const variant = shouldUseWasm64() ? "64" : shouldUseSimd() ? "simd" : "nosimd";
+        prefetchModuleBytes(resolveModuleUrl(family.requiresModule, sciChartConfig, variant)).catch(() => { });
+    }
     try {
         await initializeChartEngine({ destinationCanvas: canvases.domCanvas2D });
```

**Trade-off:** One copy of the module bytes stays in the JS heap for the page's life instead of one MEMFS copy per context; it can be evicted after the last load. Streaming compile and code caching need a follow-up: compile once per URL with WebAssembly.compileStreaming (through the existing wasmModuleCache) and pass the WebAssembly.Module to the glue. Its loadWebAssemblyModule already accepts a Module (_glue-pretty/scichart.js:740-741), but it is not exported, and the LDSO bookkeeping in loadDynamicLibrary must be kept. The prefetch derives the variant again; a mismatch only misses the URL-keyed cache, and the scrt.module stamp check still guards correctness.

## App-side workaround

On 3D routes, add `<link rel="preload" as="fetch" crossorigin href="/scichart-charting3d.wasm">` so the download overlaps core init (the HTTP cache then serves the library's fetch). Prefer SciChart3DSurface.create() over createSingle() so the module is fetched and compiled once per page.

## Verify

measure.md#start, cold and warm, on a page with one SciChart3DSurface.create(); then measure.md#mem with a createSingle 3D chart created and deleted 10 times. Pass: list_network_requests shows the scichart-charting3d.wasm request overlapping scichart.wasm, compare-runs gives 'win' on firstFrameMs, and heap growth per action no longer includes a ~450 KB buffer per context.

## Other locations

- `esm/Charting/Visuals/moduleLoader.js:290` — plain fetch, then arrayBuffer() at :302
- `esm/Charting/Visuals/moduleLoader.js:285` — extra async hop: dynamic import of an already-loaded module
- `esm/Charting/Visuals/createMaster.js:122` — ensureModule awaited only after initializeChartEngine (:103)
- `esm/Charting/Visuals/createSingle.js:117` — per-createSingle-context load and compile
- `_glue-pretty/scichart.js:743` — loadWebAssemblyModule: WebAssembly.instantiate(bytes), a non-streaming compile
- `_glue-pretty/scichart.js:3130` — loadLibData: FS.readFile copy of the MEMFS file

## Review notes

- Found by reviewer slice `s02-init-loading`.
- Adversarial verification (corrected): Re-read ensureModule (moduleLoader.js:258-348): the quote is lines 333-335 (reviewer cited 334), primary corrected to 333. Confirmed requiresModule "charting3d" on both 3D families (SciChart3DSurface.js:73 and :161), the await order in createMultichart (:103 then :121-122) and createSingle (:116-117), and that module state is per wasmContext (getState, :100-106), so createSingle contexts each fetch and compile. In the glue: FS.writeFile passes opts.canOwn to FS.write, and MEMFS uses buffer.slice when canOwn is false (copy kept); loadLibData -> findLibraryFS -> FS.readFile allocates a new Uint8Array; loadWebAssemblyModule with loadAsync calls WebAssembly.instantiate(binary) (:737-748). Checked that sciChartConfig.js is a leaf module exporting the same singleton SciChartSurface re-exports, so the fix's static import is valid, and that validateModuleBytes only reads the bytes, so sharing them is safe. Dropped the reviewer's speculative esbuild facade-chunk claim.

