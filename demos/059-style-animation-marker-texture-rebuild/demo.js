const META = {
  id: "059",
  title: "Point-marker style animations rebuild 3 canvases and 3 GPU textures per series on every frame",
  issue: "issues/059-style-animation-rebuilds-marker-textures-per-frame.md",
  severity: "medium",
  claim: "A style animation with styles.pointMarker sets the marker's size and colours every frame between suspendUpdates() and resumeUpdates(), and BasePointMarker.resumeUpdates rebuilds the sprite unconditionally: it deletes the 3 CanvasTextures and creates 3 new ones, each with a new canvas, two wasm UIntVectors, a native texture, a raster pass, a getImageData copy and a per-pixel embind swizzle, even when consecutive frames give the same pixel size.",
  method: "<p>10 XyScatterRenderableSeries (100 points each, 4 px EllipsePointMarker) run a ScatterAnimation whose <code>styles.pointMarker</code> grows the marker to 16 px over 1.5 s (same colours). Counted from <code>runAnimation()</code> until every series reports the animation finished: animation updates per series (<code>SeriesAnimation.updateSeriesProperties</code>), sprite rebuilds (<code>BasePointMarker.createCanvasTexture</code>, 3 CanvasTextures each), canvas elements created, <code>getImageData</code> calls and bytes, native <code>UIntVector</code> and <code>TSRTexture</code> handles created, wasm <code>UIntVector.set</code> and <code>SCRTFillTextureAbgr</code> calls, and GPU textures created.</p><p>A/B: the issue's library fix applied at runtime on <code>BasePointMarker.prototype</code> (rebuild in resumeUpdates only if a notified property changed while suspended; repaint the existing canvases and textures when the device-pixel size is unchanged) and on <code>SeriesAnimation.prototype.updateSeriesProperties</code> (intermediate sizes snapped to whole device pixels). The markers are reset to 4 px between the two runs.</p>",
};

async function demo(P) {
  const { NumericAxis, NumberRange, XyScatterRenderableSeries, XyDataSeries, EllipsePointMarker, ScatterAnimation, EPointMarkerType, DpiHelper } = P.SciChart;
  const SERIES = 10, POINTS = 100, DURATION = 1500, FROM = 4, TO = 16;
  const COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"];
  // Not exported by name: reach them through exported subclasses.
  const BasePointMarker = Object.getPrototypeOf(EllipsePointMarker.prototype).constructor;
  const SeriesAnimationProto = Object.getPrototypeOf(ScatterAnimation.prototype);

  const { sciChartSurface, wasmContext } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasmContext, { visibleRange: new NumberRange(-2, POINTS + 2) }));
  sciChartSurface.yAxes.add(new NumericAxis(wasmContext, { visibleRange: new NumberRange(-1, SERIES) }));
  const marker = (s) => new EllipsePointMarker(wasmContext, { width: FROM, height: FROM, fill: COLORS[s], stroke: COLORS[s], strokeThickness: 1 });
  const series = [];
  for (let s = 0; s < SERIES; s++) {
    const xs = Array.from({ length: POINTS }, (_, i) => i);
    series.push(new XyScatterRenderableSeries(wasmContext, {
      dataSeries: new XyDataSeries(wasmContext, { xValues: xs, yValues: xs.map((x) => s + 0.3 * Math.sin(x / 6 + s)), isSorted: true, containsNaN: false }),
      pointMarker: marker(s),
    }));
    sciChartSurface.renderableSeries.add(series[s]);
  }
  await P.sleep(600);

  // ---- counters
  P.watch.canvas2d();
  P.watch.gpu();
  P.watchEmbind(wasmContext, ["UIntVector.set", "SCRTFillTextureAbgr"]);
  P.hookMethod(SeriesAnimationProto, "updateSeriesProperties", { name: "animation updates (per series)", time: true });
  const sizes = new Set();
  P.hookMethod(BasePointMarker.prototype, "createCanvasTexture", {
    name: "sprite rebuilds (createCanvasTexture)",
    onCall: (args, self) => sizes.add(Math.floor(DpiHelper.PIXEL_RATIO * (self.width + self.strokeThickness) + 1)),
  });

  async function animate(label) {
    await P.idleFrames(5);
    sizes.clear();
    P.native.reset();
    P.native.start();
    const r = await P.during(async () => {
      series.forEach((rs, s) => rs.runAnimation(new ScatterAnimation({
        duration: DURATION,
        styles: { pointMarker: { type: EPointMarkerType.Ellipse, width: TO, height: TO, fill: COLORS[s], stroke: COLORS[s], strokeThickness: 1 } },
      })));
      const t0 = P.now();
      await P.nextFrame();
      while (series.some((rs) => rs.isRunningAnimation) && P.now() - t0 < DURATION * 4) await P.nextFrame();
    });
    P.native.stop();
    const nat = P.native.snapshot();
    const created = (k) => (nat[k] ? nat[k].created : 0);
    const updates = r.total("animation updates (per series)");
    const per = (v) => v / Math.max(1, updates);
    const res = {
      updates, framesPerSeries: updates / SERIES, ms: r.ms,
      updateMsPerFrame: r.total("animation updates (per series)", "t") / Math.max(1, updates / SERIES),
      rebuilds: r.total("sprite rebuilds (createCanvasTexture)"),
      canvases: r.total("canvas elements created"),
      getImageData: r.total("2d.getImageData"), getImageDataBytes: r.total("2d.getImageData", "bytes"),
      uintVectors: created("UIntVector"), tsrTextures: created("TSRTexture"),
      set: r.total("wasm UIntVector.set"), fill: r.total("wasm SCRTFillTextureAbgr"),
      gpuTextures: r.total("gl.createTexture") + r.total("gpu.createTexture"),
      uploads: r.total("gl.texImage2D") + r.total("gl.texSubImage2D") + r.total("gpu.writeTexture"),
      distinctSizes: sizes.size,
      finalWidth: series[0].pointMarker.width,
    };
    res.per = per;
    P.log(`${label}: ${JSON.stringify({ ...res, per: undefined })}`);
    return res;
  }

  P.status("Style animation on 10 series, library as shipped…");
  const shipped = await animate("as shipped");

  // Reset to fresh 4 px markers (the app deletes the markers it replaces).
  series.forEach((rs, s) => { const old = rs.pointMarker; rs.pointMarker = marker(s); old.delete(); });
  await P.idleFrames(10);

  // ---- the issue's fix (BasePointMarker.js:328-362 and SeriesAnimation.js:152-153), applied on the prototypes
  const BPM = BasePointMarker.prototype;
  const original = { resumeUpdates: BPM.resumeUpdates, notifyPropertyChanged: BPM.notifyPropertyChanged, recreateSpriteTextures: BPM.recreateSpriteTextures, updateSeriesProperties: SeriesAnimationProto.updateSeriesProperties };
  const widthDesc = Object.getOwnPropertyDescriptor(BPM, "width"), heightDesc = Object.getOwnPropertyDescriptor(BPM, "height");
  const stockCreate = BPM.createCanvasTexture; // the fix keeps the delete-and-create path for subclasses that override it
  function paintCanvasTextures(t) { // the same three drawSprite calls as createCanvasTexture, into the existing CanvasTextures
    const r = DpiHelper.PIXEL_RATIO, w = this.width * r, h = this.height * r, st = this.strokeThickness * r;
    t.spriteTexture.clear(); this.drawSprite(t.spriteTexture.getContext(), w, h, this.stroke, st, this.fill); t.spriteTexture.copyTexture();
    t.strokeMask.clear(); this.drawSprite(t.strokeMask.getContext(), w, h, "#ffffffff", st, "#00000000"); t.strokeMask.copyTexture();
    t.fillMask.clear(); this.drawSprite(t.fillMask.getContext(), w, h, "#00000000", st, "#ffffffff"); t.fillMask.copyTexture();
  }
  let repaints = 0;
  const changedProps = {}, fillSamples = [];
  BPM.resumeUpdates = function () {
    this.isUpdateSuspended = false;
    if (this.changedWhileSuspended) { this.changedWhileSuspended = false; this.recreateSpriteTextures(); }
  };
  BPM.notifyPropertyChanged = function (propertyName, newValue, oldValue) {
    if (newValue === oldValue || propertyName === "opacity") return;
    changedProps[propertyName] = (changedProps[propertyName] || 0) + 1;
    if (propertyName === "fill" && fillSamples.length < 6 && oldValue !== "#5555FF") fillSamples.push(`${oldValue} -> ${newValue}`);
    if (this.isUpdateSuspended) this.changedWhileSuspended = true; else this.recreateSpriteTextures();
  };
  BPM.recreateSpriteTextures = function () {
    const r = DpiHelper.PIXEL_RATIO;
    const w = Math.floor(r * (this.width + this.strokeThickness) + 1), h = Math.floor(r * (this.height + this.strokeThickness) + 1);
    const t = this.spriteTextures;
    if (t && t.spriteTexture && t.spriteTexture.width === w && t.spriteTexture.height === h && this.createCanvasTexture === stockCreate) {
      paintCanvasTextures.call(this, t);
      repaints++;
      if (this.invalidateParentCallback) this.invalidateParentCallback();
      return;
    }
    original.recreateSpriteTextures.call(this); // delete the 3 textures, create new ones, invalidate
  };
  let snapping = false;
  const snapDesc = (d) => ({ configurable: true, enumerable: d.enumerable, get: d.get, set(v) { d.set.call(this, snapping ? Math.round(v * DpiHelper.PIXEL_RATIO) / DpiHelper.PIXEL_RATIO : v); } });
  Object.defineProperty(BPM, "width", snapDesc(widthDesc));
  Object.defineProperty(BPM, "height", snapDesc(heightDesc));
  SeriesAnimationProto.updateSeriesProperties = function (rs, initialStyles, progress) {
    const p = this.reverse ? 1 - progress : progress;
    snapping = !!(this.styles && this.styles.pointMarker) && p > 0 && p < 1; // the end frames stay exact
    try { return original.updateSeriesProperties.apply(this, arguments); } finally { snapping = false; }
  };

  P.status("Style animation on 10 series, with the fix…");
  const fixed = await animate("with fix");
  fixed.repaints = repaints;
  P.log(`with fix, property changes that reached notifyPropertyChanged: ${JSON.stringify(changedProps)}; first fill changes: ${fillSamples.join(", ")}`);

  // restore
  Object.assign(BPM, { resumeUpdates: original.resumeUpdates, notifyPropertyChanged: original.notifyPropertyChanged, recreateSpriteTextures: original.recreateSpriteTextures });
  Object.defineProperty(BPM, "width", widthDesc);
  Object.defineProperty(BPM, "height", heightDesc);
  SeriesAnimationProto.updateSeriesProperties = original.updateSeriesProperties;

  const valid = shipped.updates >= SERIES * 10 && shipped.finalWidth === TO;
  const rebuildsPerUpdate = shipped.per(shipped.rebuilds);
  const reproduced = valid && rebuildsPerUpdate >= 0.9 && shipped.per(shipped.canvases) >= 2.7 && shipped.per(shipped.getImageData) >= 2.7 &&
    fixed.rebuilds <= SERIES * (fixed.distinctSizes + 2) && fixed.finalWidth === TO;
  P.report({
    verdict: !valid ? "inconclusive" : reproduced ? "reproduced" : "not-reproduced",
    headline: !valid
      ? `The animation did not run as intended (${shipped.updates} updates, final marker width ${shipped.finalWidth}).`
      : reproduced
        ? `Each series rebuilds its marker sprite on ${(rebuildsPerUpdate * 100).toFixed(0)}% of animation frames: ${shipped.canvases.toLocaleString("en-US")} canvases, ${shipped.gpuTextures.toLocaleString("en-US")} GPU textures and ${shipped.getImageData.toLocaleString("en-US")} getImageData calls in ${(DURATION / 1000).toFixed(1)} s for ${SERIES} series. With the fix: ${fixed.canvases} canvases (${fixed.distinctSizes} distinct sprite sizes).`
        : `Expected one sprite rebuild (3 canvases) per series per animation frame; measured ${rebuildsPerUpdate.toFixed(2)} rebuilds and ${shipped.per(shipped.canvases).toFixed(2)} canvases per update; fix: ${fixed.rebuilds} rebuilds for ${fixed.distinctSizes} sizes.`,
    columns: ["As shipped", "With fix"],
    rows: [
      ["Animation updates (series x frames)", shipped.updates, fixed.updates],
      ["Sprite rebuilds (3 CanvasTextures each)", shipped.rebuilds, fixed.rebuilds],
      ["  per series per animation frame", rebuildsPerUpdate, fixed.per(fixed.rebuilds)],
      ["Distinct sprite sizes (device pixels)", shipped.distinctSizes, fixed.distinctSizes],
      ["Canvas elements created", shipped.canvases, fixed.canvases],
      ["getImageData calls", shipped.getImageData, fixed.getImageData],
      ["getImageData bytes read back", shipped.getImageDataBytes, fixed.getImageDataBytes],
      ["Native UIntVector handles created", shipped.uintVectors, fixed.uintVectors],
      ["Native TSRTexture handles created", shipped.tsrTextures, fixed.tsrTextures],
      ["GPU textures created", shipped.gpuTextures, fixed.gpuTextures],
      ["wasm UIntVector.set calls (per-pixel swizzle)", shipped.set, fixed.set],
      ["wasm SCRTFillTextureAbgr calls (texture uploads)", shipped.fill, fixed.fill],
      ["Time in updateSeriesProperties (incl. rebuilds) per frame, all series, ms", shipped.updateMsPerFrame, fixed.updateMsPerFrame],
    ],
    notes: [
      `With the fix, new textures are built only when the snapped device-pixel size changes; other changes repaint the existing canvases and textures (${fixed.repaints} repaints here). Those repaints come from fill/stroke: although the start and end colours are equal, the interpolated colour string changed ${changedProps.fill || 0} times (ARGB interpolation rounding and string format). Final marker width: ${shipped.finalWidth} px as shipped, ${fixed.finalWidth} px with the fix.`,
      `DPR ${window.devicePixelRatio}: sprite size is floor(DPR x (width + strokeThickness) + 1) pixels, so a ${FROM} to ${TO} px animation spans about ${Math.floor(window.devicePixelRatio * (TO + 1) + 1) - Math.floor(window.devicePixelRatio * (FROM + 1) + 1) + 1} sizes; higher DPR means more sizes and more pixels per rebuild.`,
      "Counts do not depend on hardware (the number of animation frames depends on the frame rate, so rows are also given per update). Each style animation also replaces the series' marker without deleting the old one (issue 033); that is not counted here.",
    ],
    metrics: { shipped: { ...shipped, per: undefined }, fixed: { ...fixed, per: undefined }, series: SERIES, durationMs: DURATION },
  });
}
