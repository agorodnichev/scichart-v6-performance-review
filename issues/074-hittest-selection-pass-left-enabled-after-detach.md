# 074 · Tooltip/selection modifiers turn on the per-frame selection pass on attach and never turn it off on detach

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting3D/ChartModifiers/TooltipModifier3D.js:210` |
| Severity | **medium** |
| Pipeline stage | GPU draw (`gpu-draw`) |
| Metric | frame time (GPU draw) for the life of the surface |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
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
         super.onAttach();
         if (this.parentSurface) {
             // Globally enable hit-test and selection pass (comes with a minor performance hit)
+            // Remember whether the app had it on before any hit-test modifier; inherit that from a
+            // hit-test modifier that is already attached, which may have switched it on itself
+            const other = this.parentSurface.chartModifiers.asArray()
+                .find(m => m !== this && m.isAttached && m.requiresHitTest);
+            this.hitTestWasEnabled = other ? other.hitTestWasEnabled : this.parentSurface.isHitTestEnabled;
+            this.requiresHitTest = true;
             this.parentSurface.isHitTestEnabled = true;
@@ onDetach() {
         super.onDetach();
         if (this.parentSurface) {
+            // parentSurface is still set here: SciChartSurfaceBase.detachChartModifier clears it after onDetach()
+            const stillNeeded = this.parentSurface.chartModifiers.asArray()
+                .some(m => m !== this && m.isAttached && m.requiresHitTest);
+            if (!stillNeeded && !this.hitTestWasEnabled) {
+                this.parentSurface.isHitTestEnabled = false;
+            }
             this.parentSurface.rootEntity.children.remove(this.crosshairEntity);
--- a/esm/Charting3D/ChartModifiers/SeriesSelectionModifier3D.js
+++ b/esm/Charting3D/ChartModifiers/SeriesSelectionModifier3D.js
@@ onAttach() {
         if (this.parentSurface) {
+            const other = this.parentSurface.chartModifiers.asArray()
+                .find(m => m !== this && m.isAttached && m.requiresHitTest);
+            this.hitTestWasEnabled = other ? other.hitTestWasEnabled : this.parentSurface.isHitTestEnabled;
+            this.requiresHitTest = true;
             this.parentSurface.isHitTestEnabled = true;
@@ onDetach() {
         var _a, _b;
+        if (this.parentSurface) {
+            const stillNeeded = this.parentSurface.chartModifiers.asArray()
+                .some(m => m !== this && m.isAttached && m.requiresHitTest);
+            if (!stillNeeded && !this.hitTestWasEnabled) {
+                this.parentSurface.isHitTestEnabled = false;
+            }
+        }
         (_a = this.parentSurface) === null || _a === void 0 ? void 0 : _a.renderableSeries.asArray().forEach(rs => this.onDetachSeries(rs));
```

**Trade-off:** An app that calls series.hitTest() itself after removing the modifiers, without having enabled isHitTestEnabled before attaching them, must now set isHitTestEnabled = true itself; hitTest() throws "Enable hit-test functions by setting SciChart3DSurface.isHitTestEnabled = true" otherwise (BaseRenderableSeries3D.js:259-261), so the case fails loudly. A value the app set before the first hit-test modifier attached is kept. Custom modifiers that need hit testing should set requiresHitTest = true to keep the pass on.

## App-side workaround

After removing the 3D tooltip/selection modifiers, set sciChart3DSurface.isHitTestEnabled = false.

## Verify

measure.md#gpu then #fps: surface with 500k-point scatter; run A never attaches TooltipModifier3D, run B attaches then detaches it; 5 s orbit drag each. Pass: B matches A on frameP95Ms and trace-summary GPUTask time (baseline B is higher).

## Other locations

- `esm/Charting3D/ChartModifiers/SeriesSelectionModifier3D.js:72` — same enable in onAttach; onDetach (:78-85) does not restore
- `esm/Charting3D/Visuals/SciChart3DRenderer.js:90` — SCRTSetIsSelectionBufferEnabled(isHitTestEnabled) on every render

## Review notes

- Found by reviewer slice `s13-3d-series-modifiers`.
- Adversarial verification (corrected): Quote matches TooltipModifier3D.js:206-210 (CRLF file; primary :210 is the enable). rg isHitTestEnabled over esm: default false at SciChart3DSurface.js:214, setter :502-507 (invalidates on change), the only writers are TooltipModifier3D.js:210 and SeriesSelectionModifier3D.js:72 (both true); no option, onDetach (Tooltip :231-240, Selection :78-85), delete() or base class ever sets it back. Per render SciChart3DRenderer.js:90 passes it to SCRTSetIsSelectionBufferEnabled. The setter docstring (:494-501, also in types/Charting3D/Visuals/SciChart3DSurface.d.ts) says enabling adds a drawing overhead and should be disabled if not required, and the glue exports TSRSelectionPass and TSRSelectionHelper::EncodeSelectionIDAsVertexColor, so a separate ID-colored pass is plausible but its cost is engine-side: evidence H kept. Severity medium kept: per rendered frame for the surface life, but only after an app removes these modifiers, and the size of the pass is unmeasured (not a leak that grows per toggle). Detach order checked: SciChartSurfaceBase.js:620-626 calls onDetach() before setParentSurface(undefined), so parentSurface is usable in onDetach. Fix corrected: the original captured hitTestWasEnabled from the surface on every attach, so with both modifiers attached (Tooltip then Selection) the second captured true (set by the first) and, if detached last, never turned the pass off; the corrected diff inherits the captured value from an already-attached hit-test modifier, and puts the SeriesSelectionModifier3D check in its real onDetach (which has no if (this.parentSurface) block and calls super.onDetach() last). trade_off updated: series.hitTest() throws a clear error when it is off (BaseRenderableSeries3D.js:259-261), so the breakage case is loud, not silent.

