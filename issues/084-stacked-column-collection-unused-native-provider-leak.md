# 084 · StackedColumnCollection.onAttach allocates an unused native drawing provider on every attach and never frees the previous one

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/StackedColumnCollection.js:312` |
| Severity | **low** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory (wasm heap) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | **not yet verified**: reviewer-only candidate, see README "Verification status" |
| Rule | SC-29 (web-performance skill) |
| Effort to fix | small |

## Code

```js
    onAttach(scs) {
        super.onAttach(scs);
        this.nativeDrawingProvider = new this.webAssemblyContext.SCRTStackedColumnSeriesDrawingProvider();
    }
```

## Call path and frequency

surface.renderableSeries.add(collection) -> SciChartSurface.attachSeries -> StackedColumnCollection.onAttach (StackedColumnCollection.js:310-313) -> new SCRTStackedColumnSeriesDrawingProvider. surface.renderableSeries.remove(collection, false) -> BaseStackedCollection.onDetach (BaseStackedCollection.js:570-573) does not free it, so adding the collection back allocates another one. Only StackedColumnCollection.delete (:99-101) frees the last one. The field is read only by the commented-out drawColumns path (:238-255, :551-578); each child draws through its own StackedColumnSeriesDrawingProvider (DrawingProviders/StackedColumnSeriesDrawingProvider.js:30). Rate: once per attach.

## Why it costs

A native object is created that nothing draws with. It is reachable only through a field that is overwritten on the next attach, so its wasm memory is never released.

**Scale where it matters:** Apps that move a stacked column collection between surfaces, or toggle it in and out of a chart with remove(..., false) and add. One native object leaks per re-attach.

## Fix (library side)

```diff
--- a/esm/Charting/Visuals/RenderableSeries/StackedColumnCollection.js
+++ b/esm/Charting/Visuals/RenderableSeries/StackedColumnCollection.js
     onAttach(scs) {
         super.onAttach(scs);
-        this.nativeDrawingProvider = new this.webAssemblyContext.SCRTStackedColumnSeriesDrawingProvider();
     }
 (keep `this.nativeDrawingProvider = deleteSafe(this.nativeDrawingProvider)` in delete(); it becomes a no-op. If the field must stay, guard with `if (!this.nativeDrawingProvider)`.)
```

**Trade-off:** None: the object is only referenced by dead code.

## App-side workaround

Toggle collection.isVisible instead of removing and re-adding the collection, or delete() the collection and create a new one.

## Verify

measure.md#mem: remove(collection, false) and add it back 10 times, with the wasm heap size as an app counter. Pass: after warm-up, heap growth per repetition is within noise. Not measured.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/BaseStackedCollection.js:570` — onDetach does not release it

## Review notes

- Found by reviewer slice `s03-renderable-series`.
- Not yet adversarially verified. The code quote and line numbers come from the slice reviewer; re-check them before acting.

