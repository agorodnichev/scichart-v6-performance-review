# 055 · WebGPU: each chart's canvas is registered in wasmContext.specialHTMLTargets and never removed on delete

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/createMaster.js:288` |
| Severity | **medium** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
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
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

