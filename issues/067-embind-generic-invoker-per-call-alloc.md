# 067 · Every embind call runs two generic rest/spread layers: craftInvokerFunction's shared invokerFn (DYNAMIC_EXECUTION=0, no EMBIND_AOT) and the 'p'-signature getDynCaller/dynCall wrapper

| | |
|---|---|
| Package | `scichart@6.0.6` (npm, ESM build) |
| Location | `_glue-pretty/scichart.js:4648` |
| Severity | **medium** |
| Pipeline stage | JS execution (`js`) |
| Metric | frame time (also GC) |
| Evidence | H — hypothesis, depends on data size/hardware (not measured) |
| Verification | verified by an independent adversarial reviewer (corrected) |
| Rule | TASK-13 (also V8-06) (web-performance skill) |
| Effort to fix | small |

## Code

```js
      var invokerFn = function (...args) {
        destructors.length = 0;
        var thisWired;
        invokerFuncArgs.length = isClassMethodFunc ? 2 : 1;
        invokerFuncArgs[0] = cppTargetFunc;
        if (isClassMethodFunc) {
          thisWired = argTypes[1].toWireType(destructors, this);
          invokerFuncArgs[1] = thisWired;
        }
        for (var i = 0; i < expectedArgCount; ++i) {
          argsWired[i] = argTypes[i + 2].toWireType(destructors, args[i]);
          invokerFuncArgs.push(argsWired[i]);
        }
        var rv = cppInvokerFunc(...invokerFuncArgs);
        function onDone(rv) {
```

## Call path and frequency

Per frame, per axis label: NativeAxisRenderer.js:61 DrawStringAdvanced(..., getVector4(...)) -> NativeObject.js:248 vector4.Assign (embind method) + nativeFont.DrawStringAdvanced (embind method, plus std::string toWireType malloc/encode at _glue-pretty/scichart.js:5355ff). Per frame, per visible data label without a text dictionary: BaseDataLabelProvider.js:169 getVector4 -> Assign, :179 DrawStringAdvanced. Per vertex of render-context line geometry: WebGlRenderContext2D.js:290 getVertex -> NativeObject.js:139 SetPosition, then vertices.push_back. Per point with dataSeries.append. Each of those method calls enters invokerFn (_glue-pretty/scichart.js:4648: rest array, spread call at :4661, new onDone closure at :4662), whose cppInvokerFunc came from embind__requireFunction (:4408); because the signature contains 'p' (:4411) that is getDynCaller's `(...args) => dynCall(sig, ptr, args)` (:4404-4407), and dynCall (:560-567) does getWasmTableEntry, `func(...args)` and allocates a `convert` closure. Frequency: hundreds to thousands of calls per surface per frame.

## Why it costs

The glue is built with -sDYNAMIC_EXECUTION=0 (abort text at _glue-pretty/scichart.js:684) and without EMBIND_AOT, so craftInvokerFunction cannot emit a fixed-arity invoker per signature: every bound method shares one function literal, so all its call sites (toWireType, fromWireType, cppInvokerFunc, destructorFunction) share one feedback vector and go megamorphic. Per call the source allocates a rest array and an onDone closure and makes a spread call; with 4 GB addressing the 'p' signature adds a second layer (getDynCaller rest array, dynCall spread and a convert closure). TurboFan may elide some of these allocations, so the per-call cost is a hypothesis; the shared megamorphic path is certain. Not measured.

**Scale where it matters:** Matters with dashboards of many surfaces, data labels on hundreds or thousands of points, many render-context annotations, or per-point append loops. A single chart with ~20 axis labels makes on the order of a hundred calls per frame, where the overhead is small.

## Fix (library side)

```diff
# core link flags (build script, not shipped in the package)
-  -sDYNAMIC_EXECUTION=0
+  -sDYNAMIC_EXECUTION=0 -sEMBIND_AOT
# Effect on _glue/scichart.js and _glue/scichart-64.js: craftInvokerFunction uses per-signature invokers generated
# at build time (fixed arity, no ...args, no onDone closure, no spread) instead of the generic invokerFn above.
# No eval, so the build stays CSP-safe. The getDynCaller/dynCall layer for 'p' signatures (_glue-pretty/scichart.js:4404-4415)
# is not changed by this flag; it stays while the build can address more than 2 GB.
```

**Trade-off:** The glue grows by one small function per distinct binding signature. EMBIND_AOT must be checked against this MAIN_MODULE/SIDE_MODULE build, because the dlopen'd charting3d module registers bindings that also need invokers; if it does not work, the fallback is the current behaviour. The dynCall layer remains (removing it would mean lowering the memory cap, a behaviour change). No API change.

## App-side workaround

Make fewer embind calls: appendRange instead of per-point append (SC-01), fewer data labels and annotations (SC-21), and the text-dictionary data-label path where it applies. Nothing removes the per-call overhead itself.

## Verify

measure.md#fps, 'stream' scenario on a dashboard of 16 create() surfaces with data labels on, 5 runs per side. Pass: compare-runs 'win' on frameP95Ms or LoAF script time, invokerFn/onDone leave the top self-time functions in the trace, and the GC row in trace-summary.mjs goes down.

## Other locations

- `_glue-pretty/scichart.js:4404` — getDynCaller: `(...args) => dynCall(sig, ptr, args, promising)` wraps every 'p'-signature invoker
- `_glue-pretty/scichart.js:4411` — embind__requireFunction: `if (signature.includes("p")) return getDynCaller(...)`
- `_glue-pretty/scichart.js:560` — dynCall: `func(...args)` spread and a per-call `convert` closure
- `_glue-pretty/scichart.js:684` — abort("DYNAMIC_EXECUTION=0 was set, cannot eval") confirms the build flag
- `esm/_glue/scichart-64.js:1` — minified wasm64 glue: the same generic invoker (`function(...args){destructors.length=0`) and the same 'p' getDynCaller check
- `esm/Charting/Visuals/Axis/NativeAxisRenderer.js:61` — per-label caller (Assign + DrawStringAdvanced)
- `esm/Charting/Visuals/RenderableSeries/DataLabels/BaseDataLabelProvider.js:179` — per-data-label caller
- `esm/Charting/Drawing/WebGlRenderContext2D.js:290` — per-vertex SetPosition + push_back

## Review notes

- Found by reviewer slice `s02-init-loading`.
- Adversarial verification (corrected): Re-read craftInvokerFunction (_glue-pretty/scichart.js:4627-4683): quote matches at 4648. Confirmed __embind_register_class_function (:4819) installs craftInvokerFunction's result as proto[methodName], so every class method uses invokerFn. Found a second layer the reviewer missed: embind__requireFunction (:4408-4424) returns getDynCaller (:4404) for any signature containing 'p', and dynCall (:560) adds another spread and closure; same pattern in the minified esm/_glue/scichart.js and scichart-64.js. Confirmed per-frame callers: NativeAxisRenderer.js:61, NativeObject.js:248 (Assign) and :139 (SetPosition), BaseDataLabelProvider.js:169/179, WebGlRenderContext2D.js:290. Evidence lowered S -> H: the allocations are in source but TurboFan escape analysis may remove some, so the per-call cost depends on the JIT. Fix kept (EMBIND_AOT) but noted that it removes only the craftInvokerFunction layer.

