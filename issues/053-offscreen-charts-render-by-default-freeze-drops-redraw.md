# 053 · Off-screen charts render and copy on every invalidation by default; the opt-in freeze never redraws on return, and returning to the tab force-renders even frozen charts

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/SciChartSurfaceBase.js:614` |
| Severity | **medium** |
| Pipeline stage | GPU draw (`gpu-draw`) |
| Metric | frame time (also GPU time) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Rule | CNV-20 (also SC-18, CNV-02) (web-performance skill) |
| Effort to fix | small |

## Code

```js
        this.freezeWhenOutOfView = (_b = options === null || options === void 0 ? void 0 : options.freezeWhenOutOfView) !== null && _b !== void 0 ? _b : false;
```

## Call path and frequency

A data update or modifier calls SciChartSurface.js:570 invalidateElement -> :599 renderSurface.invalidateElement -> RenderSurface.js:24 TSRRequestCanvasDraw. The next engine frame runs SciChartSurface.js:1331 onRenderSurfaceDraw -> :640 sciChartRenderer.render -> copyCanvasUtils.js:18 drawImage into the chart's 2D canvas, whether or not the host is in the viewport (nothing on this path checks visibility). With the freeze enabled, ObserveVisibility.js:22 creates one IntersectionObserver per surface, and SciChartSurfaceBase.js:442-450 takes or releases a suspender lock. Invalidations raised while locked return early at SciChartSurface.js:574-576; the unlock at SciChartSurfaceBase.js:448-449 does not invalidate (UpdateSuspender.js lock tokens raise nothing, unlike resumeUpdates at SciChartSurfaceBase.js:397-402). On returning to the tab, SciChartSurfaceBase.js:326-328 calls invalidateElement({ force: true }) on every surface, and force bypasses the freeze lock. Frequency: once per frame per invalidated surface while streaming.

## Why it costs

Nothing stops off-screen work unless the app opts in. Charts that nobody sees keep spending main-thread script, WebGL draw and 2D copy time every frame. The opt-in path also drops the invalidation that arrived while frozen, so a chart whose data changed off-screen shows stale content when it scrolls back, until another invalidation happens. The tab-visible handler undoes the freeze for one frame by force-rendering every surface.

**Scale where it matters:** Dashboards, tabbed panels and scrolling lists where charts outside the viewport receive live data. Each off-screen invalidated surface costs a full JS render, a WebGL pass into the master canvas and a drawImage copy per frame. On tab return, all N surfaces render in the first frame, including frozen off-screen ones.

## Fix (library side)

```diff
--- esm/Charting/Visuals/SciChartDefaults.js (new static next to createSuspended; the field does not exist today)
+/**
+ * Default of freezeWhenOutOfView for new top-level surfaces.
+ */
+SciChartDefaults.freezeWhenOutOfView = true;
--- esm/Charting/Visuals/SciChartSurfaceBase.js:614 (SciChartDefaults is already imported at :21)
-        this.freezeWhenOutOfView = (_b = options === null || options === void 0 ? void 0 : options.freezeWhenOutOfView) !== null && _b !== void 0 ? _b : false;
+        this.freezeWhenOutOfView = (_b = options === null || options === void 0 ? void 0 : options.freezeWhenOutOfView) !== null && _b !== void 0 ? _b
+            // sub-charts share the parent's domChartRoot (sciChartSubSurfaceCommon.js:43) and freeze with it; jsdom has no IntersectionObserver
+            : SciChartDefaults.freezeWhenOutOfView && !this.isSubSurface && typeof IntersectionObserver !== "undefined";
--- esm/Charting/Visuals/SciChartSurfaceBase.js:447
                 else if (isVisible && this.cleanupLockToken) {
                     this.cleanupLockToken();
                     this.cleanupLockToken = undefined;
+                    // invalidations raised while frozen returned early (SciChartSurface.js:574-576): draw once on return
+                    this.invalidateElement();
                 }
@@ :454
         else if (!freezeWhenOutOfView && this.visibilityObserver) {
             (_a = this.visibilityObserver) === null || _a === void 0 ? void 0 : _a.disconnect();
             this.visibilityObserver = undefined;
-            (_b = this.cleanupLockToken) === null || _b === void 0 ? void 0 : _b.call(this);
+            if (this.cleanupLockToken) {
+                this.cleanupLockToken();
+                this.cleanupLockToken = undefined; // a stale token makes :443 skip the next freeze
+                this.invalidateElement();
+            }
         }
--- esm/Charting/Visuals/SciChartSurfaceBase.js:327
-                if (document.visibilityState === "visible") {
+                if (document.visibilityState === "visible" && !this.cleanupLockToken) { // frozen charts redraw when they scroll back (:447)
                     this.invalidateElement({ force: true });
```

**Trade-off:** Changing the default changes behaviour. Apps that export or screenshot off-screen charts, or that depend on rendered/renderedToDestination events from off-screen charts, must opt out (SciChartDefaults.freezeWhenOutOfView = false or the per-chart option). IntersectionObserver sees only geometry, so charts covered by other elements still render. Invalidating on every re-entry costs one render per scroll-in even when nothing changed; a flag set in invalidateElement when it returns early for the freeze lock would avoid that but touches SciChartSurface.js and SciChart3DSurface.js. Skipping the tab-return force render for frozen charts is safe for the cleared-canvas case it exists for (SciChartSurfaceBase.js:823-827), because those charts are off-screen and redraw on re-entry. Sharing one IntersectionObserver across surfaces would also remove the per-surface observer.

## App-side workaround

Pass freezeWhenOutOfView: true to create() for every chart that can leave the viewport (top-level surfaces only). Call surface.invalidateElement() from the app's own IntersectionObserver when a chart re-enters, so data that changed while it was frozen gets drawn. When the freeze is turned off at runtime, call invalidateElement() afterwards; after turning it back on, the first scroll-out may not freeze because of the stale lock token left at SciChartSurfaceBase.js:457. SciChartSurfaceBase.invalidateOnTabVisible = false removes the tab-return render of all charts, but then visible charts whose canvas was cleared in the background tab need an app-side invalidateElement() on visibilitychange.

## Verify

measure.md#fps, `stream` on a dashboard scrolled so that half the charts are off-screen, with a per-surface render counter (the rendered event) in window.__perf.counters(). Pass: the counters of off-screen surfaces stay flat, frame p95 is a win against the current default; then stop the stream while those charts are off-screen, scroll back, and take_screenshot shows the last data (today it shows the data from before the freeze).

## Other locations

- `esm/Charting/Visuals/SciChartSurfaceBase.js:448` — unlock without invalidate: stale chart after scroll-back
- `esm/Charting/Visuals/SciChartSurfaceBase.js:457` — disabling the freeze calls the token but leaves cleanupLockToken set: after a re-enable the check at :443 skips the lock until a visible callback clears the stale token (with a console warning), and the chart misses its redraw on disable
- `esm/Charting/Visuals/SciChartSurfaceBase.js:328` — force invalidate on tab return bypasses the freeze lock for every surface
- `esm/Charting/Visuals/UpdateSuspender.js:38` — lock tokens release without raising onResumed or invalidating, unlike resume()
- `esm/Core/ObserveVisibility.js:22` — one IntersectionObserver per surface

## Review notes

- Found by reviewer slice `x1-frame-path`.
- Adversarial verification (corrected): Re-read esm/Charting/Visuals/SciChartSurfaceBase.js:614 (code_quote matches verbatim), :325-334 (visibilitychange handler, guarded by !IS_TEST_ENV && SciChartSurfaceBase.invalidateOnTabVisible, static true at :827 with the remark that it exists because canvas data can be cleared on an inactive tab), :438-462 (freezeWhenOutOfView setter), :504-505 (observer disconnected on delete, so no leak), Core/ObserveVisibility.js:22 (one IntersectionObserver per surface, threshold 0.01), Charting/Visuals/UpdateSuspender.js:14-48 (isSuspended is true while any lock token is held; the lock token only deletes itself from the set and raises nothing, unlike resume(), and onResumed has no subscriber in esm), SciChartSurfaceBase.js:397-402 (resumeUpdates does invalidate, the freeze unlock does not). Caller chain: data or modifier change -> SciChartSurface.js:570 invalidateElement -> :574-576 early return only when !force && (isSuspended || deleted || !initialized || context lost) -> :599 renderSurface.invalidateElement -> RenderSurface.js:24 TSRRequestCanvasDraw -> next engine frame SciChartSurface.js:1331 onRenderSurfaceDraw -> :640 sciChartRenderer.render -> copyCanvasUtils.js:18 drawImage. Nothing on that path checks visibility, so with the default false an off-screen surface renders and copies once per frame while it is invalidated. With the freeze on, invalidations while locked return at :574-576, and the unlock at SciChartSurfaceBase.js:448-449 does not invalidate, so a chart whose data changed only while frozen shows stale content on scroll-back until another invalidation or a tab switch (the force render at :328 bypasses the lock). Note: the playbook rule SC-18 says the library 'draws once when it returns'; this build does not. Corrections: (1) fix_diff referenced SciChartDefaults.freezeWhenOutOfView, which does not exist (SciChartDefaults.js has no such field): the diff now adds it; (2) the new default would also apply to sub-surfaces (SciChartSubSurface.js:86 calls applyOptions, and their domChartRoot is the parent's, sciChartSubSurfaceCommon.js:43) and would throw where IntersectionObserver is missing (jsdom; the visibilitychange path is already guarded by IS_TEST_ENV): the default is now gated by !this.isSubSurface (set at SciChartSubSurface.js:60 before applyOptions) and typeof IntersectionObserver; (3) added the disable path at :454-457, which calls the token but never clears cleanupLockToken, so after a re-enable the stale token makes :443 skip the lock until the first visible callback calls it again (console warning from UpdateSuspender.js:41) and clears it, and the chart also misses its redraw on disable; (4) call_path line refs fixed (setter callback is :442-450, early return :574-576, :599 is renderSurface.invalidateElement which reaches RenderSurface.js:24); (5) other_locations, trade_off, verify and app_workaround updated. Severity stays medium: per frame only while off-screen charts are invalidated, the main fix is a default change with an opt-in already available, and the tab-return render is once per tab switch. Evidence stays S: no visibility gate on the render path and no invalidate on unlock are certain in the code.

