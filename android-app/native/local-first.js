// App only. Runs the first steps of an accident (start, consent, the safety questions, the emergency notice) on the phone,
// so they work without a connection and without a round trip per answer. Guidance, photos, questions and the summary
// still go to the server.
//
// How: this wraps fetch (after api-shim.js). Requests for the first steps are answered here, in the shape the server
// uses, and recorded. Whenever the server can be reached the records are replayed to it with the normal API, so the
// server ends in the same state (its rules give the same result for the same answers). The first request that only the
// server can answer hands the accident over to it; from then on the app uses the server's session as before.
// Texts, decisions and screens come from local-rules.js, which tools/export_local_rules.py writes from the server's own
// Python rules. Only the answer parsing (the same regular expressions) and the order of the steps live here.
"use strict";
(() => {
  const RULES = window.SCENEPILOT_LOCAL_RULES;
  if (!RULES || typeof window.fetch !== "function") return;
  const STORE_KEY = "scenepilot.local";
  const KEEP = 5;
  const OFFLINE = "This step needs an internet connection. Your answers so far are saved on this phone. Try again when you are connected.";
  const nativeFetch = window.fetch.bind(window);
  const note = (message) => { try { console.log("[ScenePilot local] " + message); } catch { /* no console */ } };

  // ---------- Understanding answers (a port of emergency.parse_answer; the patterns come from the server) ----------
  const P = RULES.parse;
  const UNSURE = new RegExp(P.unsure);
  const SIGNALS = {};
  for (const [name, s] of Object.entries(P.signals)) SIGNALS[name] = { pos: new RegExp(s.pos), neg: new RegExp(s.neg, "g") };
  const NO = new Set(P.no_words), STRONG = new Set(P.strong_yes), WEAK = new Set(P.weak_yes);

  const normalize = (text) =>
    String(text).toLowerCase().replace(/’/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

  function generic(t) {
    const words = t.split(" ");
    const no = words.some((w) => NO.has(w));
    const strong = words.some((w) => STRONG.has(w));
    if (no) return strong ? null : "no";   // "yes" and "no" together: unclear
    if (strong || words.some((w) => WEAK.has(w))) return "yes";
    return null;
  }

  function parseAnswer(text, qid) {
    const t = normalize(text);
    if (!t) return null;
    if (Object.prototype.hasOwnProperty.call(P.sound_alikes, t)) return P.sound_alikes[t];
    if (P.plain.includes(t)) return t;
    if (UNSURE.test(t)) return "unsure";
    const parts = qid === "danger" ? P.danger_parts : SIGNALS[qid] ? [qid] : [];
    if (parts.length) {
      let remainder = t;
      for (const part of parts) remainder = remainder.replace(SIGNALS[part].neg, " ");
      if (parts.some((part) => SIGNALS[part].pos.test(remainder))) return "yes";   // a danger signal wins
      if (remainder !== t) return "no";
    }
    return generic(t);
  }

  function parseAlternatives(texts, qid) {
    const found = new Set(texts.map((t) => parseAnswer(t, qid)).filter(Boolean));
    if (!found.size) return null;
    return found.size === 1 ? [...found][0] : "unsure";   // guesses that disagree: the cautious side
  }

  // ---------- Accidents kept on this phone ----------
  let records = {};
  try { records = JSON.parse(window.localStorage.getItem(STORE_KEY) || "{}") || {}; } catch { records = {}; }
  const save = () => {
    const ids = Object.keys(records);
    ids.slice(0, Math.max(0, ids.length - KEEP)).forEach((id) => { delete records[id]; });
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(records)); } catch { /* storage unavailable: memory only */ }
  };
  const newId = () => {
    const bytes = new Uint8Array(6);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256); });
    return "local" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 7);
  };

  const keyOf = (answers) => RULES.questions.map((q) => answers[q] || "-").join("|");
  const entryOf = (st) => RULES.entries[keyOf(st.answers)];

  function view(st, extra) {
    const entry = entryOf(st);
    let prompt;
    if (st.stage === "consent") prompt = RULES.consent.prompt;
    else if (st.stage === "safety") prompt = RULES.safety_prompts[entry.next_question][st.unparsed[entry.next_question] > 0 ? 1 : 0];
    else if (st.acked.length && entry.ack) prompt = entry.ack.prompt;
    else prompt = entry.prompt;
    const session = {
      ...RULES.session_template, id: st.id, created_at: st.created_at, stage: st.stage,
      safety_answers: st.answers, unparsed: st.unparsed, emergency: entry.emergency, acked_triggers: st.acked,
    };
    const progress = st.stage === "consent" ? RULES.consent.safety_progress : entry.safety_progress;
    return { session, prompt, ...RULES.static_view, safety_progress: progress, ...extra };
  }

  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const wrongStage = (st, needed) =>
    reply(409, { detail: `Not allowed in the current stage (${st.stage}). Required stage: ${needed}` });

  // The steps the phone can take. Each returns the response; a step that changed something is recorded for the server.
  const STEPS = {
    "/consent": (rec) => {
      const st = rec.state;
      if (st.stage !== "consent") return wrongStage(st, "consent");
      st.stage = "safety";
      return reply(200, view(st));
    },
    "/safety-answer": (rec, body) => {
      const st = rec.state;
      if (st.stage !== "safety") return wrongStage(st, "safety");
      const qid = entryOf(st).next_question;
      let answer = parseAlternatives([String(body.answer || ""), ...(body.alternatives || [])], qid);
      if (answer === null) {
        st.unparsed[qid] = (st.unparsed[qid] || 0) + 1;
        if (st.unparsed[qid] < RULES.max_unparsed) return reply(200, view(st, { understood: false }));
        answer = "unsure";   // asked twice and still unclear: the risky side
      }
      st.answers[qid] = answer;
      st.stage = entryOf(st).stage;
      return reply(200, view(st, { understood: true }));
    },
    "/ack-emergency": (rec) => {
      const st = rec.state;
      const entry = entryOf(st);
      if (st.stage !== "emergency" || !entry.ack) return wrongStage(st, "emergency");
      st.acked = entry.ack.acked_triggers.slice();
      st.stage = entry.ack.stage;
      return reply(200, view(st));
    },
  };

  // ---------- Replaying to the server ----------
  const chains = {};

  async function send(method, path, body) {
    const res = await nativeFetch(path, {
      method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`server answered ${res.status} to ${path}`);
    return res.json();
  }

  async function replay(id) {
    const rec = records[id];
    if (!rec.serverId) {
      rec.serverId = (await send("POST", "/api/sessions", { country: rec.state.country })).session.id;
      save();
    }
    let last = null;
    while (rec.sent < rec.events.length) {
      const ev = rec.events[rec.sent];
      last = await send("POST", `/api/sessions/${rec.serverId}${ev.path}`, ev.body);
      rec.sent += 1;
      save();
    }
    if (last && (last.session.stage !== rec.state.stage || last.session.emergency.level !== entryOf(rec.state).emergency.level)) {
      rec.mismatch = true; save();   // the server's own rules decide from here; keep a trace of the difference
      note(`server and phone disagree for ${id}: server ${last.session.stage}/${last.session.emergency.level}`);
    }
  }

  // One replay at a time per accident. A failure (no connection) is kept for the next try.
  const sync = (id) => (chains[id] = (chains[id] || Promise.resolve()).catch(() => {}).then(() => replay(id)));
  const syncQuietly = (id) => { sync(id).catch(() => { /* offline: tried again later */ }); };
  window.addEventListener && window.addEventListener("online", () => {
    Object.keys(records).forEach((id) => { if (!records[id].handedOver) syncQuietly(id); });
  });

  // ---------- fetch ----------
  window.fetch = async (input, init = {}) => {
    if (typeof input !== "string" || !input.startsWith("/api/sessions")) return nativeFetch(input, init);
    const method = (init.method || "GET").toUpperCase();
    const [path, query] = input.split("?");

    if (path === "/api/sessions" && method === "POST") {
      const body = init.body ? JSON.parse(init.body) : {};
      if ((body.country || RULES.country) !== RULES.country) return nativeFetch(input, init);
      const id = newId();
      const state = { id, country: RULES.country, created_at: new Date().toISOString(), stage: "consent", answers: {}, unparsed: {}, acked: [] };
      records[id] = { state, events: [], sent: 0, serverId: null, handedOver: false, rules: RULES.version };
      save();
      syncQuietly(id);
      return reply(200, view(state));
    }

    const m = /^\/api\/sessions\/([^/]+)(\/[^/]+)?$/.exec(path);
    const rec = m && records[m[1]];
    if (!rec) return nativeFetch(input, init);
    const [, id, step = ""] = m;

    if (!rec.handedOver) {
      if (method === "GET" && !step) return reply(200, view(rec.state));
      if (method === "POST" && STEPS[step] && RULES.local_stages.includes(rec.state.stage)) {
        const body = init.body ? JSON.parse(init.body) : {};
        const res = STEPS[step](rec, body);
        if (res.status === 200) { rec.events.push({ path: step, body }); save(); syncQuietly(id); }
        return res;
      }
    }

    // Only the server can do this: bring it up to date, then hand the accident over.
    try {
      await sync(id);
    } catch (e) {
      note(`hand-over of ${id} failed: ${e.message}`);
      return reply(503, { detail: OFFLINE });
    }
    rec.handedOver = true;
    save();
    return nativeFetch(`/api/sessions/${rec.serverId}${step}${query ? "?" + query : ""}`, init);
  };

  // For the tests: the parser, so it can be checked against the server's.
  window.SCENEPILOT_LOCAL = { parseAnswer, parseAlternatives, records: () => records };
})();
