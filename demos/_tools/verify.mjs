// Run built demos in headless Chrome and record each verdict.
//   node demos/_tools/verify.mjs 012 027 [--renderer webgl|webgpu|both] [--dpr 2] [--timeout 120000] [--headful] [--port 8770]
// Needs: a static server on demos/ (python3 -m http.server 8770 --bind 127.0.0.1 -d demos)
// Writes demos/_dist/<NNN>/result-<renderer>.json and prints one line per run.
import puppeteer from "puppeteer-core";
import { writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(`--${name}`);
const optValues = new Set(["--renderer", "--dpr", "--timeout", "--port", "--shard"].flatMap((f) => { const i = args.indexOf(f); return i >= 0 ? [args[i + 1]] : []; }));
const ids = args.filter((a) => !a.startsWith("--") && !optValues.has(a));
const rendererOpt = opt("renderer", "both");
const renderers = rendererOpt === "both" ? ["webgl", "webgpu"] : [rendererOpt];
const dpr = Number(opt("dpr", "1"));
const timeout = Number(opt("timeout", "120000"));
const port = opt("port", "8770");
const chrome = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const all = existsSync(join(root, "_dist")) ? readdirSync(join(root, "_dist")).filter((d) => /^\d{3}$/.test(d)).sort() : [];
let targets = ids.length ? ids : all;
const shard = opt("shard", ""); // "i/n": every n-th target starting at i (1-based)
if (shard) { const [i, n] = shard.split("/").map(Number); targets = targets.filter((_, k) => k % n === i - 1); }

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: !flag("headful"),
  args: [
    "--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--js-flags=--expose-gc", "--enable-precise-memory-info", "--window-size=1100,1000",
  ],
  defaultViewport: { width: 1100, height: 1000, deviceScaleFactor: dpr },
});

let failures = 0;
for (const id of targets) {
  for (const renderer of renderers) {
    const page = await browser.newPage();
    const logs = [];
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warn") logs.push(`[${m.type()}] ${m.text()}`.slice(0, 400)); });
    page.on("pageerror", (e) => logs.push(`[pageerror] ${String(e).slice(0, 400)}`));
    await page.evaluateOnNewDocument((r) => { try { localStorage.setItem("scichartPerfDemo.renderer", r); } catch (e) { /* ignore */ } }, renderer);
    const t0 = Date.now();
    let result = null;
    try {
      await page.goto(`http://127.0.0.1:${port}/_dist/${id}/index.html`, { waitUntil: "load", timeout: 60000 });
      await page.waitForFunction(() => window.__demoResult !== undefined, { timeout, polling: 500 });
      result = await page.evaluate(() => window.__demoResult);
    } catch (e) {
      result = { id, verdict: "timeout", headline: String(e.message || e).slice(0, 300) };
      try { result.partialLog = await page.evaluate(() => Array.from(document.querySelectorAll(".probe-log li")).map((li) => li.textContent)); } catch (e2) { /* ignore */ }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    // Known noise: favicon 404s, and the engine's own WebGL query warnings on 3D surfaces (see demos/README.md).
    const noise = /favicon|404 \(File not found\)|beginQuery|getQueryParameter|endQuery|WebGL: too many errors/;
    const out = { ...result, renderer, dpr, seconds: Number(secs), consoleErrors: logs.filter((l) => !noise.test(l)).slice(-20) };
    if (existsSync(join(root, "_dist", id))) writeFileSync(join(root, "_dist", id, `result-${renderer}${dpr !== 1 ? `-dpr${dpr}` : ""}.json`), JSON.stringify(out, null, 2));
    if (!["reproduced", "not-reproduced", "inconclusive"].includes(out.verdict)) failures++;
    const rows = (out.rows || []).slice(0, 6).map((r) => `      ${r[0]}: ${r.slice(1).join(" | ")}`).join("\n");
    console.log(`${id} ${renderer.padEnd(6)} ${String(out.verdict).padEnd(14)} ${secs}s  ${out.headline || ""}${rows ? `\n${rows}` : ""}${out.consoleErrors.length ? `\n      console: ${out.consoleErrors.slice(-3).join(" || ")}` : ""}`);
    await page.close();
  }
}
await browser.close();
process.exit(failures ? 1 : 0);
