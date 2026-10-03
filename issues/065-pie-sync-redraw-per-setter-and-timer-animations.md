# 065 · Pie surface redraws its whole DOM synchronously on every property set, and drives 30-step and 10-step animations with setTimeout(20) chains that delete() never cancels

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/SciChartPieSurface/SciChartPieSurface.js:214` |
| Severity | **medium** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | INP, frame time (also memory on teardown) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | DATA-06, TASK-09, LIFE-01 (web-performance skill) |
| Effort to fix | medium |

## Code

```js
    invalidateElement(options) {
        // TODO make params type consistent with 2D and 3D
        if (this.isValidToDraw()) {
            if (typeof options === "string" && options === PROPERTY_SEGMENT.VALUE) {
                this.sweepAnimationDone = false;
            }
            this.update();
        }
    }
```

## Call path and frequency

segment.value = v (PieSegment.js:146-150) -> notifyPropertyChanged (:256-262) -> SciChartPieSurface.invalidateElement (SciChartPieSurface.js:208-215) -> update (:220-225) -> draw (:551). With animate:false: deleteInternals() (:241-256 removes the SVG, every label div and every listener) -> drawChart (:599-667: SVG string built and parsed by createContextualFragment :663-666, label divs recreated :709-721) -> querySelector + addEventListener per segment (:584-591) -> legend.update() (esm/Charting/Visuals/Legend/SciChartPieLegend.js:58-63 -> SciChartLegendBase.js:241-249/:300-311 clear + htmlToElement). With animate:true (the default): 30 setTimeout(20 ms) steps (:568-581), each deleteInternals(true) + drawChart, then one more full draw. Segment click: helpers/addEventListenerToPieSegment.js:18-27 runs 10 setTimeout(20 ms) steps, each ps.shift = x (PieSegment.js:182-186) -> a full synchronous draw including the legend rebuild. Frequency: per property set, plus 10 to 31 full rebuilds per click or value change.

## Why it costs

Each draw is immediate-mode: it discards and re-parses the whole SVG, recreates label divs, rebuilds the legend from an HTML string, and re-queries and re-attaches listeners. Calling it synchronously from every setter repeats all of that for each property, inside the caller's task. The animations use 20 ms timers that are not aligned to frames: on 60 Hz some frames get no step and on 120 Hz each step spans 2 to 3 frames, LoAF reports the steps as timer input delay, and hidden tabs keep firing them at about 1 Hz. delete() stores no timer handles and isValidToDraw() always returns true, so a pie deleted mid-animation (React StrictMode mount/unmount, route change) keeps drawing into its detached containers until the chain ends.

**Scale where it matters:** 5 to 30 segments. A live pie updated at 1 Hz runs 31 full rebuilds per update. With animate:false, setting N segment values in one task runs N full rebuilds, and only the last one is shown. A click runs 10 rebuilds.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/SciChartPieSurface/SciChartPieSurface.js
+++ b/esm/Charting/Visuals/SciChartPieSurface/SciChartPieSurface.js
@@ invalidateElement(options) {
-        if (this.isValidToDraw()) {
+        if (this.isValidToDraw() && !this.isDeleted) {
             if (typeof options === "string" && options === PROPERTY_SEGMENT.VALUE) {
                 this.sweepAnimationDone = false;
             }
-            this.update();
+            if (IS_TEST_ENV) { this.update(); return; }
+            // one redraw per frame however many properties changed in this task
+            if (this.redrawFrame === undefined) {
+                this.redrawFrame = requestAnimationFrame(() => { this.redrawFrame = undefined; if (!this.isDeleted) this.update(); });
+            }
         }
@@ delete() {
+        cancelAnimationFrame(this.redrawFrame);
+        cancelAnimationFrame(this.animationFrame);
         this.deleteInternals();
@@ draw()
-            (function myLoop(k) {
-                setTimeout(() => { ... }, 20);
-            })(1);
+            const start = performance.now(), duration = frames * 20; // same 600 ms default
+            const step = (now) => {
+                if (this.isDeleted) return;
+                const p = Math.min(1, (now - start) / duration);
+                callDelete(true);
+                callDrawChart(p);
+                if (p < 1) { this.animationFrame = requestAnimationFrame(step); return; }
+                setSuspendUpdateFalse(); setSweepAnimationDone(); callInvalidateElement();
+            };
+            this.animationFrame = requestAnimationFrame(step);
--- a/esm/Charting/Visuals/SciChartPieSurface/helpers/addEventListenerToPieSegment.js
 (same: one rAF loop with time-based progress for ps.shift instead of 10 setTimeout(20) steps)
```

**Trade-off:** Redraws become asynchronous: the DOM reflects a property change one frame later. Code that reads pie DOM right after a setter would see the old state, so the synchronous path is kept under IS_TEST_ENV. rAF does not run in hidden tabs, so an animation started while hidden completes on return instead of stepping at 1 Hz. Animation progress becomes time-based, so on slow devices steps are skipped rather than the animation running long.

## App-side workaround

Use animate:false to remove the timer-driven chains. To change many values with one visible draw, rebuild the segments and swap them with pieSegments.clear() followed by a single pieSegments.add(...segments) call (one collectionChanged event), instead of setting each value.

## Verify

measure.md#inp, clicking a segment (animate default), 5 runs per side. Pass: __wpProbe.loaf.read() lists no 'user-callback' timer scripts from the pie, and the processing subpart is 'win'. measure.md#fps during a value-change animation. Pass: about one Layout per frame in trace-summary. With animate:false, setting 10 values in one task: an app counter on draw() reads 1. measure.md#mem: create then delete within 300 ms, 10 times. Pass: no draw after delete (counter) and DOM nodes return to baseline.

## Other locations

- `esm/Charting/Visuals/SciChartPieSurface/SciChartPieSurface.js:568` — 30-step setTimeout(20) sweep loop, with no handle kept
- `esm/Charting/Visuals/SciChartPieSurface/SciChartPieSurface.js:665` — whole SVG re-parsed from a string on every draw and every animation step
- `esm/Charting/Visuals/SciChartPieSurface/SciChartPieSurface.js:586` — querySelector + addEventListener per segment per draw
- `esm/Charting/Visuals/SciChartPieSurface/SciChartPieSurface.js:230` — delete() does not cancel pending animation timers. isValidToDraw (:491-494) always returns true
- `esm/Charting/Visuals/SciChartPieSurface/helpers/addEventListenerToPieSegment.js:19` — 10-step setTimeout(20) click animation. Each step triggers a full synchronous redraw
- `esm/Charting/Visuals/Legend/SciChartPieLegend.js:58` — the legend DOM is cleared and rebuilt from HTML on every pie draw (no isDirty check, unlike SciChartLegendBase.update)

## Review notes

- Found by reviewer slice `s12-pie-3d-surface`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

