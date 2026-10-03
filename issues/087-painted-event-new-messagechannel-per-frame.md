# 087 · While a painted listener exists, each surface creates a new MessageChannel every frame and never closes its ports

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/SciChartSurface.js:1367` |
| Severity | **low** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory (also frame time) |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/494964da455df534fb6ea4710de3f143/): reproduced on WebGL and WebGPU ([source](../demos/087-painted-event-messagechannel/)) |
| Rule | LIFE-15 (web-performance skill) |
| Effort to fix | small |

## Code

```js
        if (this.painted.handlers.length > 0 || PerformanceDebugHelper.enableDebug) {
            runAfterFramePaint(() => {
                var _a;
                PerformanceDebugHelper.mark(EPerformanceMarkType.Painted, { contextId: this.id });
                this.painted.raiseEvent((_a = this.sciChartRenderer) === null || _a === void 0 ? void 0 : _a.isInvalidated);
            });
        }
```

## Call path and frequency

Engine frame -> SciChartSurface.onRenderSurfaceDraw (esm/Charting/Visuals/SciChartSurface.js:1331) -> :1367-1373 runAfterFramePaint (esm/utils/performance.js:337-343). Once per rendered frame per surface, only while surface.painted has subscribers or PerformanceDebugHelper.enableDebug is true; the library itself never subscribes to painted.

## Why it costs

Each MessageChannel allocates a message pipe and two MessagePort wrappers. Setting port1.onmessage starts the port, and a started, entangled port stays alive until it is closed or its peer is collected, so each pair is released only after GC has collected port2 and then port1. That is allocation and GC churn per frame, not an unbounded leak. Reusing one channel per surface gives the same after-paint task with no per-frame allocation.

**Scale where it matters:** Apps or tooling that subscribe to surface.painted (for example to measure render-to-paint): N surfaces x the redraw rate, so 10 streaming charts at 60 Hz create 600 MessageChannels (1,200 ports) per second.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/SciChartSurface.js
+++ b/esm/Charting/Visuals/SciChartSurface.js
@@ onRenderSurfaceDraw()
         if (this.painted.handlers.length > 0 || PerformanceDebugHelper.enableDebug) {
-            runAfterFramePaint(() => {
-                var _a;
-                PerformanceDebugHelper.mark(EPerformanceMarkType.Painted, { contextId: this.id });
-                this.painted.raiseEvent((_a = this.sciChartRenderer) === null || _a === void 0 ? void 0 : _a.isInvalidated);
-            });
+            if (!this.paintedChannel) {
+                // one channel per surface, reused every frame
+                this.paintedChannel = new MessageChannel();
+                this.paintedChannel.port1.onmessage = () => {
+                    var _a;
+                    PerformanceDebugHelper.mark(EPerformanceMarkType.Painted, { contextId: this.id });
+                    this.painted.raiseEvent((_a = this.sciChartRenderer) === null || _a === void 0 ? void 0 : _a.isInvalidated);
+                };
+            }
+            this.paintedChannel.port2.postMessage(undefined);
         }
@@ delete(clearHtml = true)
+        if (this.paintedChannel) {
+            this.paintedChannel.port1.close();
+            this.paintedChannel.port2.close();
+            this.paintedChannel = undefined;
+        }
# Same change in esm/Charting3D/Visuals/SciChart3DSurface.js:648-653.
```

**Trade-off:** After delete(), a painted event still queued for the last frame is dropped instead of firing on a deleted surface. Otherwise the timing is the same: one task posted after each rendered frame. One idle channel stays open per surface while it lives.

## App-side workaround

Do not subscribe to surface.painted in production. Subscribe to surface.rendered and post to one app-owned MessageChannel (or use scheduler.postTask) to get the after-paint callback.

## Verify

measure.md#mem: subscribe a painted handler on 10 streaming surfaces, stream for 60 s, take heap snapshots S1 and S2; then measure.md#fps `stream`. Pass: compare_heapsnapshots shows no growing MessagePort/MessageChannel count from S1 to S2, minor-GC time per second does not grow, and frameP95Ms is neutral or 'win'. Not measured.

## Other locations

- `esm/utils/performance.js:337` — runAfterFramePaint: new MessageChannel (:338), port1.onmessage set (starts the port, :340), port2.postMessage (:342); neither port is closed
- `esm/Charting3D/Visuals/SciChart3DSurface.js:648` — same pattern for 3D surfaces (:649)
- `esm/utils/performance.js:337` — same root cause, also reported by slice s09-filters-numerics-utils: runAfterFramePaint creates a new, never-closed MessageChannel on every call (per frame per surface while a painted handler exists)
- `esm/Charting/Visuals/SciChartSurface.js:1367` — per-frame caller
- `esm/Charting3D/Visuals/SciChart3DSurface.js:648` — per-frame caller (3D)

## Review notes

- Found by reviewer slice `s01-surface-render`.
- Adversarial verification (corrected): Quote matches verbatim starting at SciChartSurface.js:1367 (primary moved from :1368). Read runAfterFramePaint (esm/utils/performance.js:337-343): new MessageChannel per call, onmessage on port1, postMessage on port2, no close. Confirmed with rg that nothing inside the library subscribes to painted (only the raise sites in SciChartSurface.js:1371 and SciChart3DSurface.js:651), so the path is opt-in, hence low. Corrected other_locations paths to the package-root form (esm/utils/performance.js, esm/Charting3D/Visuals/SciChart3DSurface.js) and line numbers. Restated the memory effect as GC churn rather than a growing leak. LIFE-15 (close ports you drop) fits.
- Duplicate merged from slice `s09-filters-numerics-utils`: runAfterFramePaint creates a new, never-closed MessageChannel on every call (per frame per surface while a painted handler exists)
