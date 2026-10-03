# 001 · resizeAnnotationRootElements stores the wrong rect for its change check, so at DPR != 1 every render rewrites the SVG clipPath defs of three SVG roots for each surface and sub-surface

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Services/SciChartRenderer.js:577` |
| Severity | **high** |
| Pipeline stage | Style (`style`) |
| Metric | frame time |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/536ef52eb4c16bbd677557084dfa7a30/): reproduced on WebGL and WebGPU ([source](../demos/001-svg-clip-path-defs-rewritten-hidpi/)) |
| Rule | none (web-performance skill) |
| Effort to fix | small |

## Code

```js
        if (!this.prevRect || !this.prevSurfaceRect) {
            this.prevRect = seriesViewRectInDevicePixels;
            this.prevSurfaceRect = surfaceViewRectInDevicePixels;
        }
        else if (Rect.isEqual(this.prevRect, seriesViewRectInDevicePixels) &&
            Rect.isEqual(this.prevSurfaceRect, surfaceViewRectInDevicePixels)) {
            return;
        }
        this.prevRect = seriesViewRectInDevicePixels;
        this.prevSurfaceRect = surfaceViewRect;
```

## Call path and frequency

Engine frame -> SciChartSurface.onRenderSurfaceDraw (esm/Charting/Visuals/SciChartSurface.js:1331; each sub-chart via :1352, otherwise :1356) -> doDrawingLoop (:640) -> SciChartRenderer.render (esm/Charting/Services/SciChartRenderer.js:155) -> resizeAnnotationRootElements (:569-599) -> SciChartSurfaceBase.setSvgClipPathDefinitions (esm/Charting/Visuals/SciChartSurfaceBase.js:744-781) x3. Runs on every rendered frame of every surface and sub-surface when DpiHelper.PIXEL_RATIO != 1.

## Why it costs

translateToNotScaledRect divides by PIXEL_RATIO, and the stored prevSurfaceRect is the raw scaled viewRect, so at DPR != 1 Rect.isEqual(prevSurfaceRect, surfaceViewRectInDevicePixels) is false on every frame and the early return never fires. At DPR 1 the check works for the main surface (clipRect === viewRect, SciChartSurfaceBase.js:376-378), which shows that skipping unchanged layouts is the intended behaviour. The per-frame JS DOM work is certain: 4 selector queries and 8 attribute writes per SVG root, with [id='...'] attribute selectors that do not take the getElementById fast path. Per the DOM spec, setAttribute queues a mutation record even for an unchanged value. Whether Blink also invalidates style and the clip resource (re-clipping SVG annotations) on same-value x/y/width/height writes is engine-dependent: hypothesis.

**Scale where it matters:** Every chart shown at devicePixelRatio 1.25, 1.5, 2 or 3 (most laptops and all phones). Per surface per frame: 12 querySelector calls and 24 setAttribute calls. With N sub-charts on one parent, each frame does 3N setSvgClipPathDefinitions calls whose [id] lookups each scan about 6N clipPath/rect nodes in the shared <defs>: O(N^2) matching per frame.

## Fix (library side)

```diff
--- a/esm/Charting/Services/SciChartRenderer.js
+++ b/esm/Charting/Services/SciChartRenderer.js
@@ resizeAnnotationRootElements(seriesViewRect)
         this.prevRect = seriesViewRectInDevicePixels;
-        this.prevSurfaceRect = surfaceViewRect;
+        this.prevSurfaceRect = surfaceViewRectInDevicePixels;
         const svgRootElement = this.sciChartSurface.domSvgContainer;
```

**Trade-off:** None for correctness: the stored value becomes the one the comparison expects, so at any DPR the defs are rewritten only when the series or surface rect changes (resize, layout change, sub-chart move), exactly as at DPR 1 today. Optional follow-up: in setSvgClipPathDefinitions keep references to the <defs> and the two clip <rect> elements per root (or use getElementById), so frames where the layout did change avoid the O(N) [id] scans.

## App-side workaround

SciChartRenderer is exported from the package index (esm/index.js:305), so an app can wrap SciChartRenderer.prototype.resizeAnnotationRootElements: call the original, then set this.prevSurfaceRect = Rect.intersect(translateToNotScaledRect(this.sciChartSurface.viewRect), translateToNotScaledRect(this.sciChartSurface.clipRect)) (Rect and translateToNotScaledRect are also exported). Setting DpiHelper.IsDpiScaleEnabled = false hides it but renders blurry.

## Verify

measure.md#fps, `stream` scenario on a parent surface with 20 sub-charts plus one SVG annotation, emulated at 1440x900 DPR 2, 5 runs per side. Also attach a MutationObserver({attributes:true, subtree:true}) to the parent's three SVG roots and count mutations on clipPath rects. Pass: 0 clipPath attribute mutations in frames where layout did not change; trace-summary shows fewer 'Recalculate style' events in the window; compare-runs gives 'win' or neutral on frameP95Ms. Not measured.

## Other locations

- `esm/Charting/Services/SciChartRenderer.js:586` — the wrong assignment: this.prevSurfaceRect = surfaceViewRect
- `esm/Charting/Services/SciChartRenderer.js:589` — setSvgClipPathDefinitions for domSvgContainer, domBackgroundSvgContainer (:593) and domSvgAdornerLayer (:597); all three are created in sciChartInitCommon.js:212-215
- `esm/Charting/Visuals/SciChartSurfaceBase.js:745` — per root: querySelector('defs') (:745), an attribute-selector existence check (:753), two attribute-selector lookups (:770-771), then 8 setAttribute calls (:773-780)
- `esm/Charting/Visuals/sciChartSubSurfaceCommon.js:46` — sub-charts reuse the parent's SVG roots, so each sub-chart adds 2 clipPaths to the same <defs>, and each [id='...'] lookup scans a subtree that grows with the sub-chart count
- `esm/Charting/Services/SciChartRenderer.js:586` — same root cause, also reported by slice x1-frame-path: At devicePixelRatio != 1 the 'layout unchanged' guard never matches, so every rendered frame rewrites the clip paths of 3 SVG layers per surface
- `esm/Charting/Visuals/SciChartSurfaceBase.js:744` — setSvgClipPathDefinitions: 4 querySelector + 8 setAttribute per SVG root
- `esm/Charting/Visuals/SciChartSubSurface.js:90` — sub-charts use the same guard; viewRect/clipRect are also back-buffer rects

## Review notes

- Found by reviewer slice `s01-surface-render`.
- Adversarial verification (corrected): Re-read SciChartRenderer.js:569-599; the quote matches verbatim starting at :577 (primary moved from :586 to the start of the quote; the faulty line :586 is listed separately). Confirmed render() calls resizeAnnotationRootElements unconditionally at :155 on each render, and onRenderSurfaceDraw runs doDrawingLoop for the parent and every visible sub-chart. Checked translateToNotScaledRect (utils/translate.js:93, divides by PIXEL_RATIO), Rect.isEqual (exact x/y/width/height) and Rect.intersect (Core/Rect.js:63-85): at DPR 2 the stored rect is twice the compared one, so the early return can never fire. Checked that the three SVG roots exist (sciChartInitCommon.js:212-215) and that sub-surfaces share the parent's roots (sciChartSubSurfaceCommon.js:46-49). Corrected the per-root query count from 3 to 4 (:745, :753, :770, :771), so 12 querySelector calls per surface per frame, not 9. No rule fits exactly; kept 'none' with the mechanism stated.
- Duplicate merged from slice `x1-frame-path`: At devicePixelRatio != 1 the 'layout unchanged' guard never matches, so every rendered frame rewrites the clip paths of 3 SVG layers per surface
