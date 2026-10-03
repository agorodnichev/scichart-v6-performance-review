# 079 · Deleting one create() chart clears and re-adds the native destination of every other chart: O(N) per delete, O(N^2) per dashboard teardown

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/createMaster.js:417` |
| Severity | **medium** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | INP (route change or panel close that unmounts charts), also frame time under WebGPU |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | V8-01 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
                    const sciChartSurface = createChildSurfaceInner(wasmContext, canvases, family.surfaceConstructor, theme);
                    sciChartSurface.addDeletable({
                        delete: () => {
                            resyncNativeDestinations(canvas2dId);
```

## Call path and frequency

surface.delete() -> SciChartSurfaceBase.delete: removeDestination(this) (SciChartSurfaceBase.js:473), then the deletables (:481) -> 2D deletable resyncNativeDestinations(canvas2dId) (createMaster.js:417) -> clearDestinations('2d') (Core/Globals.js:46-55) -> chartInitObj.ClearDestinations() (createMaster.js:631) -> addNativeDestination per survivor (:632 -> :278-293) -> readdExternalDestinations (:633) -> WebGPU only: requestAnimationFrame that force-invalidates all survivors (:641-653). Once per deleted chart, synchronously inside the app's unmount handler.

## Why it costs

Every re-add crosses into wasm several times and allocates an embind wrapper and a destination object. The teardown work is quadratic in N and runs inside the interaction that unmounts the view, which adds to that interaction's processing time. Under WebGPU, ClearDestinations releases every canvas swap chain, so charts whose data did not change render again.

**Scale where it matters:** N charts sharing the master context (dashboards; SC-16 recommends create()). Unmounting a view of N charts in one task does N(N-1)/2 implement() + AddDestination pairs, for example 1,225 for 50 charts. Under WebGPU, removing one chart from a live dashboard re-creates every survivor's swap chain and redraws all N-1 charts.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/createMaster.js
+++ b/esm/Charting/Visuals/createMaster.js
@@ 2D deletable
                         delete: () => {
-                            resyncNativeDestinations(canvas2dId);
+                            // The deleted surface already left the registry (SciChartSurfaceBase.delete -> removeDestination),
+                            // so one deferred resync per task rebuilds the native list once for all deletes
+                            scheduleNativeResync();
@@ 3D deletable
                         if (!isCreatingChildSurface) {
-                            resyncNativeDestinations();
+                            scheduleNativeResync();
                         }
@@ next to resyncNativeDestinations
+            let nativeResyncScheduled = false;
+            const scheduleNativeResync = () => {
+                if (nativeResyncScheduled) return;
+                nativeResyncScheduled = true;
+                queueMicrotask(() => {
+                    nativeResyncScheduled = false;
+                    // skip when the shared context was disposed in the meantime (autoDisposeWasmContext)
+                    if (sciChartMaster.wasmContext === wasmContext) {
+                        resyncNativeDestinations();
+                    }
+                });
+            };
```

**Trade-off:** Until the microtask runs, the native list still holds the deleted canvas's destination. No rAF or engine draw can run before a microtask, so nothing renders from it. Removing a single chart under WebGPU still churns every swap chain; avoiding that needs a native RemoveDestination API (C++ change).

## App-side workaround

Put dense multi-chart views on one parent surface with sub-charts (SC-17), which use one destination. There is no app-side workaround for the teardown cost itself.

## Verify

measure.md#inp: a view with 50 create() charts and a click that unmounts it (route change), 5 runs per side. Pass: compare-runs 'win' on the interaction's processing duration. Also measure.md#fps under WebGPU while removing one chart from a 30-chart dashboard: no frame in which all survivors redraw.

## Other locations

- `esm/Charting/Visuals/createMaster.js:631` — chartInitObj.ClearDestinations() followed by addNativeDestination for every survivor (:632) and readdExternalDestinations (:633)
- `esm/Charting/Visuals/createMaster.js:278` — each re-add: createChartDestination object, SCRTSurfaceDestination.implement embind wrapper, AddDestination, SetFPSCounterEnabled, registry spread copy
- `esm/Charting/Visuals/createMaster.js:641` — WebGPU: rAF that force-invalidates every surviving chart after each resync
- `esm/Charting/Visuals/createMaster.js:527` — 3D external deletable runs the same full resync
- `esm/Core/Globals.js:51` — clearDestinations unshifts per removed entry, quadratic in the registry size

## Review notes

- Found by reviewer slice `x2-data-and-lifecycle`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

