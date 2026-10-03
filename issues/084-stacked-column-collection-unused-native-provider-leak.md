# 084 · StackedColumnCollection.onAttach allocates an unused native drawing provider on every attach and never frees the previous one

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `esm/Charting/Visuals/RenderableSeries/StackedColumnCollection.js:312` |
| Severity | **low** |
| Pipeline stage | Memory and lifecycle (`memory`) |
| Metric | memory (wasm heap) |
| Evidence | S — static, mechanism certain (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
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

measure.md#mem with an instance counter, because wasm memory grows in 64 KB pages and the heap size cannot show one small object per cycle. In a dev build, before creating the chart, wrap the constructor: `const C = wasmContext.SCRTStackedColumnSeriesDrawingProvider; let live = 0; wasmContext.SCRTStackedColumnSeriesDrawingProvider = function () { live++; const o = new C(); const d = o.delete.bind(o); o.delete = () => { live--; d(); }; return o; };`. Then remove(collection, false) and add it back 10 times. Pass: `live` does not grow per cycle (before the fix it grows by 1 per re-attach). Not measured.

## Other locations

- `esm/Charting/Visuals/RenderableSeries/BaseStackedCollection.js:570` — onDetach does not release it

## Review notes

- Found by reviewer slice `s03-renderable-series`.
- Adversarial verification (corrected): Re-read StackedColumnCollection.js:310-313 (onAttach allocates SCRTStackedColumnSeriesDrawingProvider; quote verbatim, primary 312 is the allocation line), :99-101 (delete frees only the current one), :238-255 (only reader is the commented-out drawColumns call) and :551-578 (drawColumns, unused). rg shows no other reader of the field. Attach path: ObservableArray collectionChanged -> SciChartSurface.attachSeries (SciChartSurface.js:1396-1426; isCollection so onAttach runs) -> StackedColumnCollection.onAttach. Detach path: SciChartSurface.detachSeries (:1382-1390; the early return covers only StackedColumnSeries/StackedMountainSeries, not the collection type) -> BaseStackedCollection.onDetach (BaseStackedCollection.js:570-573) which does not free the provider. BaseStackedCollection.onAttach (:561-568) throws on a double attach before the allocation, so the leak needs detach without delete (remove(c,false)) then re-add. Checked that GC cannot rescue it: the embind glue (_glue-pretty/scichart.js:3739-3757) registers a FinalizationRegistry only for smart-pointer handles, and scichart.wasm has only raw-pointer typeinfo for this class (38SCRTStackedColumnSeriesDrawingProvider, P.., PK..; no shared_ptr), so the overwritten handle is never destructed. Mechanism certain (S); one small stateless native object per re-attach on a rare path, so low stays. Corrected only the verify recipe: wasm memory grows in 64 KB pages, so a heap-size counter cannot see one small leaked object per cycle and would give a false pass; replaced with a live-instance counter.

