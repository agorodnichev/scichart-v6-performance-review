# 093 · AnnotationHoverModifier rebuilds the z-ordered annotation list (14 filter passes + 9 spreads) twice per pointermove, then does a linear find on the hovered annotation

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/ChartModifiers/AnnotationHoverModifier.js:87` |
| Severity | **low** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time during hover |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Demo | [JSFiddle](https://jsfiddle.net/gh/gist/library/pure/2d9fc23b666ce21f10069a2856ff3d10/): reproduced on WebGL and WebGPU ([source](../demos/093-annotation-hover-target-list/)) |
| Rule | V8-01 (web-performance skill) |
| Effort to fix | small |

## Code

```js
    getAllTargets() {
        const visibleAnnotations = this.parentSurface.annotations.asArray().filter(annotation => !annotation.isHidden);
        const visibleDomAnnotations = visibleAnnotations.filter(annotation => annotation.isDomAnnotation);
        const svgAnnotations = visibleDomAnnotations.filter(annotation => annotation.isSvgAnnotation);
        const htmlAnnotations = visibleDomAnnotations.filter(annotation => !annotation.isSvgAnnotation);
```

## Call path and frequency

canvas pointermove (esm/Core/Mouse/MouseManager.js:70) -> onPointerMove (:107-114, synchronous) -> MouseManager.modifierMouseMove (:308, :319-322) -> AnnotationHoverModifier.modifierMouseMove (AnnotationHoverModifier.js:44) -> PointerEventsMediatorModifier.modifierMouseMove (PointerEventsMediatorModifier.js:89) -> performHoverAction (:112, :154). getIncludedTargets() falls back to getAllTargets() (:152, :155) when no targets are set (and the id-list targetsSelector at :39 also calls getAllTargets), then the default AbsoluteTopmost branch calls getAllTargets() again (:178). `includedEntities.find(...)` (:184) scans the included list once when the topmost annotation is hit (the loop breaks after the first hit). This runs once per pointer event while the modifier is attached; enableHover defaults to true (AnnotationHoverModifier.js:28).

## Why it costs

Each getAllTargets() call runs 14 filter() passes that allocate 14 arrays, then a 9-way spread into a 15th. The passes visit about 6N + 2D + 3H elements (N visible annotations, D DOM, H HTML), so 6N to 11N predicate calls. Two calls per move make 30 short-lived arrays and 12N to 22N visits. When an annotation is hovered, the find adds one more O(N) scan. All of this comes before the O(N) checkIsWithinBounds hit test (AnnotationBase.js:571), so it multiplies script time and GC pressure on the input path by a constant. It matters only with hundreds of annotations.

**Scale where it matters:** Charts with hundreds of annotations (trade markers, labels, event lines) and an AnnotationHoverModifier, which has hover enabled by default.

## Fix (library side)

```diff
--- esm/Charting/ChartModifiers/PointerEventsMediatorModifier.js
-    getIncludedTargets() {
-        return this.targets ?? this.targetsSelector?.call(this, this) ?? this.getAllTargets();
+    getIncludedTargets(allTargets) {
+        return this.targets ?? this.targetsSelector?.call(this, this) ?? allTargets ?? this.getAllTargets();
     }
     performHoverAction(args) {
-        const includedEntities = this.getIncludedTargets();
+        // build the z-ordered list once per move and reuse it for the default include list
+        const allTargets = this.hoverMode === EHoverMode.AbsoluteTopmost ? this.getAllTargets() : undefined;
+        const includedEntities = this.getIncludedTargets(allTargets);
@@ AbsoluteTopmost branch
-            const allTargets = this.getAllTargets();
             const size = allTargets.length;
@@
-                    const isIncluded = includedEntities.find((entity) => entity === currentTarget);
+                    const isIncluded = includedEntities === allTargets || includedEntities.includes(currentTarget);
--- esm/Charting/ChartModifiers/AnnotationHoverModifier.js
     getAllTargets() {
-        const visibleAnnotations = ...filter(...);   // 14 filter() calls (lines 88-101)
-        ...
-        return [...htmlBackgroundAnnotations, ...svgBackgroundAnnotations, ... 9 spreads];
+        // output order: htmlBg, svgBg, rcBg, rcBelow, rcAbove, svgBelow, htmlBelow, svgAbove, htmlAbove
+        const b = [[], [], [], [], [], [], [], [], []];
+        const anns = this.parentSurface.annotations.asArray();
+        for (let i = 0; i < anns.length; i++) {
+            const a = anns[i];
+            if (a.isHidden) continue;
+            const l = a.annotationLayer;
+            const li = l === EAnnotationLayer.Background ? 0 : l === EAnnotationLayer.BelowChart ? 1 : l === EAnnotationLayer.AboveChart ? 2 : -1;
+            if (li < 0) continue;
+            if (a.isSvgAnnotation) {
+                if (a.isDomAnnotation) b[[1, 5, 7][li]].push(a);
+            } else {
+                b[[2, 3, 4][li]].push(a);                         // render-context bucket keeps HTML annotations too, as today
+                if (a.isDomAnnotation) b[[0, 6, 8][li]].push(a);  // HTML bucket
+            }
+        }
+        const out = [];
+        for (let k = 0; k < 9; k++) for (let j = 0; j < b[k].length; j++) out.push(b[k][j]);
+        return out;
     }
```

**Trade-off:** None if the order is kept. The single-pass version must keep HTML annotations in both the html and render-context buckets, as the current filters do, so the hover result and the includedEntities passed to onHover stay identical. Removing that duplicate would be a separate behaviour change.

## App-side workaround

Pass `targets` as an array of annotation references (not ids, because an id list goes through getAllTargets at PointerEventsMediatorModifier.js:39) together with `hoverMode: EHoverMode.TopmostIncluded`, so getAllTargets() is not called per move. Note that TopmostIncluded no longer lets non-target annotations on top block the hover.

## Verify

measure.md#fps hover scenario: 500 annotations with AnnotationHoverModifier, pointer sweep for 5 s, 5 runs per side. Pass: LoAF script time attributed to getAllTargets/performHoverAction goes down, and frameP95Ms wins or is neutral.

## Other locations

- `esm/Charting/ChartModifiers/PointerEventsMediatorModifier.js:155` — getIncludedTargets() -> getAllTargets() fallback (:152), first build per move
- `esm/Charting/ChartModifiers/PointerEventsMediatorModifier.js:178` — second getAllTargets() per move
- `esm/Charting/ChartModifiers/PointerEventsMediatorModifier.js:184` — linear find on the hovered target (at most once per move)

## Review notes

- Found by reviewer slice `s10-modifiers-input`.
- Adversarial verification (corrected): Re-read AnnotationHoverModifier.js:87-113 (quote matches verbatim at 87-91) and PointerEventsMediatorModifier.js:89-236. Call chain confirmed: canvas 'pointermove' listener (esm/Core/Mouse/MouseManager.js:70) -> onPointerMove (:107-114, synchronous, no rAF coalescing) -> MouseManager.modifierMouseMove (:308, forEach :319, cm.modifierMouseMove :322) -> AnnotationHoverModifier.modifierMouseMove (:44, enableHover defaults to true at :28) -> PointerEventsMediatorModifier.modifierMouseMove (:89) -> performHoverAction (:112) because getIsActionAllowed returns true (ChartModifierBase.js:258). performHoverAction calls getIncludedTargets (:155) which falls back to getAllTargets (:152) when no targets were given, and the default AbsoluteTopmost branch calls getAllTargets again (:178). With id-list targets the selector (:39) also calls getAllTargets, so it is still twice. asArray() returns the backing array (ObservableArray.js:31), so no extra copy there. No caching, dirty flag or early return defeats it. Corrections: getAllTargets has 14 filter() calls (lines 88-101), not 13. Each call allocates 15 arrays, so 30 per move, not 26. The element visits per call are 6N + 2D + 3H (D = DOM annotations, H = HTML annotations), so about 6N-11N per call and 12N-22N per move, not '26 times N'. The find at :184 runs at most once per move because the loop breaks on the first hit. The hit test itself (AnnotationBase.js:571 checkIsWithinBounds: translateFromCanvasToSeriesViewRect + checkIsClickedOnAnnotationInternal per annotation) is heavier per item than these predicates, so this is a constant-factor overhead. low/H is kept: the mechanism is certain, but whether it matters depends on N (V8-01 Avoid: a plain loop is fine for a few dozen items). The original fix inlined getIncludedTargets into performHoverAction. getIncludedTargets is public in the typings (PointerEventsMediatorModifier.d.ts:88), so inlining would bypass a subclass override. The corrected fix passes the prebuilt list as an optional argument instead. The single-pass getAllTargets is now concrete and keeps the existing behaviour where an HtmlCustomAnnotation (isSvg=false, isDom=true) appears in both the html and render-context buckets. SC-27 was dropped: it covers custom modifiers, and this is internal to a built-in one. Call path updated with the MouseManager file path.

