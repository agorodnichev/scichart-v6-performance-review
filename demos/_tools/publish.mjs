// Create or update one secret gist per built demo and record its JSFiddle link.
//   node demos/_tools/publish.mjs 012 027      -> only these
//   node demos/_tools/publish.mjs              -> every demo in _dist/
// Uses the GitHub CLI's auth (`gh api`). Gist ids are kept in demos/gists.json.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "_dist");
const ledgerPath = join(root, "gists.json");
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : {};
const ids = process.argv.slice(2);
const targets = ids.length ? ids : readdirSync(dist).filter((d) => /^\d{3}$/.test(d));
const FILES = ["fiddle.html", "fiddle.js", "fiddle.css", "fiddle.manifest"];
const tmp = mkdtempSync(join(tmpdir(), "gist-"));

// GitHub applies secondary rate limits to content creation: space the calls out.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function api(method, path, body) {
  const input = join(tmp, "body.json");
  writeFileSync(input, JSON.stringify(body));
  const out = JSON.parse(execFileSync("gh", ["api", "-X", method, path, "--input", input], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  pause(1500);
  return out;
}

for (const id of targets) {
  const dir = join(dist, id);
  if (!existsSync(join(dir, "fiddle.js"))) { console.log(`${id}: not built, skipped`); continue; }
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const files = Object.fromEntries(FILES.map((f) => [f, { content: readFileSync(join(dir, f), "utf8") }]));
  const description = `SciChart.js 6.0.6 performance issue ${id}: ${meta.title} (JSFiddle demo)`;
  let gistId = ledger[id] && ledger[id].gist;
  if (gistId) {
    api("PATCH", `/gists/${gistId}`, { description, files });
  } else {
    gistId = api("POST", "/gists", { description, public: false, files }).id;
  }
  ledger[id] = { gist: gistId, dir: meta.dir, fiddle: `https://jsfiddle.net/gh/gist/library/pure/${gistId}/`, gistUrl: `https://gist.github.com/${gistId}` };
  writeFileSync(ledgerPath, JSON.stringify(Object.fromEntries(Object.entries(ledger).sort()), null, 2) + "\n");
  console.log(`${id}: ${ledger[id].fiddle}`);
}
