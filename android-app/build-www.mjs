// Builds android-app/www from the web UI in ../src/scenepilot/static WITHOUT changing the web code.
// App-only changes: asset paths become relative, and three small files from native/ are added.
// Usage: SCENEPILOT_API_BASE=http://192.168.0.20:8000 node build-www.mjs     (default http://10.0.2.2:8000, the emulator's view of this PC)
//        SCENEPILOT_API_BASE=https://your.server node build-www.mjs --release  (a release build must name an https:// server)
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webSource = join(here, "..", "src", "scenepilot", "static");
const out = join(here, "www");
const release = process.argv.includes("--release");
const given = (process.env.SCENEPILOT_API_BASE || "").trim();
if (release && !/^https:\/\/[^/]/.test(given)) {
  console.error("A release build needs SCENEPILOT_API_BASE set to the deployed https:// server (the app has no cleartext HTTP in release).");
  process.exit(1);
}
const apiBase = (given || "http://10.0.2.2:8000").replace(/\/+$/, "");

let html = readFileSync(join(webSource, "index.html"), "utf-8");
// Every file index.html loads from /static/ is copied, so a new script cannot be left out of the app.
const assets = [...new Set([...html.matchAll(/(?:src|href)="\/static\/([^"]+)"/g)].map((m) => m[1]))];
for (const file of assets) if (!existsSync(join(webSource, file))) throw new Error(`index.html loads /static/${file}, which does not exist`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of assets) cpSync(join(webSource, file), join(out, file));
if (existsSync(join(webSource, "audio"))) cpSync(join(webSource, "audio"), join(out, "static", "audio"), { recursive: true });
for (const file of ["api-shim.js", "local-rules.js", "local-first.js", "native-speech.js", "native-tts.js", "native-back.js"]) cpSync(join(here, "native", file), join(out, file));
writeFileSync(join(out, "app-config.js"), `window.SCENEPILOT_API_BASE = ${JSON.stringify(apiBase)};\n`);
// Read by capacitor.config.js at sync time: mixed content is only allowed when this build talks to an http:// server.
writeFileSync(join(out, "build.json"), JSON.stringify({ apiBase, release }) + "\n");

function insert(html, anchor, extra, where) {
  if (!html.includes(anchor)) throw new Error(`index.html changed: could not find ${anchor}`);
  return html.replace(anchor, where === "before" ? extra + anchor : anchor + extra);
}
html = html.replaceAll('"/static/', '"./');
html = insert(html, '<script src="./geo.js"></script>', '<script src="./app-config.js"></script>\n  <script src="./api-shim.js"></script>\n  <script src="./local-rules.js"></script>\n  <script src="./local-first.js"></script>\n  ', "before");
html = insert(html, '<script src="./speech.js"></script>', '\n  <script src="./native-speech.js"></script>\n  <script src="./native-tts.js"></script>', "after");
html = insert(html, '<script src="./app.js"></script>', '\n  <script src="./native-back.js"></script>', "after");
writeFileSync(join(out, "index.html"), html);
console.log(`www built${release ? " for release" : ""}. The app will talk to ${apiBase}${given ? "" : " (default: the emulator's view of this PC; set SCENEPILOT_API_BASE for a phone)"}`);
