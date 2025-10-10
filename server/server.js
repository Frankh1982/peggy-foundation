import "dotenv/config";
import fs from "fs";
import path from "path";
import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import { buildSystemPrompt } from "./prompt.js";
import { getUserProfile, updateUserProfile, appendMessage, getRecentMessages, appendGap, closeGap, appendNote } from "./memory.js";
import { tool_web_get, tool_web_search, saveRunRecord } from "./tools.js";
import { bucketTopic, recordSearch, recordFetch, recordEpisode, recentStats, buildQueryList, playbookFor, updateBandit, updateLastEpisode } from "./learn.js";

const PORT = process.env.PORT || 8787;
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const RECENT_N = Number(process.env.RECENT_N || 4);
const MAX_PAGE_CHARS = Number(process.env.MAX_PAGE_CHARS || 16000);
const CALL_POLICY = (process.env.CALL_POLICY || "auto").trim().toLowerCase();
const PEG_BUILD = "2025-10-04-v3j-learn";
const DEFAULT_SOURCE_PRIOR = 0.45;
const SCORE_PRIOR_WEIGHT = 0.45;
const SCORE_RECENCY_WEIGHT = 0.55;
const RECENCY_FALLBACK = 0.6;
const EXPLORATION_RATE = 0.15;
const SOURCE_PRIORS = loadSourcePriors();
const DOMAIN_PREFS = loadDomainPrefs();

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in .env");
  process.exit(1);
}

const app = express();
app.use(express.static(path.resolve("public")));
app.get("/version", (_req, res) => res.json({ build: PEG_BUILD, call_policy: CALL_POLICY }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/chat" });
const sessionSearch = new Map();
const sessionTopicState = new Map();

function emitEventLog(ws, label, payload) {
  if (!ws || !label) return;
  let data;
  if (payload === undefined || payload === null) {
    data = "{}";
  } else if (typeof payload === "string") {
    data = payload.trim();
    if (!data) data = "{}";
  } else {
    try {
      data = JSON.stringify(payload);
    } catch {
      data = String(payload);
    }
  }
  if (!data || typeof data !== "string") data = String(data || "{}");
  const line = `${label} ${data}`.trim();
  const eventMsg = { type: "event_log", line };
  try { ws.send(JSON.stringify(eventMsg)); } catch {}
  try {
    ws.send(JSON.stringify({
      type: "call_result",
      call_id: line,
      run: { tool: "event_log", result_summary: { title: "", url: "", latency_ms: "" } }
    }));
  } catch {}
}

function loadSourcePriors() {
  try {
    const file = path.resolve("data", "meta", "sources.json");
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    const out = {};
    for (const [key, value] of Object.entries(parsed || {})) {
      const domain = String(key || "").trim().toLowerCase();
      const num = Number(value);
      if (!domain) continue;
      if (!Number.isFinite(num)) continue;
      out[domain] = Math.max(0, Math.min(1, num));
    }
    return out;
  } catch {
    return {};
  }
}

function loadDomainPrefs() {
  try {
    const file = path.resolve("data", "meta", "domain_prefs.json");
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    const normalizeList = (value) => {
      if (!Array.isArray(value)) return [];
      const set = new Set();
      for (const item of value) {
        const clean = String(item || "").trim().toLowerCase();
        if (!clean) continue;
        set.add(clean);
      }
      return Array.from(set);
    };
    return {
      exclude: normalizeList(parsed.exclude),
      prefer: normalizeList(parsed.prefer),
      neutral: normalizeList(parsed.neutral)
    };
  } catch {
    return { exclude: [], prefer: [], neutral: [] };
  }
}

function getSourcePrior(domain) {
  if (!domain) return DEFAULT_SOURCE_PRIOR;
  return SOURCE_PRIORS[domain] ?? DEFAULT_SOURCE_PRIOR;
}

function domainMatches(domain, pattern) {
  if (!domain || !pattern) return false;
  const cleanDomain = domain.toLowerCase();
  const cleanPattern = pattern.toLowerCase();
  return cleanDomain === cleanPattern || cleanDomain.endsWith(`.${cleanPattern}`);
}

function shouldExcludeDomain(domain, url, requestText) {
  const urlLower = String(url || "").toLowerCase();
  const text = String(requestText || "");
  const wantsReddit = /\binclude\s+reddit\b/i.test(text)
    || /\bfrom\s+reddit\b/i.test(text)
    || /\breddit\s+(?:threads?|posts?|sources?|links?)\b/i.test(text)
    || /\br\/[a-z0-9_]+/i.test(text);
  for (const pattern of DOMAIN_PREFS.exclude || []) {
    if (!pattern) continue;
    const isRedditPattern = pattern.includes("reddit");
    if (pattern.includes("/")) {
      if (!urlLower) continue;
      if (urlLower.includes(pattern)) {
        if (isRedditPattern && wantsReddit) continue;
        return true;
      }
      continue;
    }
    if (domainMatches(domain, pattern)) {
      if (isRedditPattern && wantsReddit) continue;
      return true;
    }
  }
  return false;
}

function isPreferredDomain(domain) {
  if (!domain) return false;
  for (const pattern of DOMAIN_PREFS.prefer || []) {
    if (domainMatches(domain, pattern)) return true;
  }
  return false;
}

function getTopicState(sessionId, topic) {
  let topicMap = sessionTopicState.get(sessionId);
  if (!topicMap) {
    topicMap = new Map();
    sessionTopicState.set(sessionId, topicMap);
  }
  let state = topicMap.get(topic);
  if (!state) {
    state = { history: [], runCount: 0, lastRunAt: 0 };
    topicMap.set(topic, state);
  }
  return state;
}

function touchTopicRun(sessionId, topic) {
  const state = getTopicState(sessionId, topic);
  state.runCount = (state.runCount || 0) + 1;
  state.lastRunAt = Date.now();
  return state.runCount;
}

function getSeenDomains(sessionId, topic) {
  const state = getTopicState(sessionId, topic);
  const seen = new Set();
  for (const list of state.history || []) {
    if (!Array.isArray(list)) continue;
    for (const domain of list) {
      if (domain) seen.add(domain);
    }
  }
  return seen;
}

function rememberSeenDomains(sessionId, topic, domains = []) {
  const state = getTopicState(sessionId, topic);
  const normalized = Array.from(new Set(domains.filter(Boolean).map(d => d.toLowerCase())));
  state.history = state.history || [];
  state.history.push(normalized);
  const maxHistory = 3;
  if (state.history.length > maxHistory) {
    state.history = state.history.slice(-maxHistory);
  }
}

function rotateList(list, shift) {
  if (!Array.isArray(list) || !list.length) return Array.isArray(list) ? list.slice() : [];
  const n = list.length;
  const k = ((shift % n) + n) % n;
  if (k === 0) return list.slice();
  return list.slice(k).concat(list.slice(0, k));
}

function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function computeRecencyScore(entry) {
  const now = Date.now();
  const candidates = [
    entry?.published,
    entry?.published_at,
    entry?.publishedAt,
    entry?.date,
    entry?.datetime,
    entry?.time,
    entry?.ts
  ];
  for (const value of candidates) {
    if (!value) continue;
    const ts = Date.parse(value);
    if (Number.isFinite(ts)) {
      const diff = now - ts;
      if (Number.isFinite(diff) && diff >= 0) return recencyFromAge(diff);
    }
  }

  const ageCandidates = [
    typeof entry?.age_ms === "number" ? entry.age_ms : null,
    typeof entry?.ageMs === "number" ? entry.ageMs : null,
    typeof entry?.age_seconds === "number" ? entry.age_seconds * 1000 : null,
    typeof entry?.ageMinutes === "number" ? entry.ageMinutes * 60000 : null,
    typeof entry?.age_hours === "number" ? entry.age_hours * 3600000 : null,
    typeof entry?.ageHours === "number" ? entry.ageHours * 3600000 : null,
    typeof entry?.age_days === "number" ? entry.age_days * 86400000 : null,
    typeof entry?.ageDays === "number" ? entry.ageDays * 86400000 : null
  ].filter(v => Number.isFinite(v) && v >= 0);
  if (ageCandidates.length) {
    return recencyFromAge(Math.min(...ageCandidates));
  }

  if (typeof entry?.age === "string") {
    const ageMs = parseAgeString(entry.age);
    if (Number.isFinite(ageMs)) {
      return recencyFromAge(ageMs);
    }
  }

  return RECENCY_FALLBACK;
}

function parseAgeString(text) {
  if (!text) return NaN;
  const m = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*(hour|hr|day|week|month|year|minute|min)s?\b/i);
  if (!m) return NaN;
  const value = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (!Number.isFinite(value)) return NaN;
  const minute = 60000;
  const hour = 60 * minute;
  const day = 24 * hour;
  switch (unit) {
    case "minute":
    case "min":
      return value * minute;
    case "hour":
    case "hr":
      return value * hour;
    case "day":
      return value * day;
    case "week":
      return value * 7 * day;
    case "month":
      return value * 30 * day;
    case "year":
      return value * 365 * day;
    default:
      return NaN;
  }
}

function recencyFromAge(ageMs) {
  const day = 86400000;
  if (!Number.isFinite(ageMs) || ageMs < 0) return RECENCY_FALLBACK;
  if (ageMs <= 2 * day) return 1.0;
  if (ageMs <= 30 * day) return 0.8;
  return RECENCY_FALLBACK;
}

function formatScore(score) {
  if (!Number.isFinite(score)) return "0.60";
  const clamped = Math.max(0, Math.min(1, score));
  return clamped.toFixed(2);
}

function isGreeting(s) { return /^\s*(hi|hello|hey|howdy|yo|sup|hiya|hellooo)\s*[!?\.]*\s*$/i.test(s || ""); }
function wantsListOnly(text) { return /\b(find|show|list)\b.+\b(more|sites|sources|articles|links)\b/i.test(text || ""); }

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (ACCESS_TOKEN) {
    if (url.searchParams.get("access_token") !== ACCESS_TOKEN) {
      ws.close(4001, "Unauthorized");
      return;
    }
  }

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { ws.send(JSON.stringify({ type: "error", error: "bad_json" })); return; }

    if (msg.type !== "user_message") return;

    const userId = msg.user_id || "default";
    const sessionId = msg.session_id || "default";
    const content = (msg.content || "").toString().slice(0, 8000);
    const inReplyToGap = msg.in_reply_to_gap || null;

    appendMessage(sessionId, { role: "user", content });

    if (isGreeting(content) && !inReplyToGap) {
      const reply = "Hi! What do you need help with?";
      appendMessage(sessionId, { role:"assistant", content: reply });
      ws.send(JSON.stringify({ type:"assistant_message", content: reply }));
      ws.send(JSON.stringify({ type:"kdn", kdn: { state:"DK", reason:"greeting/ambiguous", ambiguous:true } }));
      return;
    }

    // URL → auto web_get
    if (!inReplyToGap) {
      const urlMatch = content.match(/https?:\/\/\S+/i);
      if (urlMatch) {
        const spec = { tool: "web_get", args: { url: urlMatch[0] } };
        await executeTool(ws, { userId, sessionId, spec, requestText: content });
        return;
      }
    }

    // Summarize a previously listed search result
    const summarizeMatch = content.match(/^\s*summarize\s*#(\d+)\s*$/i);
    if (summarizeMatch && !inReplyToGap) {
      const idx = Number(summarizeMatch[1]);
      const stored = sessionSearch.get(sessionId);
      const items = stored?.list || [];
      const numberValid = Number.isFinite(idx) ? idx : null;
      if (!stored) {
        emitEventLog(ws, "summarize_pick", { n: numberValid, ok: false, reason: "no_list" });
        const reply = "unknown with current context.";
        appendMessage(sessionId, { role: "assistant", content: reply });
        ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
        ws.send(JSON.stringify({ type: "kdn", kdn: { state: "DK", reason: "explicit unknown", ambiguous: false } }));
        return;
      }

      if (!Number.isFinite(idx) || idx < 1 || idx > 5) {
        emitEventLog(ws, "summarize_pick", { n: numberValid, ok: false, reason: "out_of_range" });
        const reply = "unknown with current context.";
        appendMessage(sessionId, { role: "assistant", content: reply });
        ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
        ws.send(JSON.stringify({ type: "kdn", kdn: { state: "DK", reason: "explicit unknown", ambiguous: false } }));
        return;
      }

      if (idx > items.length) {
        emitEventLog(ws, "summarize_pick", { n: idx, ok: false, reason: "missing_item" });
        const reply = "unknown with current context.";
        appendMessage(sessionId, { role: "assistant", content: reply });
        ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
        ws.send(JSON.stringify({ type: "kdn", kdn: { state: "DK", reason: "explicit unknown", ambiguous: false } }));
        return;
      }

      const target = items[idx - 1];
      emitEventLog(ws, "summarize_pick", { n: idx, ok: true, reason: "ok", host: target.host || null });
      const spec = { tool: "web_get", args: { url: target.url } };
      await executeTool(ws, { userId, sessionId, spec, requestText: content, topic: stored.topic }, "auto");
      return;
    }

    // Search intents
    if (wantsListOnly(content) || /^\s*(search|look up)\b/i.test(content)) {
      const topic = bucketTopic(content);
      const base = content.replace(/^\s*(search|look up)\b/i, "").trim() || content;
      const { qlist, keysUsed } = buildQueryList(base, { max: 8 });
      const runNumber = touchTopicRun(sessionId, topic);
      const args = { q: base, qlist: qlist.slice(), k: 5 };
      const hasBrave = Boolean((process.env.BRAVE_API_KEY || "").trim());
      if (hasBrave) {
        if (runNumber > 1 && Math.random() < 0.5) {
          args.offset = 5;
        }
      } else if (runNumber > 1 && args.qlist.length > 1) {
        args.qlist = rotateList(args.qlist, runNumber - 1);
      }
      const spec = { tool: "web_search", args };
      await executeTool(ws, { userId, sessionId, spec, requestText: content, topic, banditKeys: keysUsed, runNumber });
      return;
    }

    // Default → model
    const profile = getUserProfile(userId);
    const systemPrompt = buildSystemPrompt(profile);
    const recent = getRecentMessages(sessionId, RECENT_N);
    const messages = [
      { role: "system", content: systemPrompt },
      ...recent,
      { role: "user", content }
    ];

    try {
      const { content: completion, usage } = await callOpenAI(messages);
      handleAssistantResponse(ws, { completion, usage, userId, sessionId });
    } catch (err) {
      ws.send(JSON.stringify({ type: "assistant_message", content: "unknown with current context (API error)." }));
      console.error(err);
    }
  });
});

server.listen(PORT, () => {
  console.log(`WS chat running at http://localhost:${PORT} • build=${PEG_BUILD} • policy=${CALL_POLICY}`);
});

async function executeTool(ws, meta, call_id="auto") {
  try {
    if (meta.spec.tool === "web_get") {
      const result = await tool_web_get(meta.spec.args, { MAX_PAGE_CHARS });
      const run = saveRunRecord("web_get", meta.spec.args, result);
      ws.send(JSON.stringify({ type:"call_result", call_id, run }));

      // Learning: fetch ledger
      recordFetch({ userId: meta.userId, sessionId: meta.sessionId, url: result.url, title: result.title, chars: result.chars, latency_ms: result.latency_ms });
      ws.send(JSON.stringify({ type:"learning_stats", stats: recentStats(20) }));

      await callModelWithGetResult(ws, meta, run);
    } else if (meta.spec.tool === "web_search") {
      const t0 = Date.now();
      const topic = meta.topic || bucketTopic(meta.requestText || meta.spec.args.q);
      if (!meta.runNumber) {
        touchTopicRun(meta.sessionId, topic);
      }
      const result = await tool_web_search(meta.spec.args, { MAX_PAGE_CHARS, BRAVE_API_KEY: process.env.BRAVE_API_KEY });
      const run = saveRunRecord("web_search", meta.spec.args, result);
      ws.send(JSON.stringify({ type:"call_result", call_id, run }));

      // Learning: search ledger + bandit reward + episode
      const k = result?.k || 0;
      const latency_ms = result?.latency_ms || (Date.now() - t0);
      recordSearch({
        userId: meta.userId, sessionId: meta.sessionId, topic,
        q_base: meta.spec.args.q, qlist: result?.qlist || meta.spec.args.qlist || [],
        engine: result?.engine || "unknown", k, latency_ms, error: null
      });
      const reward = Math.max(0, Math.min(1, k/3)) - 0.02*(latency_ms/1000);
      if (Array.isArray(meta.banditKeys) && meta.banditKeys.length) updateBandit(meta.banditKeys, reward);
      recordEpisode({
        userId: meta.userId, sessionId: meta.sessionId, topic,
        success: k>0, note_saved: false, tokens_total: null,
        calls: { web_search: 1, web_get: 0 }
      });
      // Send rolling stats to UI
      ws.send(JSON.stringify({ type:"learning_stats", stats: recentStats(20) }));

      // Server-side list
      const scoredResults = (result?.results || []).map((entry, idx) => {
        const domain = extractDomain(entry?.url || "");
        const prior = getSourcePrior(domain);
        const recency = computeRecencyScore(entry);
        const score = SCORE_PRIOR_WEIGHT * prior + SCORE_RECENCY_WEIGHT * recency;
        return { ...entry, domain, prior, recency, score, idx };
      }).filter(entry => entry && entry.url && !shouldExcludeDomain(entry.domain, entry.url, meta.requestText));

      const seenDomains = getSeenDomains(meta.sessionId, topic);
      const uniqueResults = [];
      const domainsInList = new Set();
      scoredResults.forEach(entry => {
        const key = entry.domain ? entry.domain.toLowerCase() : null;
        if (key && domainsInList.has(key)) return;
        if (key) domainsInList.add(key);
        uniqueResults.push(entry);
      });

      const selectedEntries = [];
      const selectedIndexSet = new Set();
      const buckets = [[], [], [], []];
      uniqueResults.forEach((entry, index) => {
        const seen = entry.domain ? seenDomains.has(entry.domain) : false;
        const preferred = isPreferredDomain(entry.domain);
        const bucketIndex = seen ? (preferred ? 2 : 3) : (preferred ? 0 : 1);
        buckets[bucketIndex].push({ entry, index });
      });

      for (const bucket of buckets) {
        for (const candidate of bucket) {
          if (selectedEntries.length >= 5) break;
          selectedEntries.push(candidate);
          selectedIndexSet.add(candidate.index);
        }
        if (selectedEntries.length >= 5) break;
      }

      if (selectedEntries.length < 5) {
        for (let i = 0; i < uniqueResults.length && selectedEntries.length < 5; i++) {
          if (selectedIndexSet.has(i)) continue;
          const entry = uniqueResults[i];
          selectedEntries.push({ entry, index: i });
          selectedIndexSet.add(i);
        }
      }

      if (selectedEntries.length && Math.random() < EXPLORATION_RATE) {
        const usedDomains = new Set(selectedEntries.map(se => se.entry.domain).filter(Boolean));
        const lastEntry = selectedEntries[selectedEntries.length - 1];
        const lastScore = lastEntry?.entry?.score ?? Infinity;
        const candidates = uniqueResults
          .map((entry, idx) => ({ entry, index: idx }))
          .filter(({ entry, index }) => {
            if (selectedIndexSet.has(index)) return false;
            if (entry.domain && usedDomains.has(entry.domain)) return false;
            if (!Number.isFinite(entry.score)) return false;
            if (!Number.isFinite(lastScore)) return true;
            return entry.score < lastScore;
          });
        if (candidates.length) {
          const freshCandidates = candidates.filter(({ entry }) => !entry.domain || !seenDomains.has(entry.domain));
          const pool = freshCandidates.length ? freshCandidates : candidates;
          let pick = pool[0];
          for (const option of pool) {
            if (option.entry.score < pick.entry.score) pick = option;
          }
          selectedIndexSet.delete(lastEntry.index);
          selectedEntries[selectedEntries.length - 1] = pick;
          selectedIndexSet.add(pick.index);
        }
      }

      const selected = selectedEntries.map(se => se.entry).filter(item => item && item.url);

      if (selected.length) {
        rememberSeenDomains(meta.sessionId, topic, selected.map(item => item.domain).filter(Boolean));
        sessionSearch.set(meta.sessionId, {
          topic,
          runId: run?.id || null,
          list: selected.map(r => ({ title: r.title || "", url: r.url, host: r.domain || null })),
          ts: Date.now()
        });
      }

      if (selected.length) {
        const lines = selected.map((r,i) => `#${i+1} — ${r.title || "(no title)"} (score ${formatScore(r.score)}) — ${r.url}`).join("\n");
        const msg = `Here are ${selected.length} sources:\n${lines}`;
        appendMessage(meta.sessionId, { role:"assistant", content: msg });
        ws.send(JSON.stringify({ type:"assistant_message", content: msg }));
        emitEventLog(ws, "list_posted", { runId: run?.id || null, items: selected.length, hosts: selected.map(item => item.domain || null) });
      } else {
        const pb = playbookFor(topic);
        const hint = (pb?.if_k0 && pb.if_k0.length) ? `Tried variants. Consider: ${pb.if_k0.slice(0,3).join(", ")}` : "Try adding org names or dates.";
        const msg = `I couldn't find credible sources for that query. ${hint}`;
        appendMessage(meta.sessionId, { role:"assistant", content: msg });
        ws.send(JSON.stringify({ type:"assistant_message", content: msg }));
      }

      // If not list-only, continue to model to pick best URL
      if (!/\b(find|show|list)\b.+\b(more|sites|sources|articles|links)\b/i.test(meta.requestText || "") && selected.length) {
        await callModelWithSearchResults(ws, meta, run);
      }
    } else {
      ws.send(JSON.stringify({ type:"error", error:"unsupported_tool" }));
    }
  } catch (e) {
    if (meta.spec.tool === "web_search") {
      recordSearch({
        userId: meta.userId, sessionId: meta.sessionId,
        topic: meta.topic || bucketTopic(meta.requestText||meta.spec.args.q),
        q_base: meta.spec.args.q, qlist: meta.spec.args.qlist || [],
        engine: "error", k: 0, latency_ms: 0, error: String(e)
      });
      recordEpisode({
        userId: meta.userId, sessionId: meta.sessionId,
        topic: meta.topic || bucketTopic(meta.requestText||meta.spec.args.q),
        success: false, note_saved: false, tokens_total: null, calls: { web_search:1, web_get:0 }
      });
      ws.send(JSON.stringify({ type:"learning_stats", stats: recentStats(20) }));
    }
    ws.send(JSON.stringify({ type:"call_error", call_id, error: String(e) }));
  }
}

async function callModelWithGetResult(ws, meta, run) {
  const { userId, sessionId } = meta;
  const profile = getUserProfile(userId);
  const systemPrompt = buildSystemPrompt(profile);
  const recent = getRecentMessages(sessionId, 2);
  const cap = (s, n) => (String(s||"").length > n ? String(s).slice(0,n) : String(s||""));
  const doc = cap(run?.result?.text || "", MAX_PAGE_CHARS);

  const messages = [
    { role:"system", content: systemPrompt },
    ...recent,
    { role:"system", content: `CALLRESULT {"tool":"web_get","ref":"${run.id}","url":"${run.result_summary.url}","title":"${(run.result_summary.title||"").replace(/"/g,'\"')}","chars":${doc.length}}` },
    { role:"system", content: `DOC:\n${doc}` },
    { role:"user", content: "Write a 5-bullet summary of DOC. Start with the page title and include the URL in parentheses. If the content is evergreen, append a [[NOTE]] with ≤400-char summary and source ref." }
  ];

  const { content: completion, usage } = await callOpenAI(messages);
  const forced = enforceSummaryCompletionFormat(completion, run);
  handleAssistantResponse(ws, { completion: forced, usage, userId, sessionId });
}

async function callModelWithSearchResults(ws, meta, run) {
  const { userId, sessionId } = meta;
  const profile = getUserProfile(userId);
  const systemPrompt = buildSystemPrompt(profile);
  const recent = getRecentMessages(sessionId, 2);
  const results = JSON.stringify(run?.result?.results || []);

  const messages = [
    { role:"system", content: systemPrompt },
    ...recent,
    { role:"system", content: `CALLRESULT {"tool":"web_search","ref":"${run.id}","k":${run?.result_summary?.k || 0}}` },
    { role:"system", content: `RESULTS: ${results}` },
    { role:"user", content: "From RESULTS, pick the best single URL to open and propose exactly one [[CALL]] {\"tool\":\"web_get\",\"args\":{\"url\":\"...\"}}." }
  ];

  const { content: completion, usage } = await callOpenAI(messages);
  handleAssistantResponse(ws, { completion, usage, userId, sessionId });
}

function handleAssistantResponse(ws, { completion, usage, userId, sessionId }) {
  const { cleanText, memo, gap, evidence, kdn, call, note } = extractArtifactsTolerant(completion);
  if (usage) {
    ws.send(JSON.stringify({ type:"telemetry", usage }));
    if (usage.total_tokens && updateLastEpisode({ tokens_total: usage.total_tokens })) {
      ws.send(JSON.stringify({ type:"learning_stats", stats: recentStats(20) }));
    }
  }

  if (kdn) {
    try { ws.send(JSON.stringify({ type:"kdn", kdn: JSON.parse(kdn) })); } catch {}
  } else {
    const state = computeKDNFallback(cleanText, !!gap);
    ws.send(JSON.stringify({ type:"kdn", kdn: state }));
  }

  if (call) {
    let spec; try { spec = JSON.parse(call); } catch {}
    if (spec && (spec.tool === "web_get" || spec.tool === "web_search")) {
      executeTool(ws, { userId, sessionId, spec }, "auto");
      return;
    }
  }

  if (cleanText && cleanText.trim().length) {
    appendMessage(sessionId, { role: "assistant", content: cleanText });
    ws.send(JSON.stringify({ type: "assistant_message", content: cleanText }));
  }

  if (gap) {
    let gapObj; try { gapObj = JSON.parse(gap); } catch {}
    if (gapObj && gapObj.q && gapObj.next_probe) {
      const gap_id = "gap_" + Date.now();
      appendGap(userId, { gap_id, ...gapObj });
      ws.send(JSON.stringify({ type:"gap", gap: { ...gapObj, gap_id, status: "open" } }));
    }
  }

  if (note) {
    try {
      const n = JSON.parse(note);
      if (typeof n.topic === "string" && typeof n.summary === "string") {
        const saved = appendNote(userId, {
          note_id: "note_" + Date.now(),
          topic: n.topic.slice(0,120),
          summary: n.summary.slice(0,600),
          source: n.source || null
        });
        ws.send(JSON.stringify({ type:"note_saved", note: { topic: saved.topic } }));
        if (updateLastEpisode({ note_saved: true })) {
          ws.send(JSON.stringify({ type:"learning_stats", stats: recentStats(20) }));
        }
      }
    } catch {}
  }
}

async function callOpenAI(messages) {
  const body = { model: OPENAI_MODEL, messages, temperature: 0.2 };
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content ?? "";
  return { content, usage: json.usage || null };
}

// tolerant extractor: accepts '[[CALL]] web_search { ... }' and tail tags
function extractArtifactsTolerant(text) {
  const out = { memo:null, gap:null, evidence:null, kdn:null, call:null, note:null };
  let clean = String(text || "");

  const tailRe = /\s*\[\[(KDN|MEMO|GAP|EVIDENCE|CALL|NOTE)\]\]\s*({[\s\S]*?})\s*$/;
  let m;
  while ((m = clean.match(tailRe))) {
    const tag = m[1], payload = m[2];
    if (tag === "MEMO" && !out.memo) out.memo = payload;
    if (tag === "GAP" && !out.gap) out.gap = payload;
    if (tag === "EVIDENCE" && !out.evidence) out.evidence = payload;
    if (tag === "KDN" && !out.kdn) out.kdn = payload;
    if (tag === "CALL" && !out.call) out.call = payload;
    if (tag === "NOTE" && !out.note) out.note = payload;
    clean = clean.slice(0, m.index).trim();
  }
  if (!out.call) {
    const vm = clean.match(/\[\[CALL\]\][^\S\n]*(?:web_\w+)\s*(\{[\s\S]*?\})/);
    if (vm) out.call = vm[1];
  }
  return { cleanText: clean.trim(), ...out };
}

function computeKDNFallback(cleanText, hasGap) {
  const t = (cleanText || "").trim().toLowerCase();
  if (hasGap) return { state:"DK", reason:"emitted GAP", ambiguous:true };
  if (t === "unknown with current context." || t === "unknown with current context")
    return { state:"DK", reason:"explicit unknown", ambiguous:false };
  if (!t) return { state:"DK", reason:"no visible answer", ambiguous:true };
  return { state:"KNOWN", reason:"answered without GAP", ambiguous:false };
}

function enforceSummaryCompletionFormat(completion, run) {
  const artifacts = extractArtifactsTolerant(completion);
  const formatted = enforceSummaryText(artifacts.cleanText, run);
  return appendArtifacts(formatted, artifacts);
}

function appendArtifacts(base, artifacts) {
  const order = [
    ["memo", "MEMO"],
    ["gap", "GAP"],
    ["evidence", "EVIDENCE"],
    ["kdn", "KDN"],
    ["call", "CALL"],
    ["note", "NOTE"]
  ];
  let out = base;
  for (const [key, tag] of order) {
    const payload = artifacts[key];
    if (!payload) continue;
    if (out.length && !out.endsWith("\n")) out += "\n";
    out += `[[${tag}]] ${payload}`;
  }
  return out;
}

function enforceSummaryText(raw, run) {
  const text = String(raw || "");
  const title = sanitizeSummaryTitle(run?.result_summary?.title || run?.result?.title || "");
  const url = (run?.result_summary?.url || run?.result?.url || run?.spec?.args?.url || "").trim() || "unknown";
  const header = `**${title || "Untitled"}** (${url})`;
  const bullets = extractBulletLines(text);
  const limited = bullets.slice(0, 5).map(line => limitWords(line, 20));
  while (limited.length < 5) limited.push("");
  const sanitized = limited.map(sanitizeBulletText);
  while (sanitized.length < 5) sanitized.push("Detail unavailable.");
  const normalized = sanitized.map(finalizeBulletText);
  const bulletLines = normalized.map(line => `- ${line}`);
  return [header, ...bulletLines].join("\n");
}

function sanitizeSummaryTitle(title) {
  const safe = String(title || "").trim();
  if (!safe) return "Untitled";
  return safe.replace(/[\r\n]+/g, " ");
}

function extractBulletLines(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const bullets = [];
  const seen = new Set();
  const pushLine = (line) => {
    const clean = line.replace(/\s+/g, " ").trim();
    if (!clean || seen.has(clean.toLowerCase())) return;
    seen.add(clean.toLowerCase());
    bullets.push(clean);
  };
  for (const line of lines) {
    if (/^\[\[(?:MEMO|GAP|EVIDENCE|KDN|CALL|NOTE)\]\]/i.test(line)) continue;
    const bulletMatch = line.match(/^(?:[-*•]\s+|\d+[\).]\s+)(.+)$/);
    if (bulletMatch) {
      pushLine(bulletMatch[1]);
    }
  }
  if (bullets.length < 5) {
    for (const line of lines) {
      if (/^\[\[(?:MEMO|GAP|EVIDENCE|KDN|CALL|NOTE)\]\]/i.test(line)) continue;
      const stripped = line.replace(/^(?:[-*•]\s+|\d+[\).]\s+)/, "");
      pushLine(stripped);
      if (bullets.length >= 5) break;
    }
  }
  if (bullets.length < 5) {
    const sentences = text
      .replace(/\[\[(?:MEMO|GAP|EVIDENCE|KDN|CALL|NOTE)\]\][^]+$/i, "")
      .split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      const clean = sentence.trim();
      if (!clean) continue;
      pushLine(clean);
      if (bullets.length >= 5) break;
    }
  }
  return bullets;
}

function limitWords(text, maxWords) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(" ");
}

function sanitizeBulletText(text) {
  let cleaned = String(text || "");
  cleaned = cleaned.replace(/\[\[(?:MEMO|GAP|EVIDENCE|KDN|CALL|NOTE)\]\][\s\S]*$/i, "");
  cleaned = cleaned.replace(/[\r\n]+/g, " ");
  cleaned = cleaned.replace(/^(?:[-*•]\s+|\d+[\).]\s+)/, "");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  cleaned = stripHedging(cleaned);
  cleaned = limitWords(cleaned, 20).trim();
  cleaned = cleaned.replace(/\s*[,;:]$/, "");
  if (!cleaned) return "Detail unavailable.";
  return cleaned;
}

function stripHedging(text) {
  let out = String(text || "").trim();
  out = out.replace(/^(?:maybe|perhaps|possibly|probably|likely)\b[\s,]*/i, "");
  out = out.replace(/^(?:it\s+(?:seems|appears|may|might|could|probably|possibly))\b[\s,]*/i, "");
  out = out.replace(/^(?:seems|appears)\b[\s,]*/i, "");
  out = out.replace(/^(?:overall|generally|in general)\b[\s,]*/i, "");
  return out.replace(/\s+/g, " ").trim();
}

function finalizeBulletText(text) {
  let line = String(text || "").trim().replace(/\s+/g, " ");
  if (!line) line = "Detail unavailable.";
  line = limitWords(line, 20).trim();
  line = line.replace(/\s*[,;:]$/, "");
  if (!line) line = "Detail unavailable.";
  if (line.length) {
    line = line.charAt(0).toUpperCase() + line.slice(1);
  }
  if (!/[.!?]$/.test(line)) {
    line += ".";
  }
  return line;
}
