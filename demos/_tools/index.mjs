// Regenerate demos/README.md, the Demo column of the README index and the Demo row of each issue file
// from demo folders, verifier results (_dist/NNN/result-*.json), gists.json and skipped.json.
//   node demos/_tools/index.mjs
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..");
const read = (p) => readFileSync(p, "utf8");
const json = (p, d) => (existsSync(p) ? JSON.parse(read(p)) : d);

const findings = json(join(repo, "data", "findings.json"), []);
const gists = json(join(root, "gists.json"), {});
const skipped = json(join(root, "skipped.json"), {}); // { "NNN": "reason" }
const issueFiles = Object.fromEntries(readdirSync(join(repo, "issues")).filter((f) => /^\d{3}-.*\.md$/.test(f)).map((f) => [f.slice(0, 3), f]));
const demoDirs = Object.fromEntries(readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d{3}-/.test(d.name)).map((d) => [d.name.slice(0, 3), d.name]));

function results(id) {
  const out = {};
  for (const r of ["webgl", "webgpu"]) {
    for (const suffix of ["-dpr2", ""]) {
      const p = join(root, "_dist", id, `result-${r}${suffix}.json`);
      if (existsSync(p)) { out[r] = json(p); break; }
    }
  }
  return out;
}
const WORD = { "reproduced": "Reproduced", "not-reproduced": "Not reproduced", "inconclusive": "Inconclusive", "error": "Error", "timeout": "Timed out" };
const word = (v) => (v ? WORD[v] || v : "–");
function combined(res) {
  const a = res.webgl && res.webgl.verdict, b = res.webgpu && res.webgpu.verdict;
  if (!a && !b) return { key: "not run", text: "not run" };
  if (a === b || !a || !b) return { key: a || b, text: `${word(a || b).toLowerCase()} on ${[a && "WebGL", b && "WebGPU"].filter(Boolean).join(" and ")}` };
  return { key: "mixed", text: `WebGL: ${word(a).toLowerCase()}, WebGPU: ${word(b).toLowerCase()}` };
}
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- demos/README.md
const rows = [], skippedRows = [], tally = {};
let env = null;
for (const f of findings) {
  const id = f.id, issue = issueFiles[id];
  if (demoDirs[id]) {
    const res = results(id), c = combined(res), g = gists[id];
    tally[c.key] = (tally[c.key] || 0) + 1;
    const any = res.webgpu || res.webgl;
    if (!env && any && any.env) env = any.env;
    rows.push(`| ${id} | ${f.severity} | [${esc(f.title)}](../issues/${issue}) | ${g ? `[JSFiddle](${g.fiddle})` : "not published"} · [source](${demoDirs[id]}/) | ${word(res.webgl && res.webgl.verdict)} | ${word(res.webgpu && res.webgpu.verdict)} | ${esc(any && any.headline)} |`);
  } else {
    skippedRows.push(`| ${id} | ${f.severity} | [${esc(f.title)}](../issues/${issue}) | ${esc(skipped[id] || "No demo yet.")} |`);
  }
}
const chrome = env && /(?:Headless)?Chrome\/([\d.]+)/.exec(env.ua);
const summary = [
  `${rows.length} of ${findings.length} issues have a demo`,
  ...Object.entries(tally).map(([k, n]) => `${n} ${k === "mixed" ? "with different verdicts per renderer" : word(k).toLowerCase()}`),
  `${skippedRows.length} without a demo`,
].join(" · ");
const readme = `# Demos

One page per issue. Each page loads SciChart.js 6.0.6 from jsDelivr, drives the scenario the issue describes (hover, streaming, zoom, create/delete...), **counts** what the issue claims (calls per frame, bytes uploaded, native objects created vs deleted, rAF requests...), and shows a verdict with a small table. Where the issue's workaround can be applied at runtime, the page runs the scenario twice, as shipped and with the workaround, to show the cause.

Open a JSFiddle link and wait a few seconds: the verdict and table appear under the chart. **Run again** re-runs it; the renderer menu switches between SciChart's default, WebGL and WebGPU (the page reloads). The fiddles load from secret gists, so they are unlisted but open to anyone with the link.

**${summary}.**

Verdicts below are from the headless verifier${chrome ? ` (Chrome ${chrome[1]}, macOS)` : ""}, run on both renderers. Counts do not depend on hardware; the timing rows in each page do.

| # | Severity | Issue | Demo | WebGL | WebGPU | Measured (headline) |
|---|---|---|---|---|---|---|
${rows.join("\n")}

## Issues without a demo

${skippedRows.length ? `| # | Severity | Issue | Why there is no demo |\n|---|---|---|---|\n${skippedRows.join("\n")}` : "None."}

## How the demos work

- Each fiddle's JS panel starts with the demo code (\`META\` and \`demo(P)\`), followed by the shared measurement harness ([\`_shared/probe.js\`](_shared/probe.js)). The harness sets the renderer flag, injects \`https://cdn.jsdelivr.net/npm/scichart@6.0.6/index.min.js\`, installs counters (browser APIs, wasm calls, embind object creation and deletion), drives frames and synthetic pointer input, and renders the table.
- Writing or changing a demo: [AUTHORING.md](AUTHORING.md).
- Build, verify, publish:

\`\`\`bash
cd demos
python3 -m http.server 8770 --bind 127.0.0.1 -d .   # static server for the verifier
node _tools/build.mjs 012                          # -> _dist/012/ (gist files + local index.html)
node _tools/verify.mjs 012                         # headless Chrome, WebGL and WebGPU
node _tools/publish.mjs 012                        # create or update the secret gist (gists.json)
node _tools/index.mjs                              # regenerate this file and the issue links
\`\`\`

The SciChart Community license used by the fiddles is valid for 6 months from the 6.0.6 release (2026-10-02), so the demos run until about 2027-04-02.
`;
writeFileSync(join(root, "README.md"), readme);

// ---------------------------------------------------------------- README.md index: Demo column
const rootReadme = read(join(repo, "README.md"));
const lines = rootReadme.split("\n");
const hdr = lines.findIndex((l) => /^\| # \| Severity \| Stage \| Issue \|/.test(l));
if (hdr >= 0) {
  const withDemo = /\| Demo \|$/.test(lines[hdr]);
  if (!withDemo) { lines[hdr] += " Demo |"; lines[hdr + 1] += "---|"; }
  for (let i = hdr + 2; i < lines.length && lines[i].startsWith("| ["); i++) {
    const id = /^\| \[(\d{3})\]/.exec(lines[i])[1];
    const cells = lines[i].split(" | ");
    let cell;
    if (demoDirs[id]) {
      const c = combined(results(id)), g = gists[id];
      cell = g ? `[${c.key === "mixed" ? "see demo" : word(c.key).toLowerCase()}](${g.fiddle})` : word(c.key).toLowerCase();
    } else cell = "none";
    if (withDemo) { cells[cells.length - 1] = `${cell} |`; lines[i] = cells.join(" | "); } else lines[i] += ` ${cell} |`;
  }
  let out = lines.join("\n");
  const section = `## Demos\n\nBrowser demos that measure the issues: [\`demos/\`](demos/README.md) (one JSFiddle per issue, verdicts on WebGL and WebGPU). ${summary}. The Demo column in the index links each fiddle.\n`;
  if (/## Demos\n[\s\S]*?\n(?=## )/.test(out)) out = out.replace(/## Demos\n[\s\S]*?\n(?=## )/, section + "\n");
  else out = out.replace(/\n## Verification status/, `\n${section}\n## Verification status`);
  writeFileSync(join(repo, "README.md"), out);
}

// ---------------------------------------------------------------- issues/*.md: Demo row
for (const f of findings) {
  const id = f.id, p = join(repo, "issues", issueFiles[id]);
  let text = read(p);
  let row;
  if (demoDirs[id]) {
    const c = combined(results(id)), g = gists[id];
    row = `| Demo | ${g ? `[JSFiddle](${g.fiddle})` : "not published yet"}: ${c.text} ([source](../demos/${demoDirs[id]}/)) |`;
  } else {
    row = `| Demo | none: ${esc(skipped[id] || "no demo yet")} |`;
  }
  if (/^\| Demo \|.*\|$/m.test(text)) text = text.replace(/^\| Demo \|.*\|$/m, row);
  else text = text.replace(/^(\| Verification \|.*\|)$/m, `$1\n${row}`);
  writeFileSync(p, text);
}
console.log(`demos/README.md: ${summary}`);
