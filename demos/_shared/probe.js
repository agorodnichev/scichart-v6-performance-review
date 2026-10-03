// =====================================================================================
// Measurement harness, shared by every demo in this set (scichart-v6-performance-review).
// It is not part of the reproduction. It loads SciChart, installs counters, drives
// frames and pointer moves, and renders the result table. The demo code is above.
// =====================================================================================
/* eslint-disable no-var, prefer-rest-params */
var Probe = (function () {
  "use strict";

  var SCICHART_VERSION = "6.0.6";
  var SCICHART_URL = "https://cdn.jsdelivr.net/npm/scichart@" + SCICHART_VERSION + "/index.min.js";
  var REPO_URL = "https://github.com/agorodnichev/scichart-v6-performance-review/blob/HEAD/";
  var RENDERER_KEY = "scichartPerfDemo.renderer"; // auto | webgl | webgpu

  // Keep originals before anything is hooked, so the harness never counts itself.
  var raf = window.requestAnimationFrame.bind(window);
  var now = performance.now.bind(performance);
  var setTimeout0 = window.setTimeout.bind(window);
  var ObjectCreate = Object.create;

  // ---------------------------------------------------------------- counters
  var C = new Map(); // name -> { n, t, bytes }
  function rec(name) {
    var r = C.get(name);
    if (!r) { r = { n: 0, t: 0, bytes: 0 }; C.set(name, r); }
    return r;
  }
  function count(name, n, bytes) { var r = rec(name); r.n += n == null ? 1 : n; if (bytes) r.bytes += bytes; }
  function snap() { var o = {}; C.forEach(function (v, k) { o[k] = { n: v.n, t: v.t, bytes: v.bytes }; }); return o; }
  function diff(a, b) {
    var o = {};
    Object.keys(b).forEach(function (k) {
      var x = a[k] || { n: 0, t: 0, bytes: 0 }, y = b[k];
      if (y.n !== x.n || y.bytes !== x.bytes) o[k] = { n: y.n - x.n, t: +(y.t - x.t).toFixed(3), bytes: y.bytes - x.bytes };
    });
    return o;
  }
  function get(d, name, field) { var r = d[name]; return r ? r[field || "n"] : 0; }

  var hooks = [];
  var enabled = true; // the harness switches counting off for its own DOM work

  // Wrap target[name] (a method). opts: { name, time, bytes(args, ret, self), onCall(args, self, ret) }
  function hookMethod(target, name, opts) {
    opts = opts || {};
    var orig = target && target[name];
    if (typeof orig !== "function") return function () {};
    var label = opts.name || name;
    var wrapped = function () {
      if (!enabled) return orig.apply(this, arguments);
      var t0 = opts.time ? now() : 0;
      var ret = orig.apply(this, arguments);
      var r = rec(label);
      r.n++;
      if (opts.time) r.t += now() - t0;
      if (opts.bytes) { try { r.bytes += opts.bytes(arguments, ret, this) || 0; } catch (e) { /* ignore */ } }
      if (opts.onCall) { try { opts.onCall(arguments, this, ret); } catch (e) { /* ignore */ } }
      return ret;
    };
    try { Object.defineProperty(wrapped, "name", { value: orig.name }); } catch (e) { /* ignore */ }
    for (var k in orig) { if (Object.prototype.hasOwnProperty.call(orig, k)) { try { wrapped[k] = orig[k]; } catch (e) { /* ignore */ } } }
    if (orig.prototype) wrapped.prototype = orig.prototype;
    target[name] = wrapped;
    var undo = function () { if (target[name] === wrapped) target[name] = orig; };
    hooks.push(undo);
    return undo;
  }

  // Wrap an accessor (getter and/or setter) found on proto or its chain.
  function hookAccessor(proto, prop, opts) {
    opts = opts || {};
    var owner = proto, d;
    while (owner && !(d = Object.getOwnPropertyDescriptor(owner, prop))) owner = Object.getPrototypeOf(owner);
    if (!d || (!d.get && !d.set)) return function () {};
    var label = opts.name || prop;
    var nd = { configurable: true, enumerable: d.enumerable };
    if (d.get) nd.get = opts.get === false ? d.get : function () {
      if (!enabled) return d.get.call(this);
      var t0 = opts.time ? now() : 0;
      var v = d.get.call(this);
      var r = rec(label + (opts.set === undefined ? "" : ".get"));
      r.n++;
      if (opts.time) r.t += now() - t0;
      if (opts.onGet) { try { opts.onGet(this, v); } catch (e) { /* ignore */ } }
      return v;
    };
    if (d.set) nd.set = !opts.set ? d.set : function (v) {
      if (enabled) { count(label + ".set"); if (opts.onSet) { try { opts.onSet(this, v); } catch (e) { /* ignore */ } } }
      return d.set.call(this, v);
    };
    Object.defineProperty(proto, prop, nd);
    var undo = function () { Object.defineProperty(proto, prop, d); };
    hooks.push(undo);
    return undo;
  }

  // Replace owner[ctorName] with a Proxy that counts `new`.
  function hookConstructor(owner, ctorName, opts) {
    opts = opts || {};
    var Orig = owner[ctorName];
    if (typeof Orig !== "function") return function () {};
    var label = opts.name || ("new " + ctorName);
    var P = new Proxy(Orig, {
      construct: function (T, args, nt) {
        var o = Reflect.construct(T, args, nt === P ? T : nt);
        if (enabled) { count(label); if (opts.onNew) { try { opts.onNew(o, args); } catch (e) { /* ignore */ } } }
        return o;
      },
      apply: function (T, self, args) {
        if (enabled && opts.countCalls) count(label);
        return Reflect.apply(T, self, args);
      },
    });
    owner[ctorName] = P;
    var undo = function () { if (owner[ctorName] === P) owner[ctorName] = Orig; };
    hooks.push(undo);
    return undo;
  }

  // ---------------------------------------------------------------- layout dirty tracking
  // A layout read that follows a DOM/style write in the same frame is counted as a likely
  // forced (synchronous) style+layout. The flag clears after the browser's own rendering step.
  var layoutDirty = false;
  function markDirty() { layoutDirty = true; }
  function layoutRead(name) {
    count("layout reads");
    if (layoutDirty) { count("layout reads after a DOM write (forced layout)"); layoutDirty = false; }
  }
  var clearLoop = false;
  function startClearAfterRender() {
    if (clearLoop) return;
    clearLoop = true;
    (function tick() { raf(function () { setTimeout0(function () { layoutDirty = false; }, 0); tick(); }); })();
  }

  // ---------------------------------------------------------------- watch groups
  var installed = {};
  function once(key, fn) { if (installed[key]) return; installed[key] = true; fn(); }

  var watch = {
    // getBBox, getBoundingClientRect, offset*/client*/scroll*, getComputedStyle, MouseEvent.offsetX/Y
    layout: function () {
      once("layout", function () {
        var timed = function (target, name, label) {
          hookMethod(target, name, { name: label || name, time: true, onCall: function () { layoutRead(label || name); } });
        };
        if (window.SVGGraphicsElement) timed(SVGGraphicsElement.prototype, "getBBox", "getBBox");
        timed(Element.prototype, "getBoundingClientRect", "getBoundingClientRect");
        timed(Element.prototype, "getClientRects", "getClientRects");
        timed(window, "getComputedStyle", "getComputedStyle");
        ["offsetWidth", "offsetHeight", "offsetTop", "offsetLeft"].forEach(function (p) {
          hookAccessor(HTMLElement.prototype, p, { name: p, time: true, onGet: function () { layoutRead(p); } });
        });
        ["clientWidth", "clientHeight", "clientTop", "clientLeft", "scrollWidth", "scrollHeight", "scrollTop", "scrollLeft"].forEach(function (p) {
          hookAccessor(Element.prototype, p, { name: p, time: true, onGet: function () { layoutRead(p); } });
        });
        ["offsetX", "offsetY"].forEach(function (p) {
          hookAccessor(MouseEvent.prototype, p, { name: "MouseEvent." + p, time: true, onGet: function () { layoutRead(p); } });
        });
      });
      watch.domWrites();
    },
    // DOM mutations and SVG/HTML parsing
    domWrites: function () {
      once("domWrites", function () {
        startClearAfterRender();
        var w = function (target, name, label) { hookMethod(target, name, { name: label, onCall: markDirty }); };
        w(Node.prototype, "appendChild", "DOM appendChild");
        w(Node.prototype, "insertBefore", "DOM insertBefore");
        w(Node.prototype, "removeChild", "DOM removeChild");
        w(Node.prototype, "replaceChild", "DOM replaceChild");
        w(Element.prototype, "remove", "DOM remove");
        w(Element.prototype, "append", "DOM append");
        w(Element.prototype, "prepend", "DOM prepend");
        w(Element.prototype, "setAttribute", "DOM setAttribute");
        w(Element.prototype, "removeAttribute", "DOM removeAttribute");
        w(Element.prototype, "insertAdjacentHTML", "DOM insertAdjacentHTML");
        hookMethod(Range.prototype, "createContextualFragment", { name: "createContextualFragment (HTML/SVG parse)", time: true });
        hookMethod(DOMParser.prototype, "parseFromString", { name: "DOMParser.parseFromString", time: true });
        hookAccessor(Element.prototype, "innerHTML", { name: "innerHTML", set: true, get: false, onSet: markDirty });
        hookAccessor(Node.prototype, "textContent", { name: "textContent", set: true, get: false, onSet: markDirty });
        hookMethod(CSSStyleDeclaration.prototype, "setProperty", { name: "style.setProperty", onCall: markDirty });
        ["left", "top", "width", "height", "transform", "visibility", "opacity", "display", "cssText", "position"].forEach(function (p) {
          hookAccessor(CSSStyleDeclaration.prototype, p, { name: "style." + p, set: true, get: false, onSet: markDirty });
        });
      });
    },
    // Inline style writes, opt-in. Chromium defines CSS properties on each CSSStyleDeclaration
    // object, so watch.domWrites cannot hook them on the prototype. This wraps the element.style
    // getter in a cached Proxy: "style.<prop>.set" counts writes and marks layout dirty.
    styleWrites: function () {
      once("styleWrites", function () {
        startClearAfterRender();
        var proxies = new WeakMap();
        [window.HTMLElement, window.SVGElement].forEach(function (K) {
          var d = K && Object.getOwnPropertyDescriptor(K.prototype, "style");
          if (!d || !d.get) return;
          Object.defineProperty(K.prototype, "style", {
            configurable: true, enumerable: d.enumerable,
            get: function () {
              var st = d.get.call(this);
              if (!st) return st;
              var px = proxies.get(st);
              if (!px) {
                px = new Proxy(st, {
                  set: function (t, k, v) { if (enabled && typeof k === "string") { count("style." + k + ".set"); markDirty(); } t[k] = v; return true; },
                  get: function (t, k) { var v = t[k]; return typeof v === "function" ? v.bind(t) : v; },
                });
                proxies.set(st, px);
              }
              return px;
            },
            set: d.set ? function (v) { if (enabled) { count("style.set"); markDirty(); } d.set.call(this, v); } : undefined,
          });
          hooks.push(function () { Object.defineProperty(K.prototype, "style", d); });
        });
      });
    },
    // Canvas 2D work: readbacks, clears, text
    canvas2d: function () {
      once("canvas2d", function () {
        [window.CanvasRenderingContext2D, window.OffscreenCanvasRenderingContext2D].forEach(function (K) {
          if (!K) return;
          var p = K.prototype, pre = K === window.CanvasRenderingContext2D ? "2d." : "offscreen2d.";
          hookMethod(p, "getImageData", { name: pre + "getImageData", time: true, bytes: function (a) { return Math.abs(a[2] * a[3] * 4); } });
          hookMethod(p, "putImageData", { name: pre + "putImageData", time: true });
          hookMethod(p, "clearRect", { name: pre + "clearRect", time: true, bytes: function (a) { return Math.abs(a[2] * a[3] * 4); } });
          hookMethod(p, "fillText", { name: pre + "fillText", time: true });
          hookMethod(p, "measureText", { name: pre + "measureText", time: true });
          hookMethod(p, "drawImage", { name: pre + "drawImage", time: true });
        });
        hookMethod(Document.prototype, "createElement", {
          name: "document.createElement",
          onCall: function (a) { if (String(a[0]).toLowerCase() === "canvas") count("canvas elements created"); },
        });
        if (window.OffscreenCanvas) hookConstructor(window, "OffscreenCanvas", { name: "OffscreenCanvas created" });
        hookMethod(HTMLCanvasElement.prototype, "getContext", {
          name: "canvas.getContext",
          onCall: function (a, self) { if (a[1] && a[1].willReadFrequently) count("getContext(willReadFrequently)"); },
        });
      });
    },
    // GPU uploads and object churn, WebGL and WebGPU
    gpu: function () {
      once("gpu", function () {
        var bpp = function (type) { return type === 0x1406 ? 4 : type === 0x1403 || type === 0x140b ? 2 : 1; }; // FLOAT, USHORT, HALF
        var comps = function (format) { return format === 0x1908 || format === 0x8058 ? 4 : format === 0x1907 ? 3 : format === 0x8227 ? 2 : 1; };
        var texBytes = function (a) {
          // texImage2D(target, level, internalformat, width, height, border, format, type, pixels) or (target, level, internalformat, format, type, source)
          if (a.length >= 8 && typeof a[3] === "number" && typeof a[4] === "number") return a[3] * a[4] * comps(a[6]) * bpp(a[7]);
          var src = a[a.length - 1];
          return src && src.width ? src.width * src.height * 4 : 0;
        };
        var subBytes = function (a) {
          // texSubImage2D(target, level, x, y, width, height, format, type, pixels) or (target, level, x, y, format, type, source)
          if (a.length >= 9 && typeof a[4] === "number" && typeof a[5] === "number") return a[4] * a[5] * comps(a[6]) * bpp(a[7]);
          var src = a[a.length - 1];
          return src && src.width ? src.width * src.height * 4 : 0;
        };
        [window.WebGLRenderingContext, window.WebGL2RenderingContext].forEach(function (K) {
          if (!K) return;
          var p = K.prototype;
          hookMethod(p, "texImage2D", { name: "gl.texImage2D", bytes: texBytes, onCall: function (a) { if (a.length >= 9 && a[8] == null) count("gl.texImage2D (allocation, no data)", 1, texBytes(a)); } });
          hookMethod(p, "texSubImage2D", { name: "gl.texSubImage2D", bytes: subBytes });
          hookMethod(p, "createTexture", { name: "gl.createTexture" });
          hookMethod(p, "deleteTexture", { name: "gl.deleteTexture" });
          hookMethod(p, "bufferData", { name: "gl.bufferData", bytes: function (a) { return typeof a[1] === "number" ? a[1] : a[1] ? a[1].byteLength : 0; } });
          hookMethod(p, "bufferSubData", { name: "gl.bufferSubData", bytes: function (a) { return a[2] ? a[2].byteLength : 0; } });
          hookMethod(p, "readPixels", { name: "gl.readPixels", time: true, bytes: function (a) { return a[2] * a[3] * 4; } });
          hookMethod(p, "drawArrays", { name: "gl.draw calls" });
          hookMethod(p, "drawElements", { name: "gl.draw calls" });
          if (p.drawArraysInstanced) hookMethod(p, "drawArraysInstanced", { name: "gl.draw calls" });
          if (p.drawElementsInstanced) hookMethod(p, "drawElementsInstanced", { name: "gl.draw calls" });
          hookMethod(p, "compileShader", { name: "gl.compileShader" });
        });
        if (window.GPUQueue) {
          hookMethod(GPUQueue.prototype, "writeTexture", { name: "gpu.writeTexture", bytes: function (a) { var d = a[1]; return d ? d.byteLength || 0 : 0; } });
          hookMethod(GPUQueue.prototype, "writeBuffer", { name: "gpu.writeBuffer", bytes: function (a) { return typeof a[4] === "number" ? a[4] : a[2] ? a[2].byteLength || 0 : 0; } });
          hookMethod(GPUQueue.prototype, "copyExternalImageToTexture", { name: "gpu.copyExternalImageToTexture", bytes: function (a) { var s = a[0] && a[0].source; return s ? s.width * s.height * 4 : 0; } });
          hookMethod(GPUQueue.prototype, "submit", { name: "gpu.submit" });
          hookMethod(GPUDevice.prototype, "createTexture", { name: "gpu.createTexture" });
          hookMethod(GPUDevice.prototype, "createBuffer", { name: "gpu.createBuffer", onCall: function (a) { if (a[0] && a[0].mappedAtCreation) count("gpu.createBuffer (mappedAtCreation)", 1, a[0].size || 0); } });
          if (window.GPUCommandEncoder) hookMethod(GPUCommandEncoder.prototype, "copyTextureToBuffer", { name: "gpu.copyTextureToBuffer", bytes: function (a) { var z = a[2]; return z ? (z.width || z[0] || 0) * (z.height || z[1] || 1) * 4 : 0; } });
          if (window.GPUBuffer) hookMethod(GPUBuffer.prototype, "destroy", { name: "gpu.buffer.destroy" });
          hookMethod(GPUDevice.prototype, "createShaderModule", { name: "gpu.createShaderModule" });
          if (window.GPUTexture) hookMethod(GPUTexture.prototype, "destroy", { name: "gpu.texture.destroy" });
          if (window.GPUBuffer) hookMethod(GPUBuffer.prototype, "mapAsync", { name: "gpu.buffer.mapAsync (readback)" });
        }
      });
    },
    // rAF, timers, MessageChannel
    timers: function () {
      once("timers", function () {
        hookMethod(window, "requestAnimationFrame", { name: "requestAnimationFrame" });
        hookMethod(window, "cancelAnimationFrame", { name: "cancelAnimationFrame" });
        hookMethod(window, "setTimeout", { name: "setTimeout" });
        hookMethod(window, "setInterval", { name: "setInterval" });
        hookConstructor(window, "MessageChannel", { name: "new MessageChannel" });
      });
    },
    // fetch / XHR / WebSocket, with a URL log
    network: function () {
      once("network", function () {
        hookMethod(window, "fetch", { name: "fetch", onCall: function (a) { netLog.push({ t: +now().toFixed(1), kind: "fetch", url: String(a[0] && a[0].url || a[0]) }); } });
        hookMethod(XMLHttpRequest.prototype, "open", { name: "XMLHttpRequest.open", onCall: function (a) { netLog.push({ t: +now().toFixed(1), kind: "xhr", url: String(a[1]) }); } });
        if (window.WebSocket) hookConstructor(window, "WebSocket", { name: "new WebSocket", onNew: function (o, a) { netLog.push({ t: +now().toFixed(1), kind: "ws", url: String(a[0]) }); } });
      });
    },
    // addEventListener with options; live listener count per type
    listeners: function () {
      once("listeners", function () {
        hookMethod(EventTarget.prototype, "addEventListener", {
          name: "addEventListener",
          onCall: function (a, self) {
            var o = a[2], passive = o && typeof o === "object" ? o.passive : undefined;
            var tag = self && self.tagName ? self.tagName.toLowerCase() : self === window ? "window" : self === document ? "document" : "other";
            count("listeners added: " + a[0]);
            if ((a[0] === "wheel" || a[0] === "mousewheel" || a[0] === "touchstart" || a[0] === "touchmove") && passive !== true)
              count("non-passive " + a[0] + " listeners on <" + tag + ">");
          },
        });
        hookMethod(EventTarget.prototype, "removeEventListener", { name: "removeEventListener", onCall: function (a) { count("listeners removed: " + a[0]); } });
      });
    },
    // Intl / Date formatting
    intl: function () {
      once("intl", function () {
        hookConstructor(Intl, "DateTimeFormat", { name: "new Intl.DateTimeFormat", countCalls: true });
        hookConstructor(Intl, "NumberFormat", { name: "new Intl.NumberFormat", countCalls: true });
        ["toLocaleDateString", "toLocaleTimeString", "toLocaleString"].forEach(function (m) { hookMethod(Date.prototype, m, { name: "Date." + m, time: true }); });
        hookMethod(Number.prototype, "toLocaleString", { name: "Number.toLocaleString", time: true });
      });
    },
    // JSON, including reviver invocations
    json: function () {
      once("json", function () {
        hookMethod(JSON, "stringify", { name: "JSON.stringify", time: true });
        var parse = JSON.parse;
        JSON.parse = function (text, reviver) {
          if (!enabled) return parse.apply(JSON, arguments);
          count("JSON.parse");
          if (typeof reviver !== "function") return parse.call(JSON, text);
          return parse.call(JSON, text, function (k, v) { count("JSON.parse reviver calls"); return reviver.call(this, k, v); });
        };
        hooks.push(function () { JSON.parse = parse; });
      });
    },
    // SciChart EventHandler subscriptions (live = subscribe - unsubscribe)
    sciEvents: function () {
      once("sciEvents", function () {
        var EH = api.SciChart && api.SciChart.EventHandler;
        if (!EH) return;
        hookMethod(EH.prototype, "subscribe", { name: "EventHandler.subscribe" });
        hookMethod(EH.prototype, "unsubscribe", { name: "EventHandler.unsubscribe" });
      });
    },
  };
  var netLog = [];

  // ---------------------------------------------------------------- native (embind) objects
  // Every embind handle is created by Object.create(proto, { $$: record }) and freed by
  // ClassHandle.prototype.delete(). Counting both per class gives created/deleted/live.
  var nativeOn = false;
  var nativeCreated = Object.create(null), nativeDeleted = Object.create(null);
  Object.create = function (proto, props) {
    var o = ObjectCreate.call(Object, proto, props);
    if (nativeOn && props && props.$$ && props.$$.value && props.$$.value.ptrType) {
      var n = props.$$.value.ptrType.registeredClass.name;
      nativeCreated[n] = (nativeCreated[n] || 0) + 1;
    }
    return o;
  };
  var deleteHooked = false;
  function hookNativeDelete(wasmContext) {
    if (deleteHooked || !wasmContext || !wasmContext.SCRTDoubleVector) return;
    var p = wasmContext.SCRTDoubleVector.prototype;
    while (p && !Object.prototype.hasOwnProperty.call(p, "delete")) p = Object.getPrototypeOf(p);
    if (!p) return;
    var del = p.delete;
    p.delete = function () {
      if (nativeOn && this.$$ && this.$$.ptrType) {
        var n = this.$$.ptrType.registeredClass.name;
        nativeDeleted[n] = (nativeDeleted[n] || 0) + 1;
      }
      return del.call(this);
    };
    deleteHooked = true;
  }
  var native = {
    start: function () { nativeOn = true; },
    stop: function () { nativeOn = false; },
    reset: function () { nativeCreated = Object.create(null); nativeDeleted = Object.create(null); },
    // { ClassName: { created, deleted, live } }
    snapshot: function () {
      var o = {};
      Object.keys(nativeCreated).concat(Object.keys(nativeDeleted)).forEach(function (n) {
        var c = nativeCreated[n] || 0, d = nativeDeleted[n] || 0;
        o[n] = { created: c, deleted: d, live: c - d };
      });
      return o;
    },
  };

  // Count calls into wasm: "Class.method" (prototype), "Class::staticMethod" or "functionName" (module level)
  function watchEmbind(wasmContext, specs) {
    var undos = specs.map(function (s) {
      var m;
      if ((m = /^(\w+)\.(\w+)$/.exec(s))) {
        var K = wasmContext[m[1]];
        return K && K.prototype ? hookMethod(K.prototype, m[2], { name: "wasm " + s }) : function () {};
      } else if ((m = /^(\w+)::(\w+)$/.exec(s))) {
        return wasmContext[m[1]] ? hookMethod(wasmContext[m[1]], m[2], { name: "wasm " + s }) : function () {};
      }
      return hookMethod(wasmContext, s, { name: "wasm " + s });
    });
    return function () { undos.forEach(function (u) { u(); }); };
  }

  // ---------------------------------------------------------------- frames, pointer, timing
  function nextFrame() { return new Promise(function (r) { raf(r); }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout0(r, ms); }); }
  async function idleFrames(n) { for (var i = 0; i < n; i++) await nextFrame(); }

  // Run `n` frames. perFrame(i) runs at the start of each frame (e.g. dispatch a pointer move,
  // append data). Returns counter deltas over the run, per-frame averages and frame intervals.
  async function frames(n, perFrame) {
    await nextFrame();
    var s0 = snap(), stamps = [], t0 = now();
    for (var i = 0; i < n; i++) {
      var ts = await nextFrame();
      stamps.push(ts);
      if (perFrame) await perFrame(i);
    }
    await nextFrame(); // let the last frame render
    var d = diff(s0, snap());
    var intervals = [];
    for (var j = 1; j < stamps.length; j++) intervals.push(stamps[j] - stamps[j - 1]);
    intervals.sort(function (a, b) { return a - b; });
    return {
      frames: n, ms: now() - t0, delta: d,
      perFrame: function (name, field) { return get(d, name, field) / n; },
      total: function (name, field) { return get(d, name, field); },
      frameP50: intervals.length ? intervals[Math.floor(intervals.length * 0.5)] : 0,
      frameP95: intervals.length ? intervals[Math.floor(intervals.length * 0.95)] : 0,
    };
  }

  // Measure counter deltas around an async action.
  async function during(fn) {
    var s0 = snap(), t0 = now();
    var ret = await fn();
    var d = diff(s0, snap());
    return { ms: now() - t0, delta: d, ret: ret, total: function (name, field) { return get(d, name, field); } };
  }

  // Synthetic pointer input on a SciChart surface (events go to the element MouseManager listens on).
  // SciChart reads event.offsetX/offsetY. Browsers compute those for synthetic events from the
  // current layout, which is wrong under page scaling (device emulation, some embedded views),
  // so by default each event carries its intended offsets as own properties. Pass
  // { realOffsets: true } to keep the browser's getter (needed when offsetX itself is measured).
  function pointerTarget(surface) { return (surface.mouseManager && surface.mouseManager.canvas) || surface.domCanvas2D; }
  function makePointer(surface, popts) {
    popts = popts || {};
    var el = pointerTarget(surface);
    var wasEnabled = enabled; enabled = false;
    var r = el.getBoundingClientRect(); // read once, before any measurement
    enabled = wasEnabled;
    var fire = function (type, fx, fy, extra) {
      var init = Object.assign({ bubbles: true, cancelable: true, composed: true, clientX: r.left + fx * r.width, clientY: r.top + fy * r.height,
        pointerId: 1, pointerType: "mouse", isPrimary: true, button: -1, buttons: 0 }, extra || {});
      var E = type.indexOf("pointer") === 0 ? PointerEvent : type === "wheel" ? WheelEvent : MouseEvent;
      var ev = new E(type, init);
      if (!popts.realOffsets) {
        Object.defineProperty(ev, "offsetX", { value: fx * r.width });
        Object.defineProperty(ev, "offsetY", { value: fy * r.height });
      }
      el.dispatchEvent(ev);
    };
    return {
      element: el, rect: r,
      enter: function (fx, fy) { fire("pointerover", fx, fy); fire("pointerenter", fx, fy); fire("mouseenter", fx, fy); fire("pointermove", fx, fy); },
      move: function (fx, fy, extra) { fire("pointermove", fx, fy, extra); },
      leave: function () { fire("pointerout", 1.2, 1.2); fire("pointerleave", 1.2, 1.2); fire("mouseleave", 1.2, 1.2); },
      down: function (fx, fy) { fire("pointerdown", fx, fy, { button: 0, buttons: 1 }); },
      up: function (fx, fy) { fire("pointerup", fx, fy, { button: 0, buttons: 0 }); },
      wheel: function (fx, fy, dy) { fire("wheel", fx, fy, { deltaY: dy, deltaMode: 0 }); },
      // fraction along a left-right sweep for frame i of n
      sweepX: function (i, n) { var k = (i % n) / n; return 0.1 + 0.8 * (k < 0.5 ? k * 2 : 2 - k * 2); },
    };
  }

  // Long animation frames (Chrome): count and forced style+layout time inside them.
  var loaf = { count: 0, blocking: 0, forcedLayout: 0 };
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) {
        loaf.count++; loaf.blocking += e.blockingDuration || 0;
        (e.scripts || []).forEach(function (s) { loaf.forcedLayout += s.forcedStyleAndLayoutDuration || 0; });
      });
    }).observe({ type: "long-animation-frame", buffered: false });
  } catch (e) { /* not supported */ }

  function memory(wasmContext) {
    return {
      jsHeapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
      wasmMemoryMB: wasmContext && wasmContext.HEAPU8 ? +(wasmContext.HEAPU8.buffer.byteLength / 1048576).toFixed(1) : null,
      domNodes: document.getElementsByTagName("*").length,
      canvases: document.getElementsByTagName("canvas").length,
    };
  }

  // ---------------------------------------------------------------- page chrome and report
  var meta = {}, el = {}, startedAt = 0;
  function h(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { if (k === "text") e.textContent = attrs[k]; else if (k === "html") e.innerHTML = attrs[k]; else e.setAttribute(k, attrs[k]); });
    (children || []).forEach(function (c) { e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function getRenderer() { try { return localStorage.getItem(RENDERER_KEY) || "auto"; } catch (e) { return "auto"; } }
  function setRendererFlag(choice) {
    try {
      if (choice === "webgl") localStorage.setItem("IS_WEB_GPU", "0");
      else if (choice === "webgpu") localStorage.setItem("IS_WEB_GPU", "1");
      else localStorage.removeItem("IS_WEB_GPU");
    } catch (e) { /* storage blocked: SciChart uses its default */ }
  }
  function buildChrome() {
    enabled = false;
    var root = document.getElementById("probe-root") || document.body.insertBefore(h("div", { id: "probe-root" }), document.body.firstChild);
    var sel = h("select", { id: "probe-renderer", title: "Renderer (reloads the page)" }, ["auto", "webgl", "webgpu"].map(function (v) {
      var o = h("option", { value: v, text: v === "auto" ? "Renderer: auto (SciChart default)" : v === "webgl" ? "Renderer: WebGL" : "Renderer: WebGPU" });
      if (v === getRenderer()) o.selected = true;
      return o;
    }));
    sel.addEventListener("change", function () { try { localStorage.setItem(RENDERER_KEY, sel.value); } catch (e) { /* ignore */ } location.reload(); });
    var rerun = h("button", { type: "button", text: "Run again" });
    rerun.addEventListener("click", function () { location.reload(); });
    root.appendChild(h("header", { class: "probe-header" }, [
      h("div", { class: "probe-kicker", text: "SciChart.js " + SCICHART_VERSION + " · performance issue " + meta.id + (meta.severity ? " · " + meta.severity : "") }),
      h("h1", { text: meta.title }),
      h("p", { class: "probe-claim", text: meta.claim || "" }),
      h("div", { class: "probe-links" }, [
        h("a", { href: REPO_URL + meta.issue, target: "_blank", rel: "noopener", text: "Issue write-up" }),
        sel, rerun,
      ]),
    ]));
    el.status = root.appendChild(h("div", { class: "probe-status", text: "Loading SciChart " + SCICHART_VERSION + "…" }));
    var results = document.getElementById("probe-results") || document.body.appendChild(h("div", { id: "probe-results" }));
    el.report = results.appendChild(h("section", { class: "probe-report" }));
    el.log = h("ol", { class: "probe-log" });
    results.appendChild(h("details", { class: "probe-method" }, [h("summary", { text: "How this is measured" }), h("div", { class: "probe-method-body", html: meta.method || "" }), el.log]));
    el.env = results.appendChild(h("div", { class: "probe-env" }));
    enabled = true;
  }
  function status(text) { enabled = false; if (el.status) el.status.textContent = text; enabled = true; }
  function log(text) { enabled = false; if (el.log) el.log.appendChild(h("li", { text: text })); enabled = true; }

  function fmt(v) {
    if (v == null) return "–";
    if (typeof v === "number") return Math.abs(v) >= 100 || Number.isInteger(v) ? Math.round(v).toLocaleString("en-US") : v.toFixed(Math.abs(v) < 1 ? 3 : 2);
    return String(v);
  }
  // report({ verdict: "reproduced" | "not-reproduced" | "inconclusive", headline, columns, rows: [[label, ...values]], notes, metrics })
  function report(r) {
    enabled = false;
    var verdictText = { "reproduced": "Issue reproduced", "not-reproduced": "Not reproduced", "inconclusive": "Inconclusive", "error": "Demo error" }[r.verdict] || r.verdict;
    el.report.innerHTML = "";
    el.report.appendChild(h("div", { class: "probe-verdict probe-" + r.verdict }, [h("strong", { text: verdictText }), h("span", { text: r.headline || "" })]));
    if (r.rows && r.rows.length) {
      var thead = h("tr", null, [h("th", { text: "Measured" })].concat((r.columns || []).map(function (c) { return h("th", { text: c }); })));
      var body = r.rows.map(function (row) {
        return h("tr", null, row.map(function (v, i) { return h(i ? "td" : "th", { text: i ? fmt(v) : String(v), scope: i ? null : "row" }); }));
      });
      el.report.appendChild(h("div", { class: "probe-table-wrap" }, [h("table", null, [h("thead", null, [thead]), h("tbody", null, body)])]));
    }
    (r.notes || []).forEach(function (n) { el.report.appendChild(h("p", { class: "probe-note", text: n })); });
    if (rendererInfo === "renderer unknown" && api.SciChart) {
      var log0 = console.log, info0 = console.info;
      try {
        console.log = console.info = function () {};
        rendererInfo = (api.SciChart.SciChartSurface.debugWasmWebGPU().webGpu ? "WebGPU" : "WebGL") + " (configured)";
      } catch (e) { /* ignore */ } finally { console.log = log0; console.info = info0; }
    }
    var env = environment();
    el.env.textContent = [env.scichart, env.renderer, "DPR " + env.dpr, env.ua].join(" · ");
    status("Done in " + ((now() - startedAt) / 1000).toFixed(1) + " s.");
    enabled = true;
    window.__demoResult = { id: meta.id, verdict: r.verdict, headline: r.headline, columns: r.columns, rows: r.rows, notes: r.notes, metrics: r.metrics || null, env: env, log: Array.prototype.map.call(el.log.children, function (li) { return li.textContent; }) };
  }

  var rendererInfo = "renderer unknown";
  function environment() {
    return { scichart: "SciChart.js " + SCICHART_VERSION, renderer: rendererInfo, dpr: window.devicePixelRatio, ua: navigator.userAgent, rendererChoice: getRenderer() };
  }

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = src; s.async = false; s.crossOrigin = "anonymous";
      s.onload = res; s.onerror = function () { rej(new Error("Could not load " + src)); };
      document.head.appendChild(s);
    });
  }

  // Create a 2D surface and remember its wasm context (used by the native-object hooks).
  async function createSurface(div, options, single) {
    var S = api.SciChart.SciChartSurface;
    var r = await (single ? S.createSingle(div, options) : S.create(div, options));
    hookNativeDelete(r.wasmContext);
    track(r.sciChartSurface);
    if (rendererInfo === "renderer unknown") {
      try { rendererInfo = S.debugWasmWebGPU().webGpu ? "WebGPU" : "WebGL"; } catch (e) { /* ignore */ }
    }
    return r;
  }

  // Surfaces made through the helpers, for console debugging (Probe.surfaces). Weak references, so
  // the harness never keeps a deleted surface (or its canvas) alive.
  var surfaceRefs = [];
  function track(surface) { surfaceRefs.push(window.WeakRef ? new WeakRef(surface) : { deref: function () { return surface; } }); }
  function liveSurfaces() {
    return surfaceRefs.map(function (r) { return r.deref(); }).filter(function (s) { return s && !s.isDeleted; });
  }

  // 3D surface: { sciChart3DSurface, wasmContext }
  async function createSurface3D(div, options, single) {
    var S = api.SciChart.SciChart3DSurface;
    var r = await (single ? S.createSingle(div, options) : S.create(div, options));
    hookNativeDelete(r.wasmContext);
    track(r.sciChart3DSurface);
    if (rendererInfo === "renderer unknown") {
      try { rendererInfo = api.SciChart.SciChartSurface.debugWasmWebGPU().webGpu ? "WebGPU" : "WebGL"; } catch (e) { /* ignore */ }
    }
    return r;
  }
  // Pie surface (DOM based): returns the SciChartPieSurface
  async function createPie(div, options) {
    var pie = await api.SciChart.SciChartPieSurface.create(div, options);
    track(pie);
    return pie;
  }
  // Force a garbage collection when the browser allows it (headless runs pass --js-flags=--expose-gc).
  async function gc() {
    if (typeof window.gc !== "function") return false;
    window.gc(); await sleep(50); window.gc();
    return true;
  }

  // ---------------------------------------------------------------- boot
  async function boot(demoMeta, demoFn) {
    meta = demoMeta || {};
    startedAt = now();
    buildChrome();
    setRendererFlag(getRenderer());
    try {
      if (meta.beforeLoad) await meta.beforeLoad(api);
      await loadScript(SCICHART_URL);
      api.SciChart = window.SciChart;
      api.SciChart.SciChartSurface.loadWasmFromCDN();
      if (meta.communityLicense !== false) api.SciChart.SciChartSurface.UseCommunityLicense();
      if (api.SciChart.SciChartDefaults) api.SciChart.SciChartDefaults.performanceWarnings = false;
      status("Running…");
      await demoFn(api);
      if (!window.__demoResult) report({ verdict: "inconclusive", headline: "The demo finished without a report." });
    } catch (e) {
      console.error(e);
      report({ verdict: "error", headline: String(e && e.message || e), notes: [String(e && e.stack || "")] });
    }
  }

  var api = {
    SciChart: null,
    get surfaces() { return liveSurfaces(); },
    boot: boot,
    // counters
    hookMethod: hookMethod, hookAccessor: hookAccessor, hookConstructor: hookConstructor,
    count: count, snap: snap, diff: diff, get: get, watch: watch, watchEmbind: watchEmbind, native: native, netLog: netLog,
    // flow
    frames: frames, during: during, nextFrame: nextFrame, idleFrames: idleFrames, sleep: sleep, now: now,
    pointer: makePointer, createSurface: createSurface, createSurface3D: createSurface3D, createPie: createPie, gc: gc, memory: memory, loaf: loaf,
    renderer: function () { return rendererInfo; },
    // output
    report: report, log: log, status: status,
    // harness DOM work must not be counted
    quiet: function (fn) { var w = enabled; enabled = false; try { return fn(); } finally { enabled = w; } },
  };
  window.Probe = api; // console access (the fiddle wraps this script in a function)
  return api;
})();
