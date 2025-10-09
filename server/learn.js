import fs from "fs";
import path from "path";

const learnDir = path.resolve("data", "learn");
const metaDir = path.resolve("data", "meta");
fs.mkdirSync(learnDir, { recursive: true });
fs.mkdirSync(metaDir, { recursive: true });

const files = {
  search: path.join(learnDir, "search.jsonl"),
  fetch: path.join(learnDir, "fetch.jsonl"),
  episodes: path.join(learnDir, "episodes.jsonl"),
  bandit: path.join(metaDir, "bandit.json"),
  sources: path.join(metaDir, "sources.json"),
  playbook: path.join(metaDir, "playbook.json")
};

function appendJSONL(file, row) {
  try { fs.appendFileSync(file, JSON.stringify(row) + "\n"); } catch {}
}

function readJSONSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJSONSafe(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch {}
}

export function bucketTopic(text) {
  const s = String(text||"").toLowerCase();
  // crude topic bucketing: prefix by "news:" if query has news-ish verbs
  const isNews = /(remove|pulled|taken down|ban|announce|launch|recall|sues|acquire|merger|investigation|policy)/i.test(text||"");
  // strip URLs and punctuation
  const t = s.replace(/https?:\/\/\S+/g," ").replace(/[^a-z0-9\s/]+/g," ").replace(/\s+/g," ").trim();
  const words = t.split(" ").filter(w=>w.length>2).slice(0,6);
  const slug = words.join("/");
  return (isNews? "news:" : "topic:") + (slug || "misc");
}

// ---- Ledgers
export function recordSearch({ userId, sessionId, topic, q_base, qlist, engine, k, latency_ms, error }) {
  appendJSONL(files.search, {
    ts: Date.now(), userId, sessionId, topic, q_base, qlist, engine, k, latency_ms, error: error? String(error): null
  });
}
export function recordFetch({ userId, sessionId, url, title, chars, latency_ms }) {
  appendJSONL(files.fetch, { ts: Date.now(), userId, sessionId, url, title, chars, latency_ms });
}
export function recordEpisode({ userId, sessionId, topic, success, note_saved=false, tokens_total=null, calls=null }) {
  appendJSONL(files.episodes, { ts: Date.now(), userId, sessionId, topic, success, note_saved, tokens_total, calls });
}

// ---- Stats
export function recentStats(N=20) {
  let rows = [];
  try {
    const txt = fs.readFileSync(files.episodes, "utf8");
    rows = txt.trim().split("\n").filter(Boolean).map(x=>JSON.parse(x));
  } catch {}
  const last = rows.slice(-N);
  const success = last.filter(r=>r.success).length;
  const rate = last.length ? success/last.length : 0;
  const avgTok = (()=>{
    const nums = last.map(r=>Number(r.tokens_total||0)).filter(x=>x>0);
    if (!nums.length) return null;
    return Math.round(nums.reduce((a,b)=>a+b,0)/nums.length);
  })();
  return { sample: last.length, success_rate: rate, avg_tokens: avgTok };
}

// ---- Bandit (UCB1) over rewrite templates
function loadBandit() { return readJSONSafe(files.bandit, {}); }
function saveBandit(b) { writeJSONSafe(files.bandit, b); }

// Available templates (composable). Each returns a new string or null.
const TEMPLATES = {
  strip_possessive: (q)=> q.replace(/\b([A-Za-z]+)'s\b/g, "$1"),
  add_app_store: (q)=> q + " app store",
  add_apple_app_store: (q)=> q + " apple app store",
  syn_removed_pulled: (q)=> q.replace(/\bremoved?\b/ig, "pulled"),
  syn_removed_taken_down: (q)=> q.replace(/\bremoved?\b/ig, "taken down"),
  add_quotes: (q)=> `"${q}"`,
};

function applyTemplate(key, q) {
  const fn = TEMPLATES[key];
  if (!fn) return null;
  try { const out = fn(String(q||"")); return out && out!==q ? out : null; } catch { return null; }
}

export function chooseRewriteTemplates() {
  const b = loadBandit();
  // UCB1: score = mean + c*sqrt(ln N / n); default mean=0 if unseen
  const keys = Object.keys(TEMPLATES);
  const N = keys.reduce((acc,k)=> acc + (b[k]?.n || 0), 0) + 1;
  const c = 1.4;
  const scored = keys.map(k=>{
    const n = b[k]?.n || 0;
    const r = b[k]?.r || 0; // reward sum
    const mean = n ? (r/n) : 0.2; // optimistic prior
    const bonus = n ? c * Math.sqrt(Math.log(N)/n) : 1.0;
    return { key:k, score: mean + bonus };
  }).sort((a,b)=> b.score - a.score);
  return scored.map(x=>x.key);
}

export function updateBandit(keysUsed, reward) {
  if (!Array.isArray(keysUsed) || !keysUsed.length) return;
  const b = loadBandit();
  for (const k of keysUsed) {
    if (!b[k]) b[k] = { n:0, r:0 };
    b[k].n += 1;
    b[k].r += Number(reward||0);
  }
  saveBandit(b);
}

// ---- Playbook (simple JSON rules)
export function loadPlaybook() {
  let pb = readJSONSafe(files.playbook, null);
  if (!pb) {
    pb = {
      "news:*": {
        "if_k0": ["strip_possessive","syn_removed_pulled","syn_removed_taken_down","add_app_store"]
      }
    };
    writeJSONSafe(files.playbook, pb);
  }
  return pb;
}
export function playbookFor(topic) {
  const pb = loadPlaybook();
  // match "news:*" or exact
  if (pb[topic]) return pb[topic];
  const prefix = topic.split(":")[0] + ":*";
  if (pb[prefix]) return pb[prefix];
  if (pb["news:*"]) return pb["news:*"];
  return { if_k0: [] };
}

export function buildQueryList(q_base, opts={}) {
  const used = [];
  const out = new Set();
  const push = (s)=>{ if (s && s.trim().length>2) out.add(s.trim()); };

  // base
  push(q_base);

  // bandit-preferred templates
  for (const key of chooseRewriteTemplates()) {
    const v = applyTemplate(key, q_base);
    if (v) { push(v); used.push(key); }
    if (out.size >= (opts.max||8)) break;
  }

  // stopword: if still small, add apple/app store variants by default
  if (out.size < 3) {
    for (const k of ["add_apple_app_store"]) {
      const v = applyTemplate(k, q_base);
      if (v) { push(v); used.push(k); }
    }
  }

  return { qlist: Array.from(out).slice(0, opts.max||8), keysUsed: used };
}
