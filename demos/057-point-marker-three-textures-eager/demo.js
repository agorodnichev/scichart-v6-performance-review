const META = {
  id: "057",
  title: "Every point-marker property change rebuilds three canvas textures at once",
  issue: "issues/057-point-marker-rebuilds-three-textures-eagerly.md",
  severity: "medium",
  claim: "BasePointMarker.notifyPropertyChanged() and resumeUpdates() call recreateSpriteTextures() straight away, which builds three CanvasTextures (sprite, stroke mask, fill mask): three canvases, three getImageData readbacks and three uploads. N setters cost N rebuilds, and the two masks are only read when the series has a point-marker palette provider.",
  method: "<p>An XyScatterRenderableSeries (1,000 points, EllipsePointMarker, no palette provider). Three scenarios: (1) fill, stroke and width set in one task, then one frame to draw, repeated 20 times; (2) a ScatterAnimation that animates the point-marker style for 800 ms (it suspends updates, runs five setters and resumes on each animation frame); (3) constructing a SpritePointMarker from a 24 x 24 image. The demo counts CanvasTexture builds (CanvasTexture.copyTexture), canvas elements created, getImageData readbacks and SCRTFillTextureAbgr uploads.</p><p>A/B: the issue's fix applied to BasePointMarker.prototype: a property change only invalidates the cache and asks for a redraw, resumeUpdates only asks for a redraw, the next draw builds the sprite, and the masks are built on first use. Its sprite uses window.devicePixelRatio as the library's DpiHelper does by default; the demo checks that the sprite size matches the library's.</p>",
};

async function demo(P) {
  const S = P.SciChart;
  const { NumericAxis, NumberRange, XyDataSeries, XyScatterRenderableSeries, EllipsePointMarker, SpritePointMarker, ScatterAnimation, EPointMarkerType, CanvasTexture } = S;
  const TASKS = 20;

  const { sciChartSurface, wasmContext: wasm } = await P.createSurface("chart");
  sciChartSurface.xAxes.add(new NumericAxis(wasm, { visibleRange: new NumberRange(0, 1000) }));
  sciChartSurface.yAxes.add(new NumericAxis(wasm, { visibleRange: new NumberRange(-1.5, 1.5) }));
  const xs = Array.from({ length: 1000 }, (_, i) => i);
  const marker = new EllipsePointMarker(wasm, { width: 9, height: 9, strokeThickness: 1, fill: "#4e79a7", stroke: "#1d2b64" });
  const scatter = new XyScatterRenderableSeries(wasm, {
    dataSeries: new XyDataSeries(wasm, { xValues: xs, yValues: xs.map((x) => Math.sin(x / 60) + 0.2 * Math.sin(x / 7)), isSorted: true, containsNaN: false }),
    pointMarker: marker,
  });
  sciChartSurface.renderableSeries.add(scatter);
  // A small image for the sprite marker scenario.
  const img = await new Promise((resolve) => {
    const c = document.createElement("canvas"); c.width = c.height = 24;
    const g = c.getContext("2d"); g.fillStyle = "#e15759"; g.beginPath(); g.arc(12, 12, 10, 0, Math.PI * 2); g.fill();
    const im = new Image(); im.onload = () => resolve(im); im.src = c.toDataURL();
  });
  await P.sleep(600);

  P.watch.canvas2d();
  P.hookMethod(CanvasTexture.prototype, "copyTexture", { name: "CanvasTexture builds" });
  const fillAbgr = wasm.SCRTFillTextureAbgr;
  wasm.SCRTFillTextureAbgr = function () { P.count("SCRTFillTextureAbgr uploads"); return fillAbgr.apply(this, arguments); };
  const animProto = Object.getPrototypeOf(ScatterAnimation.prototype); // SeriesAnimation (not exported)
  P.hookMethod(animProto, "updateSeriesProperties", { name: "animation frames" });

  // The issue's fix, as prototype patches on BasePointMarker (not exported: take it from the chain).
  const bpm = Object.getPrototypeOf(EllipsePointMarker.prototype);
  const shipped = {};
  ["notifyPropertyChanged", "resumeUpdates", "createCanvasTexture", "getStrokeMask", "getFillMask"].forEach((k) => { shipped[k] = bpm[k]; });
  const dpr = () => window.devicePixelRatio || 1;
  function maskTexture(self, stroke, fill) {
    const r = dpr();
    const t = new CanvasTexture(self.webAssemblyContext, r * (self.width + self.strokeThickness) + 1, r * (self.height + self.strokeThickness) + 1);
    t.clear();
    self.drawSprite(t.getContext(), self.width * r, self.height * r, stroke, self.strokeThickness * r, fill);
    t.copyTexture();
    return t;
  }
  const fix = {
    notifyPropertyChanged(name, newValue, oldValue) {
      if (newValue === oldValue || name === "opacity") return;
      if (name !== "lastPointOnly" && name !== "antiAlias") this.invalidateCache(); // rebuilt by getSprite() at the next draw
      if (!this.isUpdateSuspended && this.invalidateParentCallback) this.invalidateParentCallback();
    },
    resumeUpdates() {
      this.isUpdateSuspended = false;
      if (this.invalidateParentCallback) this.invalidateParentCallback();
    },
    createCanvasTexture() {
      return { spriteTexture: maskTexture(this, this.stroke, this.fill), strokeMask: undefined, fillMask: undefined };
    },
    getStrokeMask() {
      this.getSprite();
      if (!this.spriteTextures.strokeMask) { this.spriteTextures.strokeMask = maskTexture(this, "#ffffffff", "#00000000"); this.spriteTextures.strokeMask.applyOpacity(this.opacityProperty); }
      return this.spriteTextures.strokeMask;
    },
    getFillMask() {
      this.getSprite();
      if (!this.spriteTextures.fillMask) { this.spriteTextures.fillMask = maskTexture(this, "#00000000", "#ffffffff"); this.spriteTextures.fillMask.applyOpacity(this.opacityProperty); }
      return this.spriteTextures.fillMask;
    },
  };
  const applyFix = (on) => Object.keys(shipped).forEach((k) => { bpm[k] = on ? fix[k] : shipped[k]; });

  // Sanity check: the patched sprite has the library's size.
  const probe = new EllipsePointMarker(wasm, { width: 11, height: 7, strokeThickness: 2 });
  const a = shipped.createCanvasTexture.call(probe), b = fix.createCanvasTexture.call(probe);
  const sameSize = a.spriteTexture.width === b.spriteTexture.width && a.spriteTexture.height === b.spriteTexture.height;
  [a.spriteTexture, a.strokeMask, a.fillMask, b.spriteTexture].forEach((t) => t && t.delete());
  probe.delete();

  const pick = (r) => ({
    textures: r.total("CanvasTexture builds"), canvases: r.total("canvas elements created"),
    readbacks: r.total("2d.getImageData"), readbackKB: r.total("2d.getImageData", "bytes") / 1024, uploads: r.total("SCRTFillTextureAbgr uploads"),
  });
  const per = (o, d) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, d ? v / d : 0]));

  async function threeSetters(label) {
    let flip = false;
    const r = await P.during(async () => {
      for (let i = 0; i < TASKS; i++) {
        flip = !flip;
        marker.fill = flip ? "#f28e2b" : "#4e79a7"; // three setters in one task
        marker.stroke = flip ? "#7a3d00" : "#1d2b64";
        marker.width = flip ? 11 : 9;
        await P.nextFrame();
        await P.nextFrame();
      }
    });
    const res = per(pick(r), TASKS);
    P.log(`${label}, three setters: ${JSON.stringify(res)}`);
    return res;
  }
  async function animate(label, styles) {
    const r = await P.during(async () => {
      scatter.runAnimation(new ScatterAnimation({ duration: 800, styles: { pointMarker: { type: EPointMarkerType.Ellipse, ...styles } } }));
      await P.sleep(1000);
      await P.idleFrames(2);
    });
    const frames = r.total("animation frames");
    const res = { frames, ...per(pick(r), frames) };
    P.log(`${label}, style animation: ${JSON.stringify(res)}`);
    return res;
  }
  async function spriteCtor(label) {
    const r = await P.during(async () => { const m = new SpritePointMarker(wasm, { image: img }); m.delete(); });
    const res = pick(r);
    P.log(`${label}, SpritePointMarker constructor: ${JSON.stringify(res)}`);
    return res;
  }

  P.status("Style changes, library as shipped…");
  const setS = await threeSetters("as shipped");
  const aniS = await animate("as shipped", { width: 18, height: 18, strokeThickness: 2, fill: "#e15759", stroke: "#ffffff" });
  const sprS = await spriteCtor("as shipped");
  P.status("Style changes, with the lazy-texture fix…");
  applyFix(true);
  const setF = await threeSetters("with fix");
  const aniF = await animate("with fix", { width: 9, height: 9, strokeThickness: 1, fill: "#4e79a7", stroke: "#1d2b64" });
  const sprF = await spriteCtor("with fix");
  applyFix(false);
  wasm.SCRTFillTextureAbgr = fillAbgr;

  const reproduced = setS.textures >= 8.5 && setF.textures <= 1.1 && aniS.frames >= 10 && aniS.textures >= 2.7 && aniF.frames >= 10 && aniF.textures <= 1.1;
  P.report({
    verdict: reproduced ? "reproduced" : "not-reproduced",
    headline: reproduced
      ? `Setting fill, stroke and width builds ${setS.textures.toFixed(0)} canvas textures (${setS.readbacks.toFixed(0)} getImageData readbacks); a point-marker style animation builds ${aniS.textures.toFixed(1)} per frame; new SpritePointMarker({ image }) builds ${sprS.textures}. With lazy textures: ${setF.textures.toFixed(0)}, ${aniF.textures.toFixed(1)} and ${sprF.textures}.`
      : `Expected 3 textures per property change; measured ${setS.textures.toFixed(1)} per three-setter change and ${aniS.textures.toFixed(1)} per animation frame (fix: ${setF.textures.toFixed(1)} and ${aniF.textures.toFixed(1)}).`,
    columns: ["As shipped", "With lazy textures (fix)"],
    rows: [
      ["Three setters + next draw: canvas textures built", setS.textures, setF.textures],
      ["  canvas elements created", setS.canvases, setF.canvases],
      ["  getImageData readbacks (KB)", `${setS.readbacks.toFixed(0)} (${setS.readbackKB.toFixed(1)})`, `${setF.readbacks.toFixed(0)} (${setF.readbackKB.toFixed(1)})`],
      ["  texture uploads (SCRTFillTextureAbgr)", setS.uploads, setF.uploads],
      ["Style animation: animation frames", aniS.frames, aniF.frames],
      ["  canvas textures built per animation frame", aniS.textures, aniF.textures],
      ["  getImageData readbacks per animation frame", aniS.readbacks, aniF.readbacks],
      ["  texture uploads per animation frame", aniS.uploads, aniF.uploads],
      ["new SpritePointMarker({ image }): canvas textures built", sprS.textures, sprF.textures],
    ],
    notes: [
      `Patched sprite size matches the library's: ${sameSize ? "yes" : "NO"}. The fixed column uploads the sprite twice per rebuild (copyTexture, then the opacity pass getSprite() runs on a cold cache); the shipped rebuild skips that opacity pass, which is the visible difference the issue's trade-off describes.`,
      "No palette provider here, so the stroke and fill masks are never read; with a point-marker palette provider the fix builds them on first use. Counts do not depend on hardware.",
    ],
    metrics: { tasks: TASKS, setS, setF, aniS, aniF, sprS, sprF, sameSize },
  });
}
