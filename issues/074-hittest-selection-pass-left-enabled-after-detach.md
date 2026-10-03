# 074 · Tooltip/selection modifiers turn on the per-frame selection pass on attach and never turn it off on detach

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting3D/ChartModifiers/TooltipModifier3D.js:210` |
| Severity | **medium** |
| Pipeline stage | GPU draw (`gpu-draw`) |
| Metric | frame time (GPU draw) for the life of the surface |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | LIFE-01, GPU-28 (web-performance skill) |
| Effort to fix | small |

## Code

```js
    onAttach() {
        super.onAttach();
        if (this.parentSurface) {
            // Globally enable hit-test and selection pass (comes with a minor performance hit)
            this.parentSurface.isHitTestEnabled = true;
```

## Call path and frequency

Once on attach: TooltipModifier3D.js:210 / SeriesSelectionModifier3D.js:72 set isHitTestEnabled = true. Then per rendered frame for the rest of the surface's life: SciChart3DRenderer.js:90 SCRTSetIsSelectionBufferEnabled(true) -> engine renders the selection pass, also after both modifiers were removed (apps that toggle tooltip/selection tools).

## Why it costs

The selection pass re-draws the scene into an ID buffer each frame; the library documents it as a drawing overhead to disable when not required. After detach nobody reads that buffer, but it is still drawn every frame. Cost per frame is engine-side and hardware-dependent (hypothesis).

**Scale where it matters:** Apps that add/remove TooltipModifier3D or SeriesSelectionModifier3D (tool toggles); cost grows with geometry per frame (every series drawn a second time into the ID buffer).

## Fix (library side)

```diff
--- a/esm/Charting3D/ChartModifiers/TooltipModifier3D.js
+++ b/esm/Charting3D/ChartModifiers/TooltipModifier3D.js
@@ onAttach() {
         if (this.parentSurface) {
+            this.requiresHitTest = true;
+            this.hitTestWasEnabled = this.parentSurface.isHitTestEnabled;
             this.parentSurface.isHitTestEnabled = true;
@@ onDetach() {
         super.onDetach();
         if (this.parentSurface) {
+            const stillNeeded = this.parentSurface.chartModifiers.asArray()
+                .some(m => m !== this && m.isAttached && m.requiresHitTest);
+            if (!stillNeeded && !this.hitTestWasEnabled) {
+                this.parentSurface.isHitTestEnabled = false;
+            }
             this.parentSurface.rootEntity.children.remove(this.crosshairEntity);
(same two hunks in SeriesSelectionModifier3D.onAttach/onDetach)
```

**Trade-off:** An app that calls series.hitTest() itself after removing the modifiers must keep isHitTestEnabled = true explicitly (the captured prior value covers the case where it was set before attach).

## App-side workaround

After removing the 3D tooltip/selection modifiers, set sciChart3DSurface.isHitTestEnabled = false.

## Verify

measure.md#gpu then #fps: surface with 500k-point scatter; run A never attaches TooltipModifier3D, run B attaches then detaches it; 5 s orbit drag each. Pass: B matches A on frameP95Ms and trace-summary GPUTask time (baseline B is higher).

## Other locations

- `esm/Charting3D/ChartModifiers/SeriesSelectionModifier3D.js:72` — same enable in onAttach; onDetach (:78-85) does not restore
- `esm/Charting3D/Visuals/SciChart3DRenderer.js:90` — SCRTSetIsSelectionBufferEnabled(isHitTestEnabled) on every render

## Review notes

- Found by reviewer slice `s13-3d-series-modifiers`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

