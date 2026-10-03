# 086 · Each per-frame Draw and CopyToDestination callback builds a new array of all destinations and scans it linearly, which is O(N^2) work with N fresh arrays per frame

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/createMaster.js:563` |
| Severity | **low** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (minor GC) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | V8-07 (web-performance skill) |
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

Engine frame -> native Draw(canvasId) for each invalidated create() surface -> createMaster.js:563 getDestinations("2d") -> Globals.js:70, which loops over every destination of every kind and pushes into a new array -> .find. Then native CopyToDestination for the same surface -> copyCanvasUtils.js:12 -> createMaster.js:355 getAnyDestinationById -> :685 getDestinationById -> Globals.js:70 again. Two calls per drawn surface per frame.

## Why it costs

getDestinations always returns a fresh array (by design, so callers cannot mutate the store). Using it as a per-frame lookup turns two id lookups per drawn surface into array allocation plus a full scan, and the work grows with the square of the surface count.

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
--- esm/Charting/Visuals/createMaster.js:563
-                    const dest = getDestinations("2d").find(d => d.canvasElementId === canvasId);
+                    const dest = getDestinationByCanvasId("2d", canvasId);
--- esm/Charting/Visuals/createMaster.js:685
-const getDestinationById = (destinationId) => getDestinations("2d").find(dest => dest.canvasElementId === destinationId);
+const getDestinationById = (destinationId) => getDestinationByCanvasId("2d", destinationId);
```

**Trade-off:** None. Lookup semantics are unchanged (first registered match of the kind). A Map keyed by canvas id would also remove the scan, but it would need to be kept in sync in addDestination, removeDestination and clearDestinations.

## App-side workaround

Put dense panes into sub-charts on one parent surface (SC-17). That reduces the number of destinations, and with it the Draw/Copy callbacks per frame.

## Verify

measure.md#fps, `stream` on 100 create() surfaces for 10 s, 5 runs per side. Pass: Minor GC time per 10 s in trace-summary goes down, and frame p95 is not worse.

## Other locations

- `esm/Core/Globals.js:70` — getDestinations allocates a new array on every call
- `esm/Charting/Visuals/createMaster.js:685` — getDestinationById used by the per-frame copy
- `esm/Charting/Visuals/copyCanvasUtils.js:12` — doCopy looks the destination up on every copy
- `esm/Charting/Visuals/createMaster.js:563` — same root cause, also reported by slice x2-data-and-lifecycle: Per-frame Draw and Copy callbacks find each chart by copying and scanning the global destination list (O(N^2) per frame for N charts)
- `esm/Core/Globals.js:70` — getDestinations allocates a result array and walks the whole registry with nested forEach closures
- `esm/Charting/Visuals/createMaster.js:685` — getDestinationById: second copy and scan per chart per frame, via CopyToDestination (:373 -> copyCanvasUtils.js:12 -> getAnyDestinationById :355), WebGL path

## Review notes

- Found by reviewer slice `x1-frame-path`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.
- Duplicate merged from slice `x2-data-and-lifecycle`: Per-frame Draw and Copy callbacks find each chart by copying and scanning the global destination list (O(N^2) per frame for N charts)
