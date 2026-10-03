# 027 · The engine's rAF main loop asks for a frame every vsync for the life of the wasm module, including when nothing is invalidated and after every chart has been deleted

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `_glue-pretty/scichart.js:5916` |
| Severity | **high** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | frame time (idle main-thread wake-ups every vsync, battery and thermal on idle dashboards) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/a9c69252ac92e115113c4e4ff04161b5/): reproduced on WebGL and WebGPU ([source](../demos/027-engine-raf-loop-never-stops/)) |
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

createMaster.js:663 wasmContext.callMain() (once per shared engine) or createSingle.js:222 (once per createSingle chart) -> wasm __main_argc_argv (f2905) ends with emscripten_set_main_loop(2216, -1, 1). I decoded this from _wasm/scichart-nosimd.wasm; import 106 has no other caller. -> _glue-pretty/scichart.js:6094 _emscripten_set_main_loop -> setMainLoop:5864 -> fps<=0 selects _emscripten_set_main_loop_timing(1, 1) :5924 -> MainLoop_scheduler_rAF :5821-5822 -> MainLoop.requestAnimationFrame :6008 -> each frame MainLoop.runner -> runIter(table[2216] = f4137 -> f1430) :5916 -> scheduler() :5918 -> rAF again. The only stop is emscripten_cancel_main_loop (:6031). Its single wasm caller f4139 is the TSRRequestExit binding (embind table index 604). TSRRequestExit is called in cleanupWasmContext (createMaster.js:335), which runs only via SciChartSurface.disposeSharedWasmContext (SciChartSurface.js:96-99 -> disposeMultiChart createMaster.js:205-207). delete() calls that only when autoDisposeWasmContext is on (createMaster.js:422-435). TSRRequestExit is also called in each createSingle chart's delete() (createSingle.js:183). No code in esm/ calls Module.pauseMainLoop or resumeMainLoop (glue :10073-10074). Frequency: once per display frame on a visible tab, for as long as the engine exists. That is 1 loop for all create() surfaces (2D and 3D share it), plus 1 per live createSingle() chart.

## Why it costs

Draws are already gated. The engine tick (table index 2216 = wasm f4137 -> f1430) enters its render path only when TSRRequestCanvasDraw has queued a canvas id or TSRRequestDraw has set the force flag. Otherwise it returns after a few loads: the exit flag, the force flag, and whether the request vector is empty. So the frame that matters is coalesced correctly, and the CPU work of an idle tick is small. The loop itself, though, never parks. The runner re-requests rAF after every tick, and with an animation frame callback always waiting, the browser cannot skip the update-the-rendering steps of any frame (CNV-02). The main thread therefore wakes on every display refresh for the whole session to run the glue runner, a wasm call and an otherwise empty frame. On an idle or static dashboard all of that is overhead, which costs battery and thermal headroom and keeps the page from ever reaching an idle state with no frames. disableEngineLoop does not help: createMaster.js:136 and createSingle.js:124 only call TSRSetDrawRequestsEnabled(false), so the emscripten rAF loop keeps ticking even for apps that own their frame loop.

**Scale where it matters:** Any page with a live engine in a visible tab (rAF does not run in hidden tabs). It matters most for idle or static dashboards, battery-powered devices and long SPA sessions. SciChartSurfaceBase.autoDisposeWasmContextValue defaults to false (SciChartSurfaceBase.js:819), so the shared loop keeps running after the last create() chart is deleted, for example on every route after a chart route has been visited. Each live createSingle() chart adds one more loop.

## Fix (library side)

```diff
--- shipped glue: esm/_glue/scichart.js, esm/_glue/scichart-64.js, cjs/_glue/* (minified; shown at _glue-pretty/scichart.js:5916, setMainLoop -> MainLoop.runner)
-        MainLoop.runIter(iterFunc);
-        if (!checkIsRunning()) return;
-        MainLoop.scheduler();
+        // Render on demand. A request made before this tick is drawn by it; a request made
+        // while it draws is queued by the engine for the next tick. Park only after a tick
+        // that had neither.
+        var hadRequest = MainLoop.drawRequested;
+        MainLoop.drawRequested = false;
+        MainLoop.runIter(iterFunc);
+        if (!checkIsRunning()) return;
+        if (Module["parkMainLoopWhenIdle"] && !hadRequest && !MainLoop.drawRequested) {
+          MainLoop.parked = true;
+          return;
+        }
+        MainLoop.scheduler();
       };
--- same files (_glue-pretty/scichart.js:5949, MainLoop.resume)
       resume() {
+        MainLoop.parked = false;
         MainLoop.currentlyRunningMainloop++;
--- same files (_glue-pretty/scichart.js:10074)
     Module["resumeMainLoop"] = MainLoop.resume;
+    Module["requestMainLoopTick"] = () => {
+      MainLoop.drawRequested = true;
+      if (MainLoop.parked && MainLoop.scheduler) {
+        MainLoop.parked = false;
+        MainLoop.scheduler();
+      }
+    };
--- esm/Charting/Visuals/createMaster.js:663
+            // Every queued engine draw goes through TSRRequestCanvasDraw: wake the loop there,
+            // once, for all callers (RenderSurface.js:24, WebGlRenderContext2D.js:547,
+            // SciChart3DSurface.js:587/593). TSRRequestDraw draws synchronously and needs no wake.
+            const requestCanvasDraw = originalWasmContext.TSRRequestCanvasDraw;
+            originalWasmContext.TSRRequestCanvasDraw = (canvasId) => {
+                requestCanvasDraw(canvasId);
+                originalWasmContext.requestMainLoopTick();
+            };
+            originalWasmContext.parkMainLoopWhenIdle = true;
             wasmContext.callMain();
--- esm/Charting/Visuals/createSingle.js:222 (initDrawEngineSingleChart: wasmContext is the revocable proxy, which forwards gets and sets to the module)
+    const requestCanvasDraw = wasmContext.TSRRequestCanvasDraw;
+    wasmContext.TSRRequestCanvasDraw = (canvasId) => {
+        requestCanvasDraw(canvasId);
+        wasmContext.requestMainLoopTick();
+    };
+    wasmContext.parkMainLoopWhenIdle = true;
     wasmContext.callMain();
(Do not park on the surfaces' JS isInvalidated flags, as an earlier draft of this fix did. SciChartRenderer.render sets isInvalidated=false before onAnimate (:115), true after it (:119) and false again at :188. An animation step that invalidates during onAnimate queues its next frame in the engine, but the JS flag ends the frame false, so that predicate parks the loop and freezes every animation after one frame. The engine-side equivalent of this change is emscripten_pause_main_loop() when the request vector is empty, and emscripten_resume_main_loop() in TSRRequestCanvasDraw.)
```

**Trade-off:** Every draw request must go through the wrapped TSRRequestCanvasDraw. In 6.0.6 that holds: in the wasm, only TSRRequestCanvasDraw (f2415, reached only from its embind binding) and the tick itself push into the request vector, and TSRRequestDraw draws synchronously. A future engine-side enqueue path would need its own wake, and a missed wake shows a stale frame until the next invalidation. The loop runs one idle tick after each burst before it parks. While parked, a request made inside another rAF callback, such as the app's own frame loop, is drawn on the next frame rather than possibly the current one. Steady streaming and animations keep the loop running, so their frame rate is unchanged. The glue is generated by Emscripten, so carry the change as a build step (a --js-library or --post-js override, or the engine-side emscripten_pause_main_loop/emscripten_resume_main_loop) rather than as a hand edit of four glue files.

## App-side workaround

To stop the loop after the last chart is gone, set SciChartSurface.autoDisposeWasmContext = true (optionally with wasmContextDisposeTimeout). The trade-off (SC-31) is that the next chart route starts a new engine. While charts stay mounted but are not visible, for example on a kept-alive hidden route or with every chart scrolled off-screen, an app can call wasmContext.pauseMainLoop() and then wasmContext.resumeMainLoop() before they show again. These are Emscripten Module APIs exposed at glue :10073-10074, not documented SciChart API. While the loop is paused, invalidations wait in the engine queue and draw on the first tick after resume. Pause only when no chart on that context is visible, and call resume only after a pause. Prefer create() over many createSingle() charts, because each live createSingle chart runs its own loop.

## Verify

measure.md#fps, idle check. Load one static create() chart, mark wp:start/wp:end around 5 s with no input and no data, and trace without the frame probe. Then delete every chart (default autoDisposeWasmContext=false) and repeat. Pass: trace-summary counts 0 "Animation frame fired" in both idle windows; today the count is about one per display refresh. Regression check for the fix: on a chart with a series animation (e.g. SweepAnimation) and a zoomExtents(500) animation, every animation runs to the end with one draw per frame. A second chart updated from setInterval shows each update on the next frame. After that, the idle window again counts 0.

## Other locations

- `_glue-pretty/scichart.js:5924` — fps=-1 from wasm main selects rAF timing, every frame
- `esm/_glue/scichart.js:1` — shipped minified glue (also esm/_glue/scichart-64.js and cjs/_glue/*): same MainLoop.runIter(iterFunc);if(!checkIsRunning())return;MainLoop.scheduler() runner; the fix belongs here or in the Emscripten build
- `esm/Charting/Visuals/createMaster.js:136` — disableEngineLoop only toggles draw requests; the rAF loop keeps running
- `esm/Charting/Visuals/SciChartSurfaceBase.js:819` — autoDisposeWasmContextValue = false keeps the engine (and its loop) alive after all charts are deleted
- `esm/Charting/Visuals/createSingle.js:222` — each createSingle chart starts its own module and its own every-frame rAF loop, which runs until that chart is deleted (TSRRequestExit at createSingle.js:183)
- `esm/Charting/Services/SciChartRenderer.js:188` — isInvalidated is reset at the end of each frame even when onAnimate queued the next one (:115/:119), so it cannot be the park predicate

## Review notes

- Found by reviewer slice `x1-frame-path`.
- Adversarial verification (corrected): Re-read _glue-pretty/scichart.js:5800-6036 (set_main_loop_timing, setMainLoop, MainLoop, cancel) and :6094-6099, :10072-10074. The code_quote matches verbatim at :5916-5919, and the unconditional MainLoop.scheduler() is at :5918. I moved primary.line to 5916, where the quote starts. The shipped minified glue esm/_glue/scichart.js contains the same runner code. I decoded _wasm/scichart-nosimd.wasm with throwaway parsers (agent-scratch/wasmcg.cjs and v027/*.cjs). Import env.emscripten_set_main_loop (106) has one caller, __main_argc_argv (f2905), which ends with i32.const 2216, i32.const -1, i32.const 1, call emscripten_set_main_loop, so fps=-1 selects rAF timing and the loop ticks every frame. Table index 2216 is f4137, the tick: it does `if (byte[225832]==1) f1430()`. In f1430 the whole render path sits inside one block. On idle the tick leaves that block after it checks the exit flag 544746, the force flag 544745 and whether the request vector 550364/550368 is empty, so an idle tick costs only a few loads. I closed the open point "idle branch not analysed" in why_it_costs with this. The only main-loop imports are set_main_loop and cancel_main_loop; there is no pause or resume import. cancel_main_loop has one caller, f4139: it stores 1 to 544746 and then cancels. Embind registers f4139 as TSRRequestExit (string at data address 4184 -> table index 604 -> f4139). TSRRequestDraw is f4140 (table index 605): it sets the force flag and calls f1430 synchronously. TSRRequestCanvasDraw is f2415 (table index 606): it dedups and pushes the canvas id into the request vector, or into the deferred vector 544676/544680 while a draw is running. f1430 moves the deferred vector into the request vector at the end of each draw tick. The only code that pushes into the request vector is f2415 and f1430 (callers of f2414), and f2415 has no wasm callers: only its embind binding reaches it. JS side: rg finds no call to pauseMainLoop or resumeMainLoop in esm/. createMaster.js:136 and createSingle.js:124 only call TSRSetDrawRequestsEnabled. TSRRequestExit runs from cleanupWasmContext (createMaster.js:335), whose only caller is disposeMultiChart (:205-207) <- SciChartSurface.disposeSharedWasmContext (SciChartSurface.js:96-99). delete() calls that only when autoDisposeWasmContext is on (createMaster.js:422-435, :529-541), and SciChartSurfaceBase.js:819 defaults it to false. createSingle.js:183 calls TSRRequestExit in each createSingle chart's delete(), so those loops end when their chart is deleted. I corrected the createSingle other_location ("perpetual"). Rule CNV-02: "an unconditional re-request at its end is the bad case". Its Avoid section does not cover this case. Severity stays high because the loop runs per frame for the whole session (review.md §B), and evidence stays S because the mechanism is certain. Fix: the original fix_diff parked the loop when every shared-engine surface had isInvalidated=false. That is unsound. SciChartRenderer.js:115/119/188 resets isInvalidated to false at the end of a frame even when onAnimate (SciChartSurface.js:952-966 -> GenericAnimation.update) has queued the next frame through invalidateElement -> TSRRequestCanvasDraw. The predicate then parks with a request still queued, and the wakeMainLoop call made during onAnimate does nothing because the loop has not parked yet, so animations freeze after one frame. I replaced it with request-based parking: a single TSRRequestCanvasDraw wrapper on the module wakes the loop, and the loop parks only after a tick that had no request before it and none during it. That covers all four call sites without editing them. I also clear the parked flag in MainLoop.resume. Other corrections: why_it_costs (idle tick analysed, visible tabs only), call_path (verified hops), trade_off (latency of the first frame after a park when the request is made inside a rAF callback; the glue is generated code), verify (animation and streaming regression check), app_workaround (pauseMainLoop/resumeMainLoop on hidden routes) and other_locations (shipped glue, createSingle.js:183).

