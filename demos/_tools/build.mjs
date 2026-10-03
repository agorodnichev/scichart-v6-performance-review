// Assemble demos into JSFiddle gist files and a local preview page.
//   node demos/_tools/build.mjs            -> every demo folder
//   node demos/_tools/build.mjs 012 027    -> only these
// Output: demos/_dist/<NNN>/{fiddle.html, fiddle.js, fiddle.css, fiddle.manifest, index.html}
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shared = (f) => readFileSync(join(root, "_shared", f), "utf8");
const probe = shared("probe.js");
const baseCss = shared("base.css");

const wanted = process.argv.slice(2);
const dirs = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{3}-/.test(d.name))
  .map((d) => d.name)
  .filter((n) => !wanted.length || wanted.some((w) => n.startsWith(w)));

const yamlStr = (s) => JSON.stringify(String(s ?? "").replace(/\s+/g, " ").trim());

function readMeta(js, dir) {
  // META is a plain object literal at the top of demo.js; evaluate just that literal.
  const m = /const META = (\{[\s\S]*?\n\});/.exec(js);
  if (!m) throw new Error(`${dir}: demo.js must start with "const META = {...};"`);
  return Function(`"use strict"; return (${m[1]});`)();
}

let built = 0;
for (const dir of dirs) {
  const src = join(root, dir);
  const demoJs = readFileSync(join(src, "demo.js"), "utf8");
  const meta = readMeta(demoJs, dir);
  const demoHtml = existsSync(join(src, "demo.html"))
    ? readFileSync(join(src, "demo.html"), "utf8").trim()
    : `<div id="chart" class="probe-chart"></div>`;
  const demoCss = existsSync(join(src, "demo.css")) ? readFileSync(join(src, "demo.css"), "utf8") : "";

  const html = `<div id="probe-root"></div>\n<div class="probe-charts">\n${demoHtml}\n</div>\n<div id="probe-results"></div>\n`;
  const css = baseCss + (demoCss ? `\n/* demo-specific */\n${demoCss}` : "");
  const js = `${demoJs.trim()}\n\n${probe.trim()}\n\nProbe.boot(META, demo);\n`;
  const manifest = [
    `name: ${yamlStr(`SciChart.js 6.0.6 · issue ${meta.id} · ${meta.title}`)}`,
    `description: ${yamlStr(meta.claim)}`,
    `authors:`,
    `  - agorodnichev`,
    `normalize_css: no`,
    `wrap: d`,
    `panel_html: 0`,
    `panel_js: 0`,
    `panel_css: 0`,
    ``,
  ].join("\n");
  const index = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Issue ${meta.id}</title>
<style>
${css}
</style>
</head>
<body>
${html}
<script>
window.addEventListener("DOMContentLoaded", function () {
${js}
});
</script>
</body>
</html>
`;
  const out = join(root, "_dist", meta.id);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "fiddle.html"), html);
  writeFileSync(join(out, "fiddle.css"), css);
  writeFileSync(join(out, "fiddle.js"), js);
  writeFileSync(join(out, "fiddle.manifest"), manifest);
  writeFileSync(join(out, "index.html"), index);
  writeFileSync(join(out, "meta.json"), JSON.stringify({ dir, ...meta, method: undefined }, null, 2));
  built++;
}
console.log(`built ${built} demo(s): ${dirs.map((d) => d.slice(0, 3)).join(" ")}`);
