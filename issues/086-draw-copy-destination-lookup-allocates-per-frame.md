# 086 · Each per-frame Draw and CopyToDestination callback copies the 2d destination list into a new array and scans it, so N streaming create() surfaces cost 2N array allocations and O(N^2) comparisons per frame

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/createMaster.js:563` |
| Severity | **low** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (minor GC) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Rule | V8-01 (web-performance skill) |
| Effort to fix | small |

## Code

```js
                Draw(canvasId) {
                    var _a;
                    Logger.debug("Draw", canvasId);
                    const dest = getDestinations("2d").find(d => d.canvasElementId === canvasId);
                    if (dest) {
                        dest.sciChartSurface.renderSurface.onRenderTimeElapsed();
                        return;
                    }
```

## Call path and frequency

SciChartSurface invalidate -> RenderSurface.invalidateElement (RenderSurface.js:24) -> wasm TSRRequestCanvasDraw -> native render loop -> Draw(canvasId) for each requested canvas (createMaster.js:560) -> :563 getDestinations("2d") (Globals.js:70, allocates a result array and walks every destination of every kind) -> .find. Then, in WebGL mode only (copy interface installed at createMaster.js:659-660 when WebGPU is unsupported), native CopyToDestination for the same surface -> copyCanvasUtils.js:12 -> getAnyDestinationById (createMaster.js:355) -> getDestinationById (:685) -> Globals.js:70 again. Two lookups per drawn surface per frame under WebGL, one under WebGPU.

## Why it costs

getDestinations always returns a fresh array (by design, so callers cannot mutate the store) built with push inside two forEach closures. Using it as a per-frame id lookup turns each of the two lookups per drawn surface into an array allocation plus a full scan of all destinations, so the work grows with the square of the surface count. The arrays die young, so the cost is the scan plus a steady allocation rate that triggers more frequent scavenges, not old-generation promotion.

**Scale where it matters:** N create() surfaces drawn in the same frame give 2N array allocations of N entries and 2N linear scans per frame. This is negligible for a handful of charts and becomes steady young-generation garbage on dashboards with 50-100+ streaming charts.

## Fix (library side)

```diff
--- esm/Core/Globals.js (new helper)
+/** Allocation-free lookup for the per-frame Draw/Copy callbacks. @ignore */
+export function getDestinationByCanvasId(kind, canvasElementId) {
+    for (let i = 0; i < destinations.length; i++) {
+        const d = destinations[i];
+        if (d.kind === kind && d.canvasElementId === canvasElementId) return d;
+    }
+    return undefined;
+}
--- esm/Charting/Visuals/createMaster.js:17
-import { addDestination, clearDestinations, getDestinations, getOtherDestinations, getSharedEngineDestinations, removeDestination } from "../../Core/Globals";
+import { addDestination, clearDestinations, getDestinationByCanvasId, getDestinations, getOtherDestinations, getSharedEngineDestinations, removeDestination } from "../../Core/Globals";
--- esm/Charting/Visuals/createMaster.js:563
-                    const dest = getDestinations("2d").find(d => d.canvasElementId === canvasId);
+                    const dest = getDestinationByCanvasId("2d", canvasId);
--- esm/Charting/Visuals/createMaster.js:685
-const getDestinationById = (destinationId) => getDestinations("2d").find(dest => dest.canvasElementId === destinationId);
+const getDestinationById = (destinationId) => getDestinationByCanvasId("2d", destinationId);
```

**Trade-off:** Lookup semantics are unchanged: the first registered 2d destination with that canvas id, as before. The fix removes the per-call arrays and closures but each lookup is still a linear scan, so the per-frame work stays O(N^2) pointer compares, just without allocation. A Map keyed by canvas id would remove the scan, but it must be kept in sync in addDestination, removeDestination and clearDestinations, and must keep first-registered semantics because duplicate canvas ids can coexist briefly (createMaster.js:389 handles sameIdDestinations).

## App-side workaround

Put dense panes into sub-charts on one parent surface (SC-17). That reduces the number of destinations, and with it the Draw/Copy callbacks per frame.

## Verify

measure.md#fps, `stream` on 100 create() surfaces for 10 s, 5 runs per side. Pass: Minor GC time per 10 s in trace-summary goes down, and frame p95 is not worse.

## Other locations

- `esm/Core/Globals.js:70` — getDestinations allocates a result array and walks the whole registry with nested forEach closures on every call
- `esm/Charting/Visuals/createMaster.js:685` — getDestinationById: second copy and scan per drawn surface per frame, reached from CopyToDestination (:373 -> copyCanvasUtils.js:12 -> getAnyDestinationById :355)
- `esm/Charting/Visuals/copyCanvasUtils.js:12` — doCopy looks the destination up on every copy
- `esm/Charting/Visuals/createMaster.js:660` — copy interface installed only without WebGPU, so the second lookup is WebGL-only

## Review notes

- Found by reviewer slice `x1-frame-path`.
- Adversarial verification (corrected): Re-read createMaster.js:560-567 (quote matches verbatim apart from CRLF line endings; key line 563), createMaster.js:348-374 (getAnyDestinationById -> module-level getDestinationById, canvasCopyObj built from copyToCanvas), createMaster.js:659-660 (copy interface installed only when WebGPU is not supported), createMaster.js:685, copyCanvasUtils.js:3-12 (doCopy calls getDestinationById on every copy), Globals.js:32-35 (single module-level destinations array, entries carry kind) and Globals.js:70-80 (getDestinations always allocates a result array and walks every destination of every kind through two forEach closures). Call rate: SciChartSurface invalidation -> RenderSurface.invalidateElement -> wasm TSRRequestCanvasDraw (RenderSurface.js:24) -> native render loop calls the implemented Draw(canvasId) (createMaster.js:560/577) for each requested canvas -> onRenderTimeElapsed -> handleDraw; SciChartSurface.js:1359-1365 states that in WebGL mode renderedToDestination is raised by the copy step, i.e. CopyToDestination -> doCopy runs once per drawn copy-canvas surface per frame. No caching, dirty flag or Map short-circuits either lookup. Mechanism confirmed: per streaming create() surface per frame, 2 fresh arrays sized to the 2d destination count (1 under WebGPU) plus 2 linear scans, so 2N allocations and O(N^2) comparisons per frame. Corrections: (1) rule V8-07 -> V8-01: the temporary array is never stored into a long-lived structure, so V8-07's survive-and-promote mechanism does not apply; it dies young (V8-06), and the real problem is a per-frame find() scan that V8-01 tells you to replace. (2) Title said N fresh arrays per frame; it is 2N in WebGL mode (Draw plus CopyToDestination). (3) fix_diff lacked the import of the new helper in createMaster.js:17. (4) trade_off claimed the fix has no cost and removes the O(N^2); the allocation-free scan removes the arrays and closures but each lookup is still O(N), and a Map is not a drop-in because duplicate canvas ids can coexist briefly (createMaster.js:389 handles sameIdDestinations), so the Map would need first-registered semantics. (5) Deduplicated other_locations (merge had repeated Globals.js:70 and createMaster.js:685 and the primary) and added the WebGPU guard. Severity kept low: the path is per frame, but the extra work per drawn surface is one small array and an N-element pointer compare, which is small next to that surface's own render; it only grows noticeable at very high create() surface counts. Evidence kept S: the allocation and scan happen on every Draw/Copy call on the established path.
- Duplicate merged from slice `x2-data-and-lifecycle`: Per-frame Draw and Copy callbacks find each chart by copying and scanning the global destination list (O(N^2) per frame for N charts)
