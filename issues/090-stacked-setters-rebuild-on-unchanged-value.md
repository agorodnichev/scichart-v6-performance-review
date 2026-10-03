# 090 · Stacked collection setters mark the whole accumulation dirty even when the value is unchanged

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/BaseStackedCollection.js:180` |
| Severity | **low** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (also INP when props are re-applied on UI renders) |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | none (web-performance skill) |
| Effort to fix | small |

## Code

```js
    set isOneHundredPercent(value) {
        this.isOneHundredPercentProperty = value;
        this.notifyPropertyChanged(PROPERTY.IS_ONE_HUNDRED_PERCENT);
    }
```

## Call path and frequency

App sets collection.isOneHundredPercent / isVisible / separatePositiveNegativeStacks, or child.stackedGroupId, to the value it already has (typical when a framework re-applies props on every render) -> notifyPropertyChanged -> StackedXyCollection.notifyPropertyChanged (StackedXyCollection.js:254-261) or StackedColumnCollection.notifyPropertyChanged (StackedColumnCollection.js:315-325) sets isAccumulatedVectorDirty and invalidates the surface -> next frame the full O(N x S) rebuild of finding stacked-accumulation-per-point-push-back-rebuild. Rate: once per frame in which any such set happened.

## Why it costs

There is no rule for this case; the mechanism is invalidation without a change. Other setters in the same classes (stroke, opacity, yRangeMode, xAxisId) compare before they notify, but these do not, so a no-op assignment costs a redraw request and a full rebuild of every accumulated vector.

**Scale where it matters:** Matters only together with the costly rebuild: large stacks (N x S >= 10^5) bound to UI state that is re-applied on every render.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/BaseStackedCollection.js
+++ b/esm/Charting/Visuals/RenderableSeries/BaseStackedCollection.js
     set isVisible(isVisible) {
+        if (this.isVisibleProperty === isVisible) return;
         this.isVisibleProperty = isVisible;
@@
     set isOneHundredPercent(value) {
+        if (this.isOneHundredPercentProperty === value) return;
         this.isOneHundredPercentProperty = value;
 (same guard in StackedXyCollection.separatePositiveNegativeStacks :274, StackedColumnCollection.separatePositiveNegativeStacks :433 and StackedColumnRenderableSeries.stackedGroupId :230)
```

**Trade-off:** Code that relied on a same-value assignment to force a rebuild must call setAccumulatedValuesDirty() and invalidateElement() instead.

## App-side workaround

Compare before you assign: set these properties only when the value actually changes.

## Verify

measure.md#fps with a scenario that re-applies the unchanged props once per frame on a 5 x 100k stack, 5 runs per side. Pass: no LoAF time in updateAccumulatedVectors during the scenario and frameP95Ms wins. Not measured.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/BaseStackedCollection.js:123` — isVisible setter
- `esm/Charting/Visuals/RenderableSeries/StackedXyCollection.js:274` — separatePositiveNegativeStacks setter
- `esm/Charting/Visuals/RenderableSeries/StackedColumnCollection.js:433` — separatePositiveNegativeStacks setter
- `esm/Charting/Visuals/RenderableSeries/StackedColumnRenderableSeries.js:230` — stackedGroupId setter

## Review notes

- Found by reviewer slice `s03-renderable-series`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

