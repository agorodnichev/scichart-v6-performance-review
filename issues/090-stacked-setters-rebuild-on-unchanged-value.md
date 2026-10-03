# 090 · Stacked collection setters mark the whole accumulation dirty even when the value is unchanged

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/BaseStackedCollection.js:180` |
| Severity | **low** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (also INP when props are re-applied on UI renders) |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
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

There is no rule for this case. The mechanism is invalidation without a change. Comparable setters compare before they notify: the collection's xAxisId and yRangeMode (BaseStackedCollection.js:131, :186), the child's isVisible, stroke and opacity (BaseRenderableSeries.js:299, :361, :383) and StackedColumnRenderableSeries.yAxisId (:196). The collection's stroke and opacity setters throw. These five setters do not compare, so a no-op assignment costs a redraw request and a full rebuild of every accumulated vector on the next draw (updateAccumulatedVectors, guarded only by isAccumulatedVectorDirty: StackedXyCollection.js:35, StackedColumnCollection.js:106).

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
- Adversarial verification (corrected): Re-read BaseStackedCollection.js:179-182 (isOneHundredPercent setter; quote verbatim, primary 180 inside it) and :123-126 (isVisible), StackedXyCollection.js:274-277, StackedColumnCollection.js:433-436 and StackedColumnRenderableSeries.js:230-233 (stackedGroupId). None of them compares before notifying. Paths: collection setters -> StackedXyCollection.notifyPropertyChanged (:254-261) / StackedColumnCollection.notifyPropertyChanged (:315-325) -> BaseStackedCollection.notifyPropertyChanged (:455-457, invalidateParent) plus isAccumulatedVectorDirty = true. Child stackedGroupId -> BaseStackedRenderableSeries.notifyPropertyChanged (:97-102) -> notifyParentPropertyChangedFn, which is the collection's notifyPropertyChanged (wired in StackedColumnCollection.attachChildSeries :475). The next draw runs updateAccumulatedVectors (StackedXyCollection.js:167, StackedColumnCollection.js:205), whose only guard is the dirty flag (:35 / :106). No other guard was found, and the child isVisible goes through the guarded BaseRenderableSeries setter (:299-302), so the list of locations is complete. Rate depends on the app re-assigning props (discrete UI renders, not per frame by itself), so low/H stays. Corrected why_it_costs: it said that the collection's stroke and opacity setters compare before they notify, but BaseStackedCollection.stroke (:288) and opacity (:324) throw. The setters that do compare are the collection's xAxisId (:131-135) and yRangeMode (:186-190), the child's isVisible, stroke and opacity (BaseRenderableSeries.js:299/361/383), and StackedColumnRenderableSeries.yAxisId (:196-200). Fix diff checked: a minimal early return that is safe at construction, because isAccumulatedVectorDirty starts true (BaseStackedCollection.js:43).

