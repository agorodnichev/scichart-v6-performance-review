# 081 · A createSingle() canvas reloads the whole page on webglcontextlost, although monitorWebGL already handles loss and restore; past the context cap this becomes a reload loop

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/sciChartInitCommon.js:195` |
| Severity | **low** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | startup (a full reload) (also memory) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/1033dfaea1fb839dbbc1df81cc0d0e02/): WebGL: reproduced, WebGPU: inconclusive ([source](../demos/081-createsingle-context-loss-reloads-page/)) |
| Rule | GPU-29 (also SC-16) (web-performance skill) |
| Effort to fix | small |

## Demo findings

Removing the reload alone, as the fix proposes, leaves the createSingle chart blank: with the reload cancelled it drew 0 frames after restoreContext (Chrome: "bindBufferBase: object does not belong to this context"), while a create() chart recovered. The createSingle restore path needs fixing too. See the [demo](https://jsfiddle.net/gh/gist/library/pure/1033dfaea1fb839dbbc1df81cc0d0e02/).

## Code

```js
    if (activeCanvas === ECanvasType.canvasWebGLorWebGPU) {
        canvasWebGL.addEventListener("webglcontextlost", event => {
            console.warn("WebGL context lost. Reloading the page.");
            event.preventDefault();
            location.reload();
        }, !1);
    }
```

## Call path and frequency

SciChartSurface.createSingle / SciChartPolarSurface.createSingle / SciChart3DSurface.createSingle -> createSingleInternal (createSingle.js:28 passes activeCanvas undefined) -> initCanvas default ECanvasType.canvasWebGLorWebGPU (sciChartInitCommon.js:81, :195-201) adds the reload listener. createSingle.js:127 monitorWebGL(wasmContext, false) adds lost/restored handlers on the same canvas (createMaster.js:242-266). Fires once per context-loss event per createSingle canvas: GPU reset, driver update, GPU switch, or eviction of the oldest context when the page passes the browser's active WebGL context limit. create() surfaces use ECanvasType.canvas2D and are not affected.

## Why it costs

location.reload() throws away all app state and repeats the full startup (HTML, JS evaluation, wasm fetch, compile and instantiate, data loading), and it fires before webglcontextrestored can arrive, so monitorWebGL's restoreContext never gets to run. Past the context cap the reload repeats without end. Context loss is a rare path, hence low severity, but each occurrence costs a full page load.

**Scale where it matters:** Any page with createSingle charts in WebGL mode (WebGPU canvases never fire webglcontextlost). With more live WebGL contexts than the browser keeps (createSingle charts plus the create() master canvas plus any other WebGL on the page), creating the next one evicts the oldest, which reloads the page, which re-creates the charts and evicts again.

## Fix (library side)

```diff
--- esm/Charting/Visuals/sciChartInitCommon.js
-    if (activeCanvas === ECanvasType.canvasWebGLorWebGPU) {
-        canvasWebGL.addEventListener("webglcontextlost", event => {
-            console.warn("WebGL context lost. Reloading the page.");
-            event.preventDefault();
-            location.reload();
-        }, !1);
-    }
+    // createSingle: loss and restore are handled by monitorWebGL(wasmContext, false) (createSingle.ts)
--- esm/Charting/Visuals/createMaster.js (monitorWebGL: a single chart's handlers must touch only its own surface)
-    const getMonitoredDestinations = () => (isMaster ? getDestinations("2d") : getDestinations("2dSingle"));
+    const getMonitoredDestinations = () => isMaster
+        ? getDestinations("2d")
+        : getDestinations("2dSingle", "3dSingle").filter(d => d.canvasElementId === wasmContext.canvas.id);
@@ restoreContext
-        for (const dest of getDestinations("3d")) {
-            dest.sciChartSurface.invalidateElement({ force: true });
-        }
+        if (isMaster) {
+            for (const dest of getDestinations("3d")) {
+                dest.sciChartSurface.invalidateElement({ force: true });
+            }
+        }
```

**Trade-off:** A context evicted by the context cap may never be restored: that one chart then stays blank instead of the page reloading, so apps that need recovery should add a watchdog that deletes and re-creates the surface (SC-16 notes some drivers never send webglcontextrestored). The monitorWebGL scoping is required: without it, losing one createSingle context sets isWebGLContextActive=false on every 2dSingle surface, and SciChartSurface.invalidateElement (SciChartSurface.js:574-576) then ignores their redraws until that one context restores, which after an eviction is never.

## App-side workaround

Use SciChartSurface.create() (shared context, no reload listener) unless a measurement shows createSingle is needed, and keep createSingle canvases well under the browser's context limit.

## Verify

measure.md#gpu setup (hardware renderer), two createSingle charts. In evaluate_script call `canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext()` on the first chart's canvas and restoreContext() 1 s later. Pass: no navigation happens (performance.timeOrigin unchanged), the second chart keeps redrawing during the loss, and the first chart draws a frame after the restore.

## Other locations

- `esm/Charting/Visuals/createMaster.js:225` — monitorWebGL for a single chart selects ALL 2dSingle destinations, not just its own
- `esm/Charting/Visuals/createMaster.js:238` — restoreContext of a single chart invalidates the master's 3D surfaces instead of its own
- `esm/Charting/Visuals/createSingle.js:127` — monitorWebGL(wasmContext, false) on the same canvas

## Review notes

- Found by reviewer slice `s02-init-loading`.
- Adversarial verification (corrected): Quote is sciChartInitCommon.js:195-201 (reviewer cited 196), primary corrected. Confirmed createSingleInternal calls initCanvas with activeCanvas undefined (createSingle.js:28), so the default canvasWebGLorWebGPU path adds the listener; createMultichart passes canvas2D (createMaster.js:99). Confirmed wasmContext.canvas = canvases.domCanvasWebGL (createSingle.js:44 and initDrawEngineSingleChart) and the destination's canvasElementId is that canvas id (createSingle.js:170-175), so the filter works. Found that the reviewer's fix was unsafe as written: monitorWebGL(…, false) uses getDestinations("2dSingle") for every single context (createMaster.js:225) and isWebGLContextActive=false gates invalidateElement (SciChartSurface.js:575), so removing the reload alone would freeze all createSingle charts after one eviction; the corrected diff scopes the handlers to the context's own canvas and drops the master-3D invalidation for single contexts. Severity lowered medium -> low: context loss is a rare path per review.md §B.

