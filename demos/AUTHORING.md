# Writing a demo

Each demo is a page that runs SciChart.js 6.0.6 from the jsDelivr CDN, drives one scenario, and **measures** whether the issue described in `issues/NNN-*.md` happens. It renders a verdict and a small table. Demos are published as JSFiddle pages (one GitHub gist per demo) and can be run locally.

Pilot demos to copy from: [`012-rollover-marker-svg-reparse`](012-rollover-marker-svg-reparse/demo.js) (hover scenario with an A/B fix patch) and [`027-engine-raf-loop-never-stops`](027-engine-raf-loop-never-stops/demo.js) (phases, no input).

## Files

```
demos/NNN-short-slug/
  demo.js     required: `const META = {...};` then `async function demo(P) {...}`
  demo.html   optional: chart containers (default: <div id="chart" class="probe-chart"></div>)
  demo.css    optional
```

`_tools/build.mjs` turns a folder into `_dist/NNN/` (`fiddle.html/js/css/manifest` for the gist, `index.html` for local runs). The fiddle's JS is `demo.js` + `_shared/probe.js` + `Probe.boot(META, demo)`, so the demo code is what a reader sees first.

`META` fields: `id` ("012"), `title` (short statement of the defect, under ~90 characters), `issue` (`"issues/NNN-....md"`), `severity`, `claim` (1-2 plain sentences: what the library does wrong and why), `method` (HTML: scenario and sizes, what is counted, the A/B). Optional: `communityLicense: false` (skip `UseCommunityLicense()`), `beforeLoad(P)` (runs before the SciChart script is injected).

## Harness API (`P`)

```
P.SciChart                                   SciChart UMD namespace (index.min.js); exports many internals too
P.createSurface(div, opts, single?)          -> { sciChartSurface, wasmContext }   create() or createSingle()
P.createSurface3D(div, opts, single?)        -> { sciChart3DSurface, wasmContext }
P.createPie(div, opts)                       -> SciChartPieSurface
P.renderer()                                 "WebGL" | "WebGPU" (after the first surface)

Counters: one registry of { n, t (ms), bytes } per name. Read deltas with P.frames / P.during.
P.count(name, n?, bytes?)
P.hookMethod(target, method, { name, time, bytes(args, ret, self), onCall(args, self, ret) }) -> undo()
P.hookAccessor(proto, prop, { name, time, set: true, get: false, onGet, onSet })              -> undo()
P.hookConstructor(owner, ctorName, { name, onNew(obj, args), countCalls })                    -> undo()
P.watch.layout()     getBBox, getBoundingClientRect, getClientRects, getComputedStyle, offset*/client*/scroll*,
                     MouseEvent.offsetX/Y (timed) + "layout reads" + "layout reads after a DOM write (forced layout)"
P.watch.domWrites()  "DOM appendChild|insertBefore|removeChild|replaceChild|remove|append|prepend|setAttribute|removeAttribute|insertAdjacentHTML",
                     "innerHTML.set", "textContent.set", "style.<prop>.set", "style.setProperty",
                     "createContextualFragment (HTML/SVG parse)", "DOMParser.parseFromString"
P.watch.canvas2d()   "2d.getImageData" (bytes), "2d.putImageData", "2d.clearRect" (bytes = area x 4), "2d.fillText", "2d.measureText",
                     "2d.drawImage" (+ "offscreen2d.*"), "canvas elements created", "OffscreenCanvas created", "getContext(willReadFrequently)"
P.watch.gpu()        "gl.texImage2D" / "gl.texSubImage2D" (bytes), "gl.createTexture", "gl.deleteTexture", "gl.bufferData", "gl.bufferSubData",
                     "gl.readPixels", "gl.draw calls", "gl.compileShader"; "gpu.writeTexture" / "gpu.writeBuffer" /
                     "gpu.copyExternalImageToTexture" (bytes), "gpu.createTexture", "gpu.createBuffer", "gpu.createShaderModule",
                     "gpu.texture.destroy", "gpu.submit", "gpu.buffer.mapAsync (readback)"
P.watch.timers()     "requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "setInterval", "new MessageChannel"
P.watch.network()    "fetch", "XMLHttpRequest.open", "new WebSocket"; URL log in P.netLog
P.watch.listeners()  "listeners added: <type>", "listeners removed: <type>", "non-passive wheel listeners on <canvas>"
P.watch.intl()       "new Intl.DateTimeFormat", "new Intl.NumberFormat", "Date.toLocaleDateString|TimeString|String", "Number.toLocaleString"
P.watch.json()       "JSON.stringify", "JSON.parse", "JSON.parse reviver calls"
P.watch.sciEvents()  "EventHandler.subscribe", "EventHandler.unsubscribe"
P.watchEmbind(wasmContext, ["SCRTDoubleVector.get", "NumberUtil::Constrain", "TSRRequestCanvasDraw"])
                     counts calls into wasm as "wasm <spec>" (Class.method = prototype, Class::fn = static, fn = module level)
P.native.start() / stop() / reset() / snapshot() -> { ClassName: { created, deleted, live } } for every embind object.
                     Handles that wrap non-owning references also count as created and are never deleted:
                     compare against a baseline and look at the class the issue names.

Flow
await P.frames(n, perFrame(i))  -> r.perFrame(name, field = "n" | "t" | "bytes"), r.total(name, field), r.delta, r.frameP50, r.frameP95, r.ms
await P.during(asyncFn)         -> r.total(name, field), r.delta, r.ms, r.ret
P.pointer(surface, { realOffsets }) -> enter(fx, fy), move(fx, fy), leave(), down(fx, fy), up(fx, fy), wheel(fx, fy, dy), sweepX(i, n)
                     (fx, fy are fractions of the canvas; events carry offsetX/offsetY unless realOffsets: true)
P.nextFrame(), P.idleFrames(n), P.sleep(ms), P.now(), await P.gc() (true only when forced GC is available), P.memory(wasmContext), P.loaf

Output
P.status(text), P.log(text), P.quiet(fn)
P.report({ verdict: "reproduced" | "not-reproduced" | "inconclusive", headline, columns, rows: [[label, ...values]], notes, metrics })
```

Prototype methods of exported classes can be wrapped or patched (`P.SciChart.SomeClass.prototype`). Free functions that SciChart imports internally (for example `parseColorToUIntArgb`) cannot be intercepted: measure them through what they call (browser APIs, wasm calls) or through the exported method that calls them.

## Proof standards

1. **Measure; never assume.** The verdict is computed from counters in the page with an explicit threshold derived from the scenario (for example "SVG parses per frame >= 0.8 x series count"). No hard-coded results.
2. **Counts first, time second.** Prefer hardware-independent evidence: calls per frame or per action, bytes uploaded or read back, native objects created vs deleted, listeners or subscriptions alive, rAF requests per second. Add a timing row (time inside the hooked method, or frame p95) as secondary evidence and say it depends on hardware.
3. **Show causality when you can.** If the issue's app-side workaround or a small prototype patch can be applied at runtime, run the same scenario again with it ("As shipped" vs "With workaround/fix" columns) and restore the original afterwards.
4. **Realistic scale.** Use the scale from the issue's "Scale where it matters", kept small enough that the page stays responsive (no task over ~1 s) and the whole run takes under ~30 s.
5. **Honest outcomes.** If the scenario that should trigger the issue does not, re-read the code path and fix the scenario. If it still does not reproduce, report `not-reproduced` and explain what was measured. Never tune thresholds to force a verdict. Use `inconclusive` when the environment lacks a precondition (for example DPR 1 when the issue needs DPR != 1), and tell the reader what to change.
6. **Skip** an issue (no demo) only when an in-browser proof is not practical: the cost is entirely inside the wasm engine with no JS-visible trace, it needs a server or network setup a fiddle cannot have, or it needs conditions a page cannot create. Write down why in one or two sentences.

## Practical notes

- Colors must be hex (`#4e79a7`); SciChart rejects `hsl()`.
- Pass `isSorted: true, containsNaN: false` on sorted data series to avoid console warnings.
- Pointer-driven modifiers act only inside the series area: keep `fy` around 0.5 and `fx` within 0.1-0.9.
- `sciChartSurface.invalidateElement()` forces a render; for "every frame while streaming" claims, append one point (or one batch) per frame inside `P.frames`.
- The engine's rAF loop runs every vsync (issue 027), so frames keep coming without input.
- The renderer comes from the page's selector (`localStorage.IS_WEB_GPU`); the verifier runs both. If an issue is renderer-specific, detect `P.renderer()` and say so.
- `P.gc()` works only in the headless verifier (`--js-flags=--expose-gc`), not on JSFiddle. Do not make the verdict depend on it.
- Keep charts visible so a reader can see the scenario run. Restore every patch you apply.

## Build and verify

```bash
cd demos
node _tools/build.mjs 012                      # -> _dist/012/
node _tools/verify.mjs 012                     # headless Chrome, WebGL and WebGPU; --dpr 2, --renderer webgl, --headful
```

The verifier needs a static server on `demos/`: `python3 -m http.server 8770 --bind 127.0.0.1 -d demos`. Results go to `_dist/NNN/result-<renderer>.json`.
