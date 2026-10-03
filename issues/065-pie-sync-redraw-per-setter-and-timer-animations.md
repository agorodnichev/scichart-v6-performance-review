# 065 · Pie surface redraws its whole DOM synchronously on every property set, and drives 30-step and 10-step animations with setTimeout(20) chains that delete() never cancels

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/SciChartPieSurface/SciChartPieSurface.js:214` |
| Severity | **medium** |
| Pipeline stage | Tasks and scheduling (`tasks`) |
| Metric | INP, frame time (also memory on teardown) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/cb154fd7856f52ead5b4727480362f28/): reproduced on WebGL and WebGPU ([source](../demos/065-pie-sync-redraw-timer-animations/)) |
| Rule | DATA-06, TASK-09, LIFE-01 (web-performance skill) |
| Effort to fix | medium |

## Demo findings

The suggested workaround (pieSegments.clear() then add()) leaves the legend showing the old segments, because clear() replaces the array the legend holds; call legend.setPieSegmentArray(pie.pieSegments.asArray()) between the two. delete() also leaves the pie's DOM containers in the page. See the [demo](https://jsfiddle.net/gh/gist/library/pure/cb154fd7856f52ead5b4727480362f28/).

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

Each draw is immediate-mode: it discards and re-parses the whole SVG, recreates label divs, rebuilds the legend from an HTML string, and re-queries and re-attaches listeners. Calling it synchronously from every setter repeats all of that for each property, inside the caller's task. PieSegment.value has no equality check (PieSegment.js:146-150), so a feed that re-sets unchanged values still redraws and, with animate on, restarts the 30-step sweep. The animations use 20 ms timers that are not aligned to frames: on 60 Hz some frames get no step and on 120 Hz each step spans 2 to 3 frames, LoAF reports the steps as timer input delay, and hidden tabs keep firing them at about 1 Hz. delete() stores no timer handles and isValidToDraw() always returns true, so a pie deleted mid-animation (React StrictMode mount/unmount, route change) keeps drawing into its detached containers until the chain ends.

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
+            if (IS_TEST_ENV) {
+                this.update();
+                return;
+            }
+            // one redraw per frame however many properties changed in this task
+            if (this.redrawRaf === undefined) {
+                this.redrawRaf = requestAnimationFrame(() => {
+                    this.redrawRaf = undefined;
+                    if (!this.isDeleted) this.update();
+                });
+            }
         }
@@ delete() {
+        cancelAnimationFrame(this.redrawRaf);
+        cancelAnimationFrame(this.sweepRaf);
+        this.redrawRaf = this.sweepRaf = undefined;
         this.deleteInternals();
@@ draw()
-            (function myLoop(k) {
-                setTimeout(() => {
-                    const animationProgress = k / frames;
-                    callDelete(true);
-                    callDrawChart(animationProgress);
-                    if (k === frames) {
-                        setSuspendUpdateFalse();
-                        setSweepAnimationDone();
-                        callInvalidateElement();
-                    }
-                    if (++k <= frames)
-                        myLoop(k);
-                }, 20);
-            })(1);
+            const start = performance.now();
+            const duration = frames * 20; // same 600 ms default as 30 steps x 20 ms
+            const step = (now) => {
+                if (this.isDeleted) return;
+                // clamp: a rAF timestamp can be slightly older than performance.now() taken in the scheduling task
+                const animationProgress = Math.min(1, Math.max(0, (now - start) / duration));
+                callDelete(true);
+                callDrawChart(animationProgress);
+                if (animationProgress < 1) {
+                    this.sweepRaf = requestAnimationFrame(step);
+                    return;
+                }
+                this.sweepRaf = undefined;
+                setSuspendUpdateFalse();
+                setSweepAnimationDone();
+                callInvalidateElement();
+            };
+            this.sweepRaf = requestAnimationFrame(step);
--- a/esm/Charting/Visuals/SciChartPieSurface/helpers/addEventListenerToPieSegment.js
+++ b/esm/Charting/Visuals/SciChartPieSurface/helpers/addEventListenerToPieSegment.js
@@ if (!isListenerBlocked) {
-            const ROUNDS = 10;
             const directionDown = ps.isSelected;
             const start = directionDown ? ps.delta : 0;
-            const d = directionDown ? -ps.delta / ROUNDS : ps.delta / ROUNDS;
+            const delta = directionDown ? -ps.delta : ps.delta;
+            const DURATION = 200; // same as 10 steps x 20 ms
             isListenerBlocked = true;
             ps.isSelected = !ps.isSelected;
-            (function myLoop(k) {
-                setTimeout(() => {
-                    ps.shift = start + d * k;
-                    if (k === ROUNDS) {
-                        isListenerBlocked = false;
-                    }
-                    if (++k <= ROUNDS)
-                        myLoop(k);
-                }, 20);
-            })(1);
+            const t0 = performance.now();
+            // Always run to the end: isListenerBlocked is module-wide (shared by every pie), so an early exit
+            // would block clicks on all pies. After delete() the shift setters are cheap: invalidateElement
+            // returns on isDeleted.
+            const step = (now) => {
+                const p = Math.min(1, Math.max(0, (now - t0) / DURATION));
+                ps.shift = start + delta * p; // the surface coalesces this into one redraw per frame
+                if (p < 1) requestAnimationFrame(step);
+                else isListenerBlocked = false;
+            };
+            requestAnimationFrame(step);
```

**Trade-off:** Redraws become asynchronous: the DOM reflects a property change one frame later. Code that reads pie DOM right after a setter would see the old state, so the synchronous path is kept under IS_TEST_ENV. rAF does not run in hidden tabs, so an animation started while hidden completes on return instead of stepping at 1 Hz. Animation progress becomes time-based, so on slow devices steps are skipped rather than the animation running long.

## App-side workaround

Use animate:false to remove the timer-driven chains, and do not re-set segment values that did not change (the setter has no equality check). To change many values with one visible draw, rebuild the segments and swap them with pieSegments.clear() followed by a single pieSegments.add(...segments) call (one collectionChanged event), instead of setting each value.

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
- Adversarial verification (corrected): Re-read SciChartPieSurface.js:208-216 (quote matches; primary :214 is the synchronous update()), update :220-226 (only suspendUpdate gates it), draw :551-594, drawChart :599-667, deleteInternals :241-256, delete :230-237, isValidToDraw :491-494 (stub returning true). Chain confirmed: PieSegment value setter PieSegment.js:146-150 (no equality check: re-setting the same value also redraws and, with animate, restarts the sweep) / shift :182-186 -> notifyPropertyChanged :256-263 -> invalidateParentCallback = scps.invalidateElement (:44) -> update -> draw synchronously. animate:false or after the first sweep: deleteInternals + drawChart (SVG string parsed by annotationHelpers.createSvg at :665, label divs recreated :709-721), querySelector + addEventListenerToPieSegment per segment :584-591, legend.update SciChartPieLegend.js:58-63 -> SciChartLegendBase clear :241-249 + create :300-311 (htmlToElement). animate:true value change: 30 setTimeout(20) steps :568-581 then callInvalidateElement for a full draw; while suspendUpdate is true further setters are absorbed, so N value sets in one task batch only under animation, and draw N times with animate:false. Click: helpers/addEventListenerToPieSegment.js:11-28, isSelected draws once then 10 timer steps each set shift -> full draw. delete() keeps no timer handles and draw/invalidateElement never check isDeleted, so a chain started before delete() keeps rebuilding the containers until it ends (bounded, not a growing leak). Severity medium (per discrete interaction / per update) and evidence S kept; rules kept. Fix corrected: the sweep step now clamps progress at 0 (a rAF timestamp can precede the performance.now() taken when the step was scheduled, which would give a negative progress to easing.inOutCubic); the rAF fields are renamed redrawRaf/sweepRaf so they are not confused with the existing animationFrames count (:78); the click helper is spelled out and always runs to completion because isListenerBlocked is a module-level flag shared by every pie (addEventListenerToPieSegment.js:2) and an early exit would block clicks on all pies. Added the missing equality check on PieSegment.value to why_it_costs and app_workaround.

