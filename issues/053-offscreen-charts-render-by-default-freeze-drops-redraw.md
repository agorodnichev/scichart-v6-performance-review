# 053 · Off-screen charts render and copy on every invalidation by default; the opt-in freeze never redraws on return, and returning to the tab force-renders even frozen charts

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/SciChartSurfaceBase.js:614` |
| Severity | **medium** |
| Pipeline stage | GPU draw (`gpu-draw`) |
| Metric | frame time (also GPU time) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | CNV-20 (also SC-18, CNV-02) (web-performance skill) |
| Effort to fix | small |

## Code

```js
        this.freezeWhenOutOfView = (_b = options === null || options === void 0 ? void 0 : options.freezeWhenOutOfView) !== null && _b !== void 0 ? _b : false;
```

## Call path and frequency

A data update or modifier calls SciChartSurface.js:570 invalidateElement -> :599 TSRRequestCanvasDraw. The next engine frame runs native Draw -> render (SciChartSurface.js:640) -> CopyToDestination -> copyCanvasUtils.js:18 drawImage into the chart's 2D canvas, whether or not the host is in the viewport. With the freeze enabled, ObserveVisibility.js:22 creates one IntersectionObserver per surface. SciChartSurfaceBase.js:446-450 locks or unlocks the suspender. Invalidations raised while locked return early at SciChartSurface.js:574, and the unlock at :448 does not invalidate. On returning to the tab, SciChartSurfaceBase.js:326-328 calls invalidateElement({ force: true }) on every surface, and force bypasses the freeze lock. Frequency: per invalidation per surface, per frame while streaming.

## Why it costs

Nothing stops off-screen work unless the app opts in. Charts that nobody sees keep spending main-thread script, WebGL draw and 2D copy time every frame. The opt-in path also drops the invalidation that arrived while frozen, so a chart whose data changed off-screen shows stale content when it scrolls back, until another invalidation happens. The tab-visible handler undoes the freeze for one frame by force-rendering every surface.

**Scale where it matters:** Dashboards, tabbed panels and scrolling lists where charts outside the viewport receive live data. Each off-screen invalidated surface costs a full JS render, a WebGL pass into the master canvas and a drawImage copy per frame. On tab return, all N surfaces render in the first frame, including frozen off-screen ones.

## Fix (library side)

```diff
--- esm/Charting/Visuals/SciChartSurfaceBase.js:614
-        this.freezeWhenOutOfView = (_b = options === null || options === void 0 ? void 0 : options.freezeWhenOutOfView) !== null && _b !== void 0 ? _b : false;
+        this.freezeWhenOutOfView = (_b = options === null || options === void 0 ? void 0 : options.freezeWhenOutOfView) !== null && _b !== void 0 ? _b : SciChartDefaults.freezeWhenOutOfView; // new default: true
--- esm/Charting/Visuals/SciChartSurfaceBase.js:446
                 else if (isVisible && this.cleanupLockToken) {
                     this.cleanupLockToken();
                     this.cleanupLockToken = undefined;
+                    this.invalidateElement(); // draw once on return: invalidations while frozen were dropped
                 }
--- esm/Charting/Visuals/SciChartSurfaceBase.js:327
-                if (document.visibilityState === "visible") {
+                if (document.visibilityState === "visible" && !this.cleanupLockToken) { // frozen charts redraw when they scroll back
                     this.invalidateElement({ force: true });
```

**Trade-off:** Changing the default changes behaviour. Apps that export or screenshot off-screen charts, or that depend on rendered/renderedToDestination events from off-screen charts, must opt out. IntersectionObserver sees only geometry, so charts covered by other elements still render. Sharing one IntersectionObserver across surfaces would also remove the per-surface observer.

## App-side workaround

Pass freezeWhenOutOfView: true to create() for every chart that can leave the viewport. Call surface.invalidateElement() from the app's own IntersectionObserver when a chart re-enters, so data that changed while it was frozen gets drawn.

## Verify

measure.md#fps, `stream` on a dashboard scrolled so that half the charts are off-screen, with a per-surface render counter (the rendered event) in window.__perf.counters(). Pass: the counters of off-screen surfaces stay flat, frame p95 is a win against the current default, and after scrolling back take_screenshot shows the current data.

## Other locations

- `esm/Charting/Visuals/SciChartSurfaceBase.js:448` — unlock without invalidate: stale chart after scroll-back
- `esm/Charting/Visuals/SciChartSurfaceBase.js:328` — force invalidate on tab return bypasses the freeze lock for every surface
- `esm/Core/ObserveVisibility.js:22` — one IntersectionObserver per surface

## Review notes

- Found by reviewer slice `x1-frame-path`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

