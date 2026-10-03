# 055 · WebGPU: each chart's canvas is registered in wasmContext.specialHTMLTargets and never removed on delete

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/createMaster.js:288` |
| Severity | **medium** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (confirmed) |
| Rule | LIFE-05, SC-28 (web-performance skill) |
| Effort to fix | small |

## Code

```js
        const dest = wasmContext.SCRTSurfaceDestination.implement(newDestination);
        if (WebGpuHelper.getWebGpuSupported()) {
            // 1. Register the canvas element so C++ can resolve the "#<id>" selector via
            //    wgpuInstanceCreateSurface / WGPUSurfaceDescriptorFromCanvasHTMLSelector.
            wasmContext.specialHTMLTargets["#" + canvasElementId] = sciChartSurface.domCanvas2D;
        }
```

## Call path and frequency

SciChartSurface.create -> createMultichart -> createChildSurface (createMaster.js:385-457) -> addNativeDestination (:278-293) sets specialHTMLTargets['#<root>_2D'] = canvas. On delete: SciChartSurfaceBase.delete -> 2D deletable (createMaster.js:415-455) -> resyncNativeDestinations re-registers only the survivors, and the deleted key stays. clearRootElement detaches the canvas (SciChartSurfaceBase.js:592-606), but the Module still references it. Once per create; retention grows per create/delete cycle with a new root id. autoDisposeWasmContext defaults to false, so the Module lives for the session.

## Why it costs

The detached canvas cannot be garbage-collected while the module map references it, so retained memory grows with every mount and unmount (a LIFE-10 slope). The per-entry size depends on what the canvas context keeps after the native surface release, which is C++ side (H for the magnitude; the retention itself is certain).

**Scale where it matters:** WebGPU backend only. Apps whose chart roots get unique ids (generated ids in component lists, per-route ids) retain one detached HTMLCanvasElement per chart ever created, plus whatever its WebGPU canvas context still holds after the native swap chain is released.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/createMaster.js
+++ b/esm/Charting/Visuals/createMaster.js
@@ 2D deletable in createChildSurface
                         delete: () => {
                             resyncNativeDestinations(canvas2dId);
+                            // resync re-registered the survivors; stop the module retaining this canvas
+                            if (WebGpuHelper.getWebGpuSupported()) {
+                                delete wasmContext.specialHTMLTargets["#" + canvas2dId];
+                            }
@@ registerExternalDestination
                     unregister: () => {
                         externalDestinations.delete(canvasElementId);
+                        if (WebGpuHelper.getWebGpuSupported()) {
+                            delete wasmContext.specialHTMLTargets["#" + canvasElementId];
+                        }
                     }
```

**Trade-off:** None. A same-root replacement deletes the old surface before the new one registers, so the key is set again by addNativeDestination.

## App-side workaround

Reuse stable root div ids so the key is overwritten, or stay on the WebGL2 backend (SC-40).

## Verify

measure.md#mem with the WebGPU backend: mount and unmount a chart whose root id changes each time, 10 + 10 cycles. Pass: S1 -> S2 shows no detached canvas under objectsRetainedByDetachedDomNodes, and Object.keys(wasmContext.specialHTMLTargets).length returns to its baseline.

## Other locations

- `esm/Charting/Visuals/createMaster.js:588` — same registration for external (3D) destinations; unregister() at :608-610 only deletes the externalDestinations entry
- `esm/Charting/Visuals/createMaster.js:417` — 2D delete deletable: resyncs survivors but never deletes the deleted canvas key
- `_glue-pretty/scichart.js:6816` — specialHTMLTargets is a module-level registry of the shared master Module (exported at :10102), alive for the session unless the context is disposed

## Review notes

- Found by reviewer slice `x2-data-and-lifecycle`.
- Adversarial verification (confirmed): Re-read createMaster.js:278-293 (code_quote matches :284-289 verbatim; specialHTMLTargets set at :288 under WebGpuHelper.getWebGpuSupported()) and :581-612 (addExternalDestinationNative sets the key at :588; unregister at :608-610 only deletes the externalDestinations entry). rg over esm and _glue-pretty finds no delete of a specialHTMLTargets key anywhere: the glue declares the registry once as a module-closure var (_glue-pretty/scichart.js:6816), reads it in findEventTarget (:6820) and exports it (:10102). Call chain confirmed: createMultichart -> createChildSurface (createMaster.js:138 -> :384) -> addNativeDestination (:456 -> :278). Delete chain: SciChartSurfaceBase.delete (:470) removeDestination (:473) -> deletables (:481) -> 2D deletable (createMaster.js:415-455) -> resyncNativeDestinations (:623-654) re-adds only survivors via addNativeDestination (:632), so the deleted '#<root>_2D' key keeps pointing at the detached canvas; 3D deletable (:516-544) likewise. Key is `${rootId}_2D` (sciChartInitCommon.js:24, root id taken from the user's div at :100, never generated), so growth needs unique root ids per mount, as the scale field says. autoDisposeWasmContextValue defaults to false (SciChartSurfaceBase.js:819), so the Module lives for the session. Fix checked: same-id replacement deletes the old surface (:409) before addNativeDestination for the new one (:456), so the key is set again; the delete runs after resync and before the auto-dispose branch, so the proxy is still live. Rule LIFE-05 Do ('never keep removed elements in ... module state') fits exactly. Medium kept: WebGPU-only (IS_WEB_GPU: flag or auto mode on Mac, constants/app.js:37) and app-dependent ids, retained bytes per entry unknown (H part already stated).

