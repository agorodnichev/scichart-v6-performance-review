# 093 · AnnotationHoverModifier rebuilds the z-ordered annotation list (13 filter passes + 9 spreads) twice per pointermove, then does a linear includes-search per hit

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/ChartModifiers/AnnotationHoverModifier.js:87` |
| Severity | **low** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time during hover |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | V8-01, SC-27 (web-performance skill) |
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

pointermove -> MouseManager.modifierMouseMove (MouseManager.js:319-322) -> AnnotationHoverModifier.modifierMouseMove (AnnotationHoverModifier.js:44) -> PointerEventsMediatorModifier.modifierMouseMove (PointerEventsMediatorModifier.js:89) -> performHoverAction (:112, :154). getIncludedTargets() falls back to getAllTargets() (:152, :155), then the default AbsoluteTopmost mode calls getAllTargets() again (:178), and `includedEntities.find(...)` scans the list per hit (:184). Runs once per pointer event.

## Why it costs

Each move allocates about 26 intermediate arrays and walks all N annotations about 26 times before the hit test itself, which is O(N) and cannot be avoided. That multiplies the per-event script cost by a constant and creates garbage on the input path.

**Scale where it matters:** Charts with hundreds of annotations (trade markers, labels, event lines) and an AnnotationHoverModifier, which has hover enabled by default.

## Fix (library side)

```diff
--- esm/Charting/ChartModifiers/PointerEventsMediatorModifier.js
     performHoverAction(args) {
-        const includedEntities = this.getIncludedTargets();
+        const allTargets = this.hoverMode === EHoverMode.AbsoluteTopmost ? this.getAllTargets() : undefined;
+        const includedEntities = this.targets ?? this.targetsSelector?.call(this, this) ?? allTargets ?? this.getAllTargets();
@@ AbsoluteTopmost branch
-            const allTargets = this.getAllTargets();
@@
-                    const isIncluded = includedEntities.find((entity) => entity === currentTarget);
+                    const isIncluded = includedEntities === allTargets || includedEntities.includes(currentTarget);
--- esm/Charting/ChartModifiers/AnnotationHoverModifier.js: build the 9 layer buckets in one loop over annotations instead of 13 filter() calls
```

**Trade-off:** None: same order, same hover result.

## App-side workaround

Pass explicit `targets` together with `hoverMode: EHoverMode.TopmostIncluded`, so getAllTargets() is not called per move.

## Verify

measure.md#fps hover scenario: 500 annotations with AnnotationHoverModifier, pointer sweep for 5 s, 5 runs per side. Pass: LoAF script time attributed to getAllTargets/performHoverAction goes down, and frameP95Ms wins or is neutral.

## Other locations

- `esm/Charting/ChartModifiers/PointerEventsMediatorModifier.js:178` — second getAllTargets() per move
- `esm/Charting/ChartModifiers/PointerEventsMediatorModifier.js:184` — linear find per hovered target

## Review notes

- Found by reviewer slice `s10-modifiers-input`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

