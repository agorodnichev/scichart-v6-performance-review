# 027 · The engine's rAF main loop asks for a frame every vsync for the life of the wasm module, including when nothing is invalidated and after every chart has been deleted

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `_glue-pretty/scichart.js:5918` |
| Severity | **high** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | frame time (idle main-thread wake-ups every vsync, battery and thermal on idle dashboards) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | CNV-02 (also CNV-20, SC-15, SC-31) (web-performance skill) |
| Effort to fix | medium |

## Code

```js
        MainLoop.runIter(iterFunc);
        if (!checkIsRunning()) return;
        MainLoop.scheduler();
      };
```

## Call path and frequency

createMaster.js:663 wasmContext.callMain() -> wasm main (__main_argc_argv) calls emscripten_set_main_loop(fn, -1, 1) once. I checked this by decoding the wasm call graph with a throwaway script: import 106 has one caller, main, with fps=-1. -> _glue-pretty/scichart.js:6094 _emscripten_set_main_loop -> setMainLoop:5864 -> fps<=0 so _emscripten_set_main_loop_timing(1, 1) :5924 -> MainLoop_scheduler_rAF :5821-5822 -> requestAnimationFrame(MainLoop.runner) :6008-6010 -> every frame runner -> runIter(wasm iteration) -> scheduler() :5918 -> rAF again. The only stop is emscripten_cancel_main_loop (:6031). In the wasm it has one caller, an internal shutdown function that sets a flag and then cancels. That path is reached from TSRRequestExit in cleanupWasmContext (createMaster.js:335) and in createSingle delete (createSingle.js:183). Frequency: once per display frame for as long as the engine exists. That is 1 loop for all create() surfaces, plus 1 per createSingle() surface (createSingle.js:222).

## Why it costs

Draws are already gated by TSRRequestCanvasDraw, so the frame that matters is coalesced correctly. The loop itself, though, never parks. A pending rAF callback makes the browser run BeginMainFrame and the rendering steps on every vsync, and each tick runs the glue runner plus a wasm iteration (the idle branch of the native iteration was not analysed). The page therefore never reaches an idle state with no frames. disableEngineLoop does not help: createMaster.js:136 only calls TSRSetDrawRequestsEnabled(false), so the emscripten rAF loop keeps ticking even for apps that own their frame loop.

**Scale where it matters:** Any page with a live engine. It matters most for idle or static dashboards, battery-powered devices and long SPA sessions. SciChartSurfaceBase.autoDisposeWasmContextValue defaults to false (SciChartSurfaceBase.js:819), so the loop keeps running after the last chart is deleted, for example on every route after a chart route has been visited.

## Fix (library side)

```diff
--- _glue-pretty/scichart.js (setMainLoop -> MainLoop.runner, ~5916)
         MainLoop.runIter(iterFunc);
         if (!checkIsRunning()) return;
-        MainLoop.scheduler();
+        // Render on demand: park the loop while the host reports nothing to draw
+        if (Module["isDrawIdle"] && Module["isDrawIdle"]()) {
+          MainLoop.parked = true;
+          return;
+        }
+        MainLoop.scheduler();
       };
--- _glue-pretty/scichart.js (after the MainLoop object, ~6018)
+    Module["wakeMainLoop"] = () => {
+      if (MainLoop.parked && MainLoop.scheduler) {
+        MainLoop.parked = false;
+        MainLoop.scheduler();
+      }
+    };
--- esm/Charting/Drawing/RenderSurface.js:24
         this.webAssemblyContext.TSRRequestCanvasDraw(canvasId);
+        this.webAssemblyContext.wakeMainLoop?.();
--- esm/Charting/Visuals/createMaster.js:663
+            originalWasmContext.isDrawIdle = () =>
+                getSharedEngineDestinations().every(d => !d.sciChartSurface.isInvalidated);
             wasmContext.callMain();
(Add the same wakeMainLoop?.() after TSRRequestDraw/TSRRequestCanvasDraw in SciChartRenderer.js:66, WebGlRenderContext2D.js:547 and SciChart3DSurface.js:587/593, and the same predicate in createSingle.js before callMain. In the engine, the equivalent change is emscripten_pause_main_loop() when no destination is dirty and emscripten_resume_main_loop() in TSRRequestCanvasDraw/TSRRequestDraw.)
```

**Trade-off:** Every path that needs a frame must wake the loop. That includes work that starts in the engine, such as async font or texture loads completing and context restore, and it needs an engine-side resume hook. A missed wake shows a stale frame until the next invalidation. Latency is unchanged: a parked loop resumes on the next rAF after the request.

## App-side workaround

While charts are mounted: none. To stop the loop after the last chart is gone, set SciChartSurface.autoDisposeWasmContext = true (optionally with wasmContextDisposeTimeout). Prefer create() over many createSingle() charts, because each createSingle chart adds its own perpetual loop.

## Verify

measure.md#fps, idle check. Load one static create() chart, mark wp:start/wp:end around 5 s with no input and no data, and trace without the frame probe. Then delete every chart and repeat. Pass: trace-summary counts 0 'Animation frame fired' in both idle windows. Today the expected count is about one per display refresh.

## Other locations

- `_glue-pretty/scichart.js:5924` — fps=-1 from wasm main selects rAF timing, every frame
- `esm/Charting/Visuals/createMaster.js:136` — disableEngineLoop only toggles draw requests; the rAF loop keeps running
- `esm/Charting/Visuals/SciChartSurfaceBase.js:819` — autoDisposeWasmContextValue = false keeps the engine (and its loop) alive after all charts are deleted
- `esm/Charting/Visuals/createSingle.js:222` — each createSingle chart starts its own module and its own perpetual rAF loop

## Review notes

- Found by reviewer slice `x1-frame-path`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

