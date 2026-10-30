// Runs android-app/native/local-first.js the way the app does, for tests/test_local_first.py.
// Input (stdin, JSON): { phrases: [[text, qid], ...], alternatives: [[[texts], qid], ...], scenarios: [[{ path, body }, ...], ...] }
// Output (stdout, JSON): the phone's parse results, and per scenario the responses given with no connection, the requests
// replayed to the server once it is reachable, and where the first server-only request was sent.
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "android-app", "native");
const log = console.log;
console.log = () => {};   // keep stdout for the result

function load(serverFetch) {
  for (const file of ["local-rules.js", "local-first.js"]) delete require.cache[require.resolve(path.join(ROOT, file))];
  const storage = {};
  global.window = {
    fetch: serverFetch,
    localStorage: { getItem: (k) => storage[k] ?? null, setItem: (k, v) => { storage[k] = String(v); } },
    addEventListener() {},
  };
  require(path.join(ROOT, "local-rules.js"));
  require(path.join(ROOT, "local-first.js"));
  return global.window;
}

const post = (w, url, body) => w.fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

async function runScenario(steps) {
  let online = false;
  const sent = [];
  const server = async (url, init = {}) => {
    if (!online) throw new TypeError("Failed to fetch");
    sent.push({ method: init.method || "GET", path: url, body: init.body ? JSON.parse(init.body) : null });
    // A stand-in server: the real one is driven by the Python test with the same requests.
    return new Response(JSON.stringify({ session: { id: "srv1", stage: "?", emergency: { level: "?" } } }), { status: 200 });
  };
  const w = load(server);

  const responses = [];
  const keep = async (res) => { responses.push({ status: res.status, body: await res.json() }); return responses[responses.length - 1]; };
  const first = await keep(await post(w, "/api/sessions", { country: "US" }));
  const id = first.body.session.id;
  for (const step of steps) await keep(await post(w, `/api/sessions/${id}${step.path}`, step.body));
  await keep(await w.fetch(`/api/sessions/${id}`));

  // Still offline: a step only the server can do is refused with a clear message, and nothing is lost.
  const offline = await keep(await post(w, `/api/sessions/${id}/goto`, { target: "hub" }));

  online = true;
  await post(w, `/api/sessions/${id}/goto`, { target: "hub" });
  const forwarded = sent[sent.length - 1].path;
  return { id, responses, offline_status: offline.status, replay: sent.slice(0, -1), forwarded };
}

(async () => {
  const input = JSON.parse(require("fs").readFileSync(0, "utf-8"));
  const w = load(async () => { throw new TypeError("offline"); });
  const out = {
    phrases: input.phrases.map(([text, qid]) => w.SCENEPILOT_LOCAL.parseAnswer(text, qid)),
    alternatives: input.alternatives.map(([texts, qid]) => w.SCENEPILOT_LOCAL.parseAlternatives(texts, qid)),
    scenarios: [],
  };
  for (const steps of input.scenarios) out.scenarios.push(await runScenario(steps));
  process.stdout.write(JSON.stringify(out));
})().catch((e) => { log(String(e && e.stack || e)); process.exit(1); });
