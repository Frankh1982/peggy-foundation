import "dotenv/config";
import fs from "fs";
import path from "path";
import http from "http";
import express from "express";
import { createHash } from "crypto";
import { EventEmitter } from "events";
import { WebSocketServer } from "ws";
import { buildSystemPrompt } from "./prompt.js";
import { getUserProfile, updateUserProfile, appendMessage, getRecentMessages, appendGap, closeGap } from "./memory.js";
import { tool_web_get, tool_web_search, saveRunRecord } from "./tools.js";
import { bucketTopic, recordSearch, recordFetch, recordEpisode, recentStats, buildQueryList, playbookFor, updateBandit, updateLastEpisode } from "./learn.js";
import { ConceptCard, inferConceptKey, inferConceptMetadata, normalizeConceptKey, normalizeTopic, normalizeTopicKey, writeCard, updateIndex, readAllCards, getTopByTopic, touch, scoreImportance, shouldSave, isStale, reindexTopicKeys, twoSentenceFromNotes, extractFacetsFromNotes, getConcept, getLinkedNotes, getConceptSignature, scoreAnalogy, writeAnalogyCard, computeNoteFingerprint, simhashDistance, canonicalizeFacet, buildAnalogyQuery } from "./cards.js";
import { maybeBridge } from "../lib/bridge.js";

const PORT = process.env.PORT || 8787;
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const envRecent = (process.env.RECENT_N ?? "").trim();
const envDocCap = (process.env.MAX_PAGE_CHARS ?? "").trim();
const RECENT_N = Math.max(0, Number(envRecent || 3));
const MAX_PAGE_CHARS = Math.max(0, Number(envDocCap || 8000));
const CALL_POLICY = (process.env.CALL_POLICY || "auto").trim().toLowerCase();
const envFreshTtl = (process.env.FRESH_TTL_DAYS ?? "").trim();
const FRESH_TTL_DAYS = (() => {
  const num = Number(envFreshTtl);
  if (Number.isFinite(num) && num > 0) return num;
  return 7;
})();
const envAutoSearchTurn = (process.env.MAX_AUTO_SEARCHES_PER_TURN ?? "").trim();
const envAutoNotesSession = (process.env.MAX_AUTO_NOTES_PER_SESSION ?? "").trim();
const MAX_AUTO_SEARCHES_PER_TURN = (() => {
  const num = Number(envAutoSearchTurn);
  if (!Number.isFinite(num) || num < 0) return 1;
  return Math.max(0, Math.floor(num));
})();
const MAX_AUTO_NOTES_PER_SESSION = (() => {
  const num = Number(envAutoNotesSession);
  if (!Number.isFinite(num) || num < 0) return 3;
  return Math.max(0, Math.floor(num));
})();
const envAutoLearn = (process.env.AUTO_LEARN ?? "").trim();
const AUTO_LEARN_ENABLED = envAutoLearn === "1";
const envMinWriteScore = (process.env.MIN_WRITE_SCORE ?? "").trim();
const MIN_WRITE_SCORE = (() => {
  const numeric = Number(envMinWriteScore);
  if (Number.isFinite(numeric)) {
    if (numeric <= 0) return 0;
    if (numeric >= 1) return 1;
    return numeric;
  }
  return 0.6;
})();
const envMinQueryLen = (process.env.MIN_QUERY_LEN ?? "").trim();
const MIN_QUERY_LEN = (() => {
  const numeric = Number(envMinQueryLen);
  if (!Number.isFinite(numeric) || numeric <= 0) return 3;
  return Math.min(8, Math.max(1, Math.floor(numeric)));
})();
const NORMALIZE_QUOTES = (process.env.NORMALIZE_QUOTES || "").trim() === "1";
const STRICT_FOLLOWUP = (process.env.STRICT_FOLLOWUP || "").trim() === "1";
const RESET_OFFSET_ON_TOPIC_CHANGE = (process.env.RESET_OFFSET_ON_TOPIC_CHANGE || "").trim() === "1";
const POLITICAL_NEWS_ALLOWED = (process.env.POLITICAL_NEWS_ALLOWED || "").trim() === "1";
const VOTER_INFO_ONLY_GATE = (process.env.VOTER_INFO_ONLY_GATE || "").trim() === "1";
const envLearnCooldown = (process.env.LEARN_COOLDOWN_HOURS ?? "").trim();
const LEARN_COOLDOWN_HOURS = (() => {
  const numeric = Number(envLearnCooldown);
  if (!Number.isFinite(numeric) || numeric < 0) return 4;
  return Math.min(24, Math.max(0, numeric));
})();
const envLearnBudget = (process.env.LEARN_BUDGET_PER_DAY ?? "").trim();
const LEARN_BUDGET_PER_DAY = (() => {
  const numeric = Number(envLearnBudget);
  if (!Number.isFinite(numeric) || numeric < 0) return 12;
  return Math.min(100, Math.max(0, Math.floor(numeric)));
})();

const NEWS_ALLOWLIST = parseHostList(process.env.NEWS_ALLOWLIST || "");
const NEWS_DOWNRANK = parseHostList(process.env.NEWS_DOWNRANK || "");
const OFFICIAL_PR_DOMAINS = parseHostList(process.env.OFFICIAL_PR_DOMAINS || process.env.PR_ALLOWLIST || "");
const FOLLOWUP_KEYWORD_REGEX = /^(?:find\s+more(?:\s+(?:sites?|sources?|links?|stories))?|more(?:\s+(?:sites?|sources?|links?|stories))?|more)$/i;
const AUTO_RESEARCH_CONFIG = {
  max_searches_per_turn: MAX_AUTO_SEARCHES_PER_TURN,
  max_notes_per_session: MAX_AUTO_NOTES_PER_SESSION,
  note_confidence: 0.6,
  note_ttl_days: 30
};
const PEG_BUILD = "2025-10-04-v3j-learn";
const DEFAULT_SOURCE_PRIOR = 0.45;
const SCORE_PRIOR_WEIGHT = 0.45;
const SCORE_RECENCY_WEIGHT = 0.55;
const RECENCY_FALLBACK = 0.6;
const SOURCE_PRIORS = loadSourcePriors();
const DOMAIN_PREFS = loadDomainPrefs();
const SEEN_HOST_TTL = 15 * 60 * 1000;
const TELEMETRY_FILE = path.resolve("data", "events.jsonl");
const WATCHLIST_FILE = path.resolve("data", "watchlist.jsonl");
const SEEN_HOST_STORE_FILE = path.resolve("data", "seen_hosts.json");
const FRESH_CUE_REGEX = /\b(latest|breaking|today|tonight|this\s*week|refresh)\b|\bupdate\b.*\b(now|today)\b|\b(now|today)\b.*\bupdate\b/i;
const TWO_SENTENCE_REGEX = /\b(?:two|2)[-\s]?sentence\b/i;

const envAnalogyMinScore = (process.env.ANALOGY_MIN_SCORE ?? "").trim();
const ANALOGY_MIN_SCORE = (() => {
  const num = Number(envAnalogyMinScore);
  if (Number.isFinite(num)) {
    if (num <= 0) return 0;
    if (num >= 1) return 1;
    return num;
  }
  return 0.45;
})();
const ANALOGY_NOTE_LIMIT = 5;
const envAutoAnalogy = (process.env.AUTO_ANALOGY ?? "").trim();
const AUTO_ANALOGY_ENABLED = envAutoAnalogy === "1";
const envAnalogyMinNotes = (process.env.ANALOGY_MIN_NOTES_PER_CONCEPT ?? "").trim();
const ANALOGY_MIN_NOTES_PER_CONCEPT = (() => {
  const num = Number(envAnalogyMinNotes);
  if (Number.isFinite(num) && num > 0) {
    return Math.floor(num);
  }
  return 1;
})();
const envAnalogyMaxDaily = (process.env.ANALOGY_MAX_PROPOSALS_PER_DAY ?? "").trim();
const ANALOGY_MAX_PROPOSALS_PER_DAY = (() => {
  const num = Number(envAnalogyMaxDaily);
  if (Number.isFinite(num) && num > 0) {
    return Math.floor(num);
  }
  return 0;
})();
const ANALOGY_AUTO_STATE = { dateKey: "", total: 0 };
const ANALOGY_CONCEPT_DAILY = new Map();
const ANALOGY_LATEST_WINDOW_MS = 10 * 60 * 1000;

const NOTE_DEMOTE_INTERVAL_MS = 5 * 60 * 1000;
const SIMHASH_DUP_THRESHOLD = 6;

const demotedNotes = new Set();
const conceptLearningStats = new Map();
let conceptTurnCounter = 0;

const cardsDirPath = path.resolve("data", "cards");
const indexDirPath = path.resolve("data", "index");
fs.mkdirSync(cardsDirPath, { recursive: true });
fs.mkdirSync(indexDirPath, { recursive: true });
fs.mkdirSync(path.dirname(TELEMETRY_FILE), { recursive: true });
if (!fs.existsSync(TELEMETRY_FILE)) fs.writeFileSync(TELEMETRY_FILE, "");
if (!fs.existsSync(WATCHLIST_FILE)) fs.writeFileSync(WATCHLIST_FILE, "");
if (!fs.existsSync(SEEN_HOST_STORE_FILE)) {
  fs.writeFileSync(SEEN_HOST_STORE_FILE, JSON.stringify({ topics: {} }, null, 2));
}
const cardWriteLogFile = path.join(cardsDirPath, "CardWriteLog.jsonl");
if (!fs.existsSync(cardWriteLogFile)) {
  fs.writeFileSync(cardWriteLogFile, "");
}
const conceptEdgesFile = path.join(cardsDirPath, "edges.jsonl");
if (!fs.existsSync(conceptEdgesFile)) {
  fs.writeFileSync(conceptEdgesFile, "");
}

function loadSeenHostStore() {
  try {
    const raw = fs.readFileSync(SEEN_HOST_STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { topics: {} };
    }
    const topics = parsed.topics && typeof parsed.topics === "object" ? parsed.topics : {};
    for (const [key, entry] of Object.entries(topics)) {
      if (!entry || typeof entry !== "object") {
        topics[key] = { hosts: [], offset: 0, updated_at: 0 };
        continue;
      }
      const list = Array.isArray(entry.hosts) ? entry.hosts : [];
      const deduped = Array.from(new Set(list.map(value => String(value || "").toLowerCase()).filter(Boolean)));
      topics[key] = {
        hosts: deduped,
        offset: Number(entry.offset) || deduped.length,
        updated_at: Number(entry.updated_at) || 0
      };
    }
    return { topics };
  } catch {
    return { topics: {} };
  }
}

const persistentSeenHosts = loadSeenHostStore();

function persistSeenHostStore() {
  try {
    fs.writeFileSync(SEEN_HOST_STORE_FILE, JSON.stringify(persistentSeenHosts, null, 2));
  } catch (err) {
    console.warn("seen_host_store_write_failed", err);
  }
}

function parseHostList(raw) {
  if (!raw) return new Set();
  const values = Array.isArray(raw)
    ? raw
    : String(raw)
        .split(/[,\s]+/)
        .map(value => value.trim().toLowerCase())
        .filter(Boolean);
  return new Set(values);
}

function normalizeSmartQuotes(text) {
  if (!text) return "";
  return String(text)
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’‹›]/g, "'");
}

function sanitizeQuery(value) {
  let query = typeof value === "string" ? value : String(value || "");
  if (NORMALIZE_QUOTES) {
    query = normalizeSmartQuotes(query);
  }
  query = query.replace(/[\s\u00A0]+/g, " ").trim();
  return query;
}

function queryTokenLength(query) {
  if (!query) return 0;
  return query.replace(/[^A-Za-z0-9]+/g, "").length;
}

function isMeaningfulQuery(query) {
  if (!query) return false;
  if (queryTokenLength(query) >= MIN_QUERY_LEN) return true;
  return false;
}

function inferSearchIntent(rawText = "", query = "") {
  const haystack = `${String(rawText || "")} ${String(query || "")}`.toLowerCase();
  if (/press[-\s]?release|deal announcement|acquisition|merger|buyout|takeover|joint venture/.test(haystack)) {
    return "press_release";
  }
  if (/earnings call|quarterly results|financial guidance/.test(haystack)) {
    return "earnings";
  }
  if (/vote|voting|register to vote|polling place|ballot|absentee/.test(haystack)) {
    return "voter_info";
  }
  if (/election|campaign|president|senate|tariff|policy|congress|white house|prime minister|minister|parliament/.test(haystack)) {
    return "political_news";
  }
  return "";
}

function evaluatePolicyGate(rawText = "", query = "") {
  const intent = inferSearchIntent(rawText, query);
  if (intent === "voter_info" && VOTER_INFO_ONLY_GATE) {
    return { blocked: true, reason: "voter_info", intent };
  }
  if (intent === "political_news" && !POLITICAL_NEWS_ALLOWED) {
    return { blocked: true, reason: "political_news", intent };
  }
  return { blocked: false, reason: intent, intent };
}

function getPersistentSeenHosts(topicKey) {
  const normalized = normalizeTopicKey(topicKey || "", "news");
  if (!normalized) {
    return { hosts: new Set(), offset: 0 };
  }
  const entry = persistentSeenHosts.topics[normalized];
  const hosts = new Set(Array.isArray(entry?.hosts) ? entry.hosts : []);
  const offset = Number(entry?.offset);
  return {
    hosts,
    offset: Number.isFinite(offset) ? offset : hosts.size
  };
}

function updatePersistentSeenHosts(topicKey, hosts = []) {
  const normalized = normalizeTopicKey(topicKey || "", "news");
  if (!normalized) return;
  if (!persistentSeenHosts.topics[normalized]) {
    persistentSeenHosts.topics[normalized] = { hosts: [], offset: 0, updated_at: 0 };
  }
  const entry = persistentSeenHosts.topics[normalized];
  const existing = new Set(Array.isArray(entry.hosts) ? entry.hosts : []);
  let changed = false;
  for (const host of hosts || []) {
    const clean = String(host || "").trim().toLowerCase();
    if (!clean) continue;
    if (!existing.has(clean)) {
      existing.add(clean);
      changed = true;
    }
  }
  if (!changed) {
    return;
  }
  entry.hosts = Array.from(existing);
  entry.offset = entry.hosts.length;
  entry.updated_at = Date.now();
  persistentSeenHosts.topics[normalized] = entry;
  persistSeenHostStore();
}

function logTelemetryEvent(event) {
  if (!event || typeof event !== "object") return;
  const record = { ...event };
  if (!Number.isFinite(record.ts)) {
    record.ts = Date.now();
  }
  try {
    fs.appendFileSync(TELEMETRY_FILE, JSON.stringify(record) + "\n");
  } catch (err) {
    console.warn("telemetry_append_failed", err);
  }
}

function appendWatchEvent(event) {
  if (!event || typeof event !== "object") return;
  const payload = { ...event };
  if (!payload.ts) payload.ts = Date.now();
  try {
    fs.appendFileSync(WATCHLIST_FILE, JSON.stringify(payload) + "\n");
  } catch (err) {
    console.warn("watchlist_append_failed", err);
  }
}

function addWatch(entity, reason, extras = {}) {
  const raw = String(entity || "").trim();
  if (!raw) return;
  const topicKey = normalizeTopicKey(raw, "news") || raw;
  const record = {
    type: "add",
    entity: topicKey,
    reason: reason || "unknown",
    topicKey,
    context: extras?.context || null
  };
  appendWatchEvent(record);
}

function resolveWatch(entity, cardId) {
  const raw = String(entity || "").trim();
  if (!raw) return;
  const topicKey = normalizeTopicKey(raw, "news") || raw;
  const record = {
    type: "resolve",
    entity: topicKey,
    topicKey,
    cardId: cardId || null
  };
  appendWatchEvent(record);
}

migrateLegacyCardData();
reindexTopicKeys();

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
const sessionTopicSeenHosts = new Map();
const sessionLastSummary = new Map();
const sessionLastList = new Map();
const sessionLastSavedNote = new Map();
const sessionNoteLists = new Map();
const sessionConceptSuggestionCooldown = new Map();
const sessionAutoResearchContext = new Map();
const sessionAutoResearchNoteCount = new Map();
const sessionAutoResearchSearchCount = new Map();
const sessionLastKdnState = new Map();
const sessionConceptSuggestions = new Map();
const sessionAnalogyProposals = new Map();
const sessionTopicTracker = new Map();
const pendingAnalogyTimers = new Map();
const sessionStateStore = new Map();
const newsCardCooldown = new Map();
const newsCardDaily = { dateKey: "", total: 0 };

export const inspector = new EventEmitter();

const TOPIC_COMMAND_PREFIX_RE = /^(?:\s*(?:save|link|promote)\s+(?:note|concept)|\s*notes?)\b/i;

function refreshNoteDemotions() {
  try {
    const all = readAllCards();
    const now = Date.now();
    const active = new Set();
    for (const card of all) {
      if (!card || card.type !== "note" || !card.id) continue;
      const stale = isStale(card, FRESH_TTL_DAYS, now);
      if (stale) {
        active.add(card.id);
      }
    }
    demotedNotes.clear();
    for (const id of active) demotedNotes.add(id);
  } catch (err) {
    console.error("note_demote_refresh_error", err);
  }
}

refreshNoteDemotions();
const demoteInterval = setInterval(refreshNoteDemotions, NOTE_DEMOTE_INTERVAL_MS);
if (typeof demoteInterval.unref === "function") demoteInterval.unref();

function isNoteDemoted(noteId) {
  const clean = String(noteId || "").trim();
  if (!clean) return false;
  return demotedNotes.has(clean);
}

function ensureConceptEntry(key) {
  let entry = conceptLearningStats.get(key);
  if (!entry) {
    entry = { window: [], lastTurn: 0, paused: false, totals: { used: 0, saved: 0 } };
    conceptLearningStats.set(key, entry);
  }
  return entry;
}

function appendZeroTurns(entry, fromTurn, toTurn) {
  if (!entry || toTurn <= fromTurn) return;
  for (let t = fromTurn + 1; t <= toTurn; t += 1) {
    entry.window.push({ used: 0, saved: 0 });
    if (entry.window.length > 20) entry.window.shift();
  }
}

function finalizeConceptTurn(ws, turnStats, tokenMeter) {
  conceptTurnCounter += 1;
  const currentTurn = conceptTurnCounter;
  for (const [rawKey, stats] of turnStats.entries()) {
    const normalizedKey = normalizeConceptKey(rawKey);
    if (!normalizedKey) continue;
    const entry = ensureConceptEntry(normalizedKey);
    appendZeroTurns(entry, entry.lastTurn, currentTurn - 1);
    const used = Number(stats?.used || 0);
    const saved = Number(stats?.saved || 0);
    entry.window.push({ used, saved });
    if (entry.window.length > 20) entry.window.shift();
    entry.lastTurn = currentTurn;
  }

  for (const [key, entry] of conceptLearningStats.entries()) {
    if (entry.lastTurn === currentTurn) continue;
    appendZeroTurns(entry, entry.lastTurn, currentTurn - 1);
    entry.window.push({ used: 0, saved: 0 });
    if (entry.window.length > 20) entry.window.shift();
    entry.lastTurn = currentTurn;
  }

  for (const [key, entry] of conceptLearningStats.entries()) {
    const totals = entry.window.reduce((acc, record) => {
      acc.used += Number(record?.used || 0);
      acc.saved += Number(record?.saved || 0);
      return acc;
    }, { used: 0, saved: 0 });
    entry.totals = totals;
    const ratio = totals.saved > 0 ? totals.used / totals.saved : 1;
    const below = totals.saved > 0 && ratio < 0.3;
    const above = totals.saved === 0 || ratio >= 0.35;
    if (below && !entry.paused) {
      entry.paused = true;
      if (ws) emitEventLog(ws, "auto_learn_paused", { key, reason: "low_utility" });
    } else if (entry.paused && above) {
      entry.paused = false;
    }
  }

  if (ws && tokenMeter) {
    if (tokenMeter.concept > 0) {
      emitEventLog(ws, "tokens_saved", { via: "concept", tokens_saved: Math.round(tokenMeter.concept) });
    }
    if (tokenMeter.search > 0) {
      emitEventLog(ws, "tokens_saved", { via: "search", tokens_saved: Math.round(tokenMeter.search) });
    }
  }
}

function isConceptAutoWritePaused(key) {
  const normalizedKey = normalizeConceptKey(key);
  if (!normalizedKey) return false;
  const entry = conceptLearningStats.get(normalizedKey);
  return Boolean(entry?.paused);
}

function topicToSearchPhrase(topic) {
  const raw = String(topic || "").trim();
  if (!raw) return "";
  const colon = raw.indexOf(":");
  const body = colon >= 0 ? raw.slice(colon + 1) : raw;
  const cleaned = body.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.split("/").map(part => part.trim()).filter(Boolean).join(" ");
}

const TOPIC_TOKEN_TITLE_OVERRIDES = new Map([
  ["ai", "AI"],
  ["usa", "USA"],
  ["us", "US"],
  ["uk", "UK"],
  ["eu", "EU"],
  ["nasa", "NASA"],
  ["nvidia", "NVIDIA"],
  ["amd", "AMD"],
  ["ibm", "IBM"],
  ["ftx", "FTX"],
  ["gpt", "GPT"],
  ["openai", "OpenAI"],
  ["google", "Google"],
  ["meta", "Meta"],
  ["tesla", "Tesla"]
]);

function detokenizeTopicKey(topicKey) {
  const raw = String(topicKey || "").trim();
  if (!raw) return "";
  return raw.split(/[\s/]+/).map(token => {
    const mapped = TOPIC_TOKEN_TITLE_OVERRIDES.get(token);
    if (mapped) return mapped;
    if (/^[a-z]{1,3}$/.test(token)) return token.toUpperCase();
    return token.charAt(0).toUpperCase() + token.slice(1);
  }).join(" ");
}

const TOPIC_PREFIX_PATTERN = /^[a-z]{3,10}:/i;

function preferBucketedTopicLabel(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return "";
  if (TOPIC_PREFIX_PATTERN.test(raw)) return raw;
  return bucketTopic(raw);
}

function resolveListTopicLabel(sessionId, storedList, fallbackText) {
  const candidates = [];
  if (storedList) {
    const storedTopic = typeof storedList.topic === "string" ? storedList.topic.trim() : "";
    if (storedTopic) candidates.push(storedTopic);
    const normalizedTopic = preferBucketedTopicLabel(storedList.normalizedTopic);
    if (normalizedTopic) candidates.push(normalizedTopic);
    const reuseTopic = preferBucketedTopicLabel(storedList.queryForReuse);
    if (reuseTopic) candidates.push(reuseTopic);
  }
  const lastCtx = getLastListContext(sessionId);
  if (lastCtx) {
    const lastTopic = preferBucketedTopicLabel(lastCtx.lastTopicKey);
    if (lastTopic) candidates.push(lastTopic);
  }
  const fallback = preferBucketedTopicLabel(fallbackText);
  if (fallback) candidates.push(fallback);
  for (const value of candidates) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) return trimmed;
  }
  return "";
}

function normalizeListItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map(item => {
    const url = item?.url ? String(item.url).trim() : "";
    const title = item?.title ? String(item.title).trim() : "";
    const host = item?.host ? String(item.host).trim() : null;
    const normalized = { title, url };
    if (host) normalized.host = host;
    return normalized;
  });
}

function getSessionTopicRecord(sessionId) {
  const emptySlots = () => ({ key: null, ts: 0 });
  const makeRecord = () => ({
    active: null,
    lastList: emptySlots(),
    lastConcept: emptySlots(),
    lastAuto: emptySlots()
  });
  if (!sessionId) return makeRecord();
  let record = sessionTopicTracker.get(sessionId);
  if (!record) {
    record = makeRecord();
    sessionTopicTracker.set(sessionId, record);
  } else {
    if (!record.lastList || typeof record.lastList !== "object") {
      const legacy = typeof record.lastList === "string" ? record.lastList.trim() : "";
      record.lastList = legacy ? { key: legacy, ts: 0 } : emptySlots();
    }
    if (!record.lastConcept || typeof record.lastConcept !== "object") {
      const legacy = typeof record.lastConcept === "string" ? record.lastConcept.trim() : "";
      record.lastConcept = legacy ? { key: legacy, ts: 0 } : emptySlots();
    }
    if (!record.lastAuto || typeof record.lastAuto !== "object") {
      const legacy = typeof record.lastAuto === "string" ? record.lastAuto.trim() : "";
      record.lastAuto = legacy ? { key: legacy, ts: 0 } : emptySlots();
    }
    if (record.active !== null && typeof record.active !== "string") {
      record.active = String(record.active || "").trim() || null;
    }
  }
  return record;
}

function getSessionState(sessionId) {
  if (!sessionId) {
    return { currentTopic: "", lastList: null, lastSummary: null };
  }
  let state = sessionStateStore.get(sessionId);
  if (!state) {
    state = { currentTopic: "", lastList: null, lastSummary: null };
    sessionStateStore.set(sessionId, state);
  }
  if (typeof state.currentTopic !== "string") {
    state.currentTopic = state.currentTopic ? String(state.currentTopic) : "";
  }
  return state;
}

function getActiveTopicKey(sessionId) {
  if (!sessionId) return "";
  const record = getSessionTopicRecord(sessionId);
  const raw = typeof record?.active === "string" ? record.active.trim() : "";
  if (!raw) return "";
  const normalized = normalizeTopicKey(raw, "news");
  if (normalized) return normalized;
  return "";
}

function toConceptKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const colonIdx = raw.indexOf(":");
  const body = colonIdx >= 0 ? raw.slice(colonIdx + 1) : raw;
  return normalizeConceptKey(body);
}

function updateSessionTopicLastList(sessionId, { topicKey = "", query = "" } = {}) {
  if (!sessionId) return;
  const record = getSessionTopicRecord(sessionId);
  let finalKey = toConceptKey(topicKey);
  if (!finalKey) {
    const candidate = String(query || "").trim();
    if (candidate && !TOPIC_COMMAND_PREFIX_RE.test(candidate)) {
      const normalizedTopicKey = normalizeTopicKey(candidate, "news");
      finalKey = toConceptKey(normalizedTopicKey);
    }
  }
  if (!finalKey) return;
  const now = Date.now();
  record.lastList = { key: finalKey, ts: now };
  record.active = finalKey;
  const sessionState = getSessionState(sessionId);
  sessionState.lastList = { key: finalKey, query: String(query || ""), ts: now };
  sessionState.currentTopic = finalKey;
}

function updateSessionTopicLastConcept(sessionId, key) {
  if (!sessionId) return;
  const conceptKey = toConceptKey(key);
  if (!conceptKey) return;
  const record = getSessionTopicRecord(sessionId);
  const now = Date.now();
  record.lastConcept = { key: conceptKey, ts: now };
  record.active = conceptKey;
  const sessionState = getSessionState(sessionId);
  sessionState.currentTopic = conceptKey;
}

function updateSessionTopicLastAuto(sessionId, key) {
  if (!sessionId) return;
  const conceptKey = toConceptKey(key);
  if (!conceptKey) return;
  const record = getSessionTopicRecord(sessionId);
  record.lastAuto = { key: conceptKey, ts: Date.now() };
  const sessionState = getSessionState(sessionId);
  if (!sessionState.currentTopic) {
    sessionState.currentTopic = conceptKey;
  }
}

function setLastListContext(sessionId, { topicKey, qBase, items }) {
  if (!sessionId) return;
  const lastQBase = String(qBase || "").trim();
  let canonicalTopicKey = "";
  for (const candidate of [topicKey, lastQBase]) {
    if (!candidate) continue;
    const normalized = normalizeTopicKey(candidate, "news");
    if (normalized) {
      canonicalTopicKey = normalized;
      break;
    }
  }
  const listItems = normalizeListItems(items);
  sessionLastList.set(sessionId, {
    lastTopicKey: canonicalTopicKey,
    lastQBase,
    lastList: {
      items: listItems,
      ts: Date.now()
    }
  });
  updateSessionTopicLastList(sessionId, { topicKey: canonicalTopicKey, query: lastQBase });
  const sessionState = getSessionState(sessionId);
  sessionState.lastList = {
    key: canonicalTopicKey || "",
    query: lastQBase,
    items: listItems,
    ts: Date.now()
  };
  if (canonicalTopicKey) {
    sessionState.currentTopic = canonicalTopicKey;
  }
}

function getLastListContext(sessionId) {
  if (!sessionId) return null;
  return sessionLastList.get(sessionId) || null;
}

function rememberLastSavedNoteId(sessionId, noteId) {
  if (!sessionId) return;
  const cleanId = String(noteId || "").trim();
  if (!cleanId) return;
  sessionLastSavedNote.set(sessionId, { noteId: cleanId, ts: Date.now() });
}

function getLastSavedNoteId(sessionId) {
  if (!sessionId) return null;
  const entry = sessionLastSavedNote.get(sessionId);
  if (!entry || !entry.noteId) return null;
  return entry.noteId;
}

function setLastNoteList(sessionId, entries, { context = "" } = {}) {
  if (!sessionId) return;
  const normalized = Array.isArray(entries)
    ? entries
        .map(entry => {
          const noteId = String(entry?.noteId || entry?.id || entry || "").trim();
          if (!noteId) return null;
          return { noteId };
        })
        .filter(Boolean)
    : [];
  if (!normalized.length) {
    sessionNoteLists.delete(sessionId);
    return;
  }
  sessionNoteLists.set(sessionId, {
    entries: normalized,
    context: String(context || "").trim(),
    ts: Date.now()
  });
}

function getLastNoteList(sessionId) {
  if (!sessionId) return null;
  const record = sessionNoteLists.get(sessionId);
  if (!record || !Array.isArray(record.entries) || !record.entries.length) return null;
  const maxAgeMs = 15 * 60 * 1000;
  if (Number.isFinite(record.ts) && Date.now() - record.ts > maxAgeMs) {
    sessionNoteLists.delete(sessionId);
    return null;
  }
  return record;
}

function registerSuggestionCooldown(sessionId, { noteId, conceptKey }) {
  if (!sessionId) return;
  const cleanId = String(noteId || "").trim();
  const normalizedKey = normalizeConceptKey(conceptKey);
  if (!cleanId || !normalizedKey) return;
  sessionConceptSuggestionCooldown.set(sessionId, {
    noteId: cleanId,
    conceptKey: normalizedKey,
    ts: Date.now()
  });
}

function consumeSuggestionCooldown(sessionId, noteId, conceptKey) {
  if (!sessionId) return false;
  const entry = sessionConceptSuggestionCooldown.get(sessionId);
  if (!entry) return false;
  const tooOld = Number.isFinite(entry.ts) && Date.now() - entry.ts > 2 * 60 * 1000;
  if (tooOld) {
    sessionConceptSuggestionCooldown.delete(sessionId);
    return false;
  }
  const matches = entry.noteId === String(noteId || "").trim() && entry.conceptKey === normalizeConceptKey(conceptKey);
  if (matches) {
    sessionConceptSuggestionCooldown.delete(sessionId);
    return true;
  }
  return false;
}

function getStoredListContext(sessionId) {
  if (!sessionId) return null;
  const stored = sessionSearch.get(sessionId);
  if (!stored) return null;
  const normalizedQuery = stored.normalizedQuery || topicToSearchPhrase(stored.topic) || "";
  const fallbackQuery = String(stored.query || "").trim();
  const normalizedTopic = (() => {
    if (typeof stored.normalizedTopic === "string" && stored.normalizedTopic.trim()) {
      return stored.normalizedTopic.trim();
    }
    const source = normalizedQuery || fallbackQuery || stored.topic || "";
    const normalized = normalizeTopic(source);
    return normalized ? normalized.trim() : "";
  })();
  return {
    ...stored,
    normalizedQuery,
    fallbackQuery,
    normalizedTopic,
    queryForReuse: normalizedTopic || normalizedQuery || fallbackQuery
  };
}

function sendGapPrompt(ws, { userId, sessionId, prompt, q, why }) {
  const question = (prompt || "Can you clarify?").trim();
  if (!question) return;
  const gap = {
    q: q || question,
    why: why || "clarification_needed",
    next_probe: { tool: "ask_user", args: { prompt: question } },
    est_cost: "~0t",
    ig: 0.0
  };
  const gap_id = `gap_${Date.now()}`;
  appendGap(userId, { gap_id, ...gap });
  ws.send(JSON.stringify({ type: "gap", gap: { ...gap, gap_id, status: "open" } }));
  appendMessage(sessionId, { role: "assistant", content: question });
  ws.send(JSON.stringify({ type: "assistant_message", content: question }));
}

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

function emitInspectorEvent(ws, label, payload) {
  if (!label) return;
  try {
    inspector.emit(label, payload ?? {});
  } catch (err) {
    console.error("inspector_emit_error", err);
  }
  emitEventLog(ws, label, payload);
}

function sendKdn(ws, sessionId, payload) {
  if (!ws) return;
  let normalized = payload;
  if (!normalized) return;
  if (typeof normalized === "string") {
    try { normalized = JSON.parse(normalized); }
    catch { normalized = null; }
  }
  if (!normalized || typeof normalized !== "object") return;
  const safe = { ...normalized };
  if (safe.state === undefined || safe.state === null) safe.state = "DK";
  if (safe.reason === undefined || safe.reason === null) safe.reason = "";
  safe.ambiguous = Boolean(safe.ambiguous);
  try { ws.send(JSON.stringify({ type: "kdn", kdn: safe })); } catch {}
  if (sessionId) {
    sessionLastKdnState.set(sessionId, { ...safe, ts: Date.now() });
    if (safe.state === "DK" && typeof safe.reason === "string" && /unknown/i.test(safe.reason)) {
      const history = getRecentMessages(sessionId, 4) || [];
      const lastUser = [...history].reverse().find(msg => msg?.role === "user");
      const requestText = lastUser?.content ? String(lastUser.content) : "";
      if (requestText) {
        const topicKey = ensureTopic(requestText, sessionId);
        if (topicKey) {
          addWatch(topicKey, safe.reason, { context: requestText.slice(0, 200) });
        }
      }
    }
  }
}

function getLastKdn(sessionId) {
  if (!sessionId) return null;
  return sessionLastKdnState.get(sessionId) || null;
}

function setAutoResearchContext(sessionId, context) {
  if (!sessionId) return;
  sessionAutoResearchContext.set(sessionId, context);
}

function getAutoResearchContext(sessionId) {
  if (!sessionId) return null;
  return sessionAutoResearchContext.get(sessionId) || null;
}

function clearAutoResearchContext(sessionId) {
  if (!sessionId) return;
  sessionAutoResearchContext.delete(sessionId);
}

function getAutoResearchNoteCount(sessionId) {
  if (!sessionId) return 0;
  const stored = sessionAutoResearchNoteCount.get(sessionId);
  const num = Number(stored);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function incrementAutoResearchNoteCount(sessionId) {
  if (!sessionId) return 0;
  const next = getAutoResearchNoteCount(sessionId) + 1;
  sessionAutoResearchNoteCount.set(sessionId, next);
  return next;
}

function resetAutoResearchSearchCount(sessionId) {
  if (!sessionId) return;
  sessionAutoResearchSearchCount.set(sessionId, 0);
}

function getAutoResearchSearchCount(sessionId) {
  if (!sessionId) return 0;
  const stored = sessionAutoResearchSearchCount.get(sessionId);
  const num = Number(stored);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function incrementAutoResearchSearchCount(sessionId) {
  if (!sessionId) return 0;
  const next = getAutoResearchSearchCount(sessionId) + 1;
  sessionAutoResearchSearchCount.set(sessionId, next);
  return next;
}

function getSearchBudget(sessionId) {
  return {
    turn: () => {
      if (!sessionId) return 0;
      if (MAX_AUTO_SEARCHES_PER_TURN <= 0) return 0;
      const remaining = MAX_AUTO_SEARCHES_PER_TURN - getAutoResearchSearchCount(sessionId);
      return remaining > 0 ? remaining : 0;
    }
  };
}

function finalizeAutoResearchEvent(ws, sessionId, context) {
  if (!context || !context.trigger) {
    clearAutoResearchContext(sessionId);
    return;
  }
  const topic = typeof context.topic === "string" ? context.topic : "";
  emitInspectorEvent(ws, "auto_research", {
    trigger: context.trigger,
    searched: Boolean(context.searched),
    wrote: Boolean(context.wrote),
    topic
  });
  if (context.lastError === "score_low" && context.candidate) {
    const summary = String(context.candidate.summary || "").slice(0, 200);
    emitInspectorEvent(ws, "auto_research_candidate", {
      topic,
      url: context.candidate.url || "",
      score: context.candidate.score,
      summary
    });
  }
  clearAutoResearchContext(sessionId);
}

const ENTITY_STOPWORDS = new Set([
  "the", "a", "an", "and", "but", "for", "nor", "or", "so", "yet",
  "what", "whats", "what's", "latest", "update", "deal", "about",
  "with", "from", "have", "that", "this", "when", "where", "which",
  "who", "whose", "beyond", "regarding", "btw", "please", "pls"
]);

function detectNamedEntityPair(text) {
  const raw = typeof text === "string" ? text : "";
  if (!raw) return false;
  const cleaned = raw.replace(/[\r\n]+/g, " ").replace(/[–—]/g, " ");
  const matches = cleaned.match(/\b[A-Z][\w&.-]{1,}\b/g);
  if (!matches) return false;
  const seen = new Set();
  for (const match of matches) {
    const token = match.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (!token) continue;
    const lower = token.toLowerCase();
    if (ENTITY_STOPWORDS.has(lower)) continue;
    seen.add(lower);
    if (seen.size >= 2) return true;
  }
  return false;
}

function extractEntitiesToKey(text) {
  const raw = typeof text === "string" ? text : "";
  if (!raw) return "";
  const matches = raw.match(/\b[A-Z][\w&.'-]*\b/g);
  if (!matches) return "";
  const seen = new Set();
  const tokens = [];
  for (const match of matches) {
    const cleaned = match.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (!cleaned) continue;
    const lower = cleaned.toLowerCase();
    if (ENTITY_STOPWORDS.has(lower)) continue;
    if (/^\d+$/.test(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    tokens.push(cleaned);
    if (tokens.length >= 4) break;
  }
  if (!tokens.length) return "";
  const phrase = tokens.join(" ");
  const normalized = normalizeTopicKey(phrase, "news");
  return normalized;
}

function makeFallbackDkTopicKey(text) {
  const raw = typeof text === "string" ? text : "";
  if (!raw) return "dk/" + Math.random().toString(36).slice(2, 10);
  const hash = createHash("sha1").update(raw).digest("hex");
  return `dk/${hash.slice(0, 10)}`;
}

function ensureTopic(reqText, sessionId = null) {
  const base = typeof reqText === "string" ? reqText : "";
  const trimmed = base.replace(/[\r\n]+/g, " ").trim();
  const candidates = [];
  if (trimmed) {
    const normalizedTopic = normalizeTopic(trimmed);
    if (normalizedTopic) candidates.push(normalizedTopic);
    const normalizedKey = normalizeTopicKey(trimmed, "news");
    if (normalizedKey) candidates.push(normalizedKey);
    const entityKey = extractEntitiesToKey(trimmed);
    if (entityKey) candidates.push(entityKey);
  }
  if (sessionId) {
    const sessionState = getSessionState(sessionId);
    if (sessionState.currentTopic) candidates.push(sessionState.currentTopic);
    if (sessionState.lastList?.key) candidates.push(sessionState.lastList.key);
    if (sessionState.lastSummary?.conceptKey) candidates.push(sessionState.lastSummary.conceptKey);
    const topicRecord = getSessionTopicRecord(sessionId);
    if (topicRecord?.active) candidates.push(topicRecord.active);
    if (topicRecord?.lastList?.key) candidates.push(topicRecord.lastList.key);
    if (topicRecord?.lastConcept?.key) candidates.push(topicRecord.lastConcept.key);
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalizeTopicKey(candidate, "news");
    if (normalized) {
      return normalized;
    }
  }
  if (trimmed) {
    return makeFallbackDkTopicKey(trimmed);
  }
  return `dk/${Math.random().toString(36).slice(2, 10)}`;
}

const CREDIBLE_SOURCE_WHITELIST = new Set([
  "reuters.com",
  "apnews.com",
  "ap.org",
  "ft.com",
  "bbc.com",
  "theguardian.com",
  "npr.org",
  "wsj.com",
  "bloomberg.com"
]);

async function ensureCard(topicKey, intent, { sessionId = null, userId = null } = {}) {
  if (!AUTO_LEARN_ENABLED) return { wroteCard: false, appendedUpdate: false };
  const canonicalKey = normalizeTopicKey(topicKey || "", "news");
  if (!canonicalKey) {
    logTelemetryEvent({ intent: intent || "auto", topicKey: "", wroteCard: false, appendedUpdate: false, proposedBridge: false, tokensSaved: 0, reason: "no_topic" });
    return { wroteCard: false, appendedUpdate: false };
  }

  const existingCards = getTopByTopic(canonicalKey, { limit: 3 }) || [];
  const primaryNote = existingCards.find(card => card?.type === "note") || null;
  const stale = primaryNote ? isStale(primaryNote, FRESH_TTL_DAYS) : true;
  const shouldSeekUpdate = Boolean(primaryNote && !stale);

  const { hosts: persistentHosts, offset } = getPersistentSeenHosts(canonicalKey);
  const excludeHosts = new Set(persistentHosts);
  if (primaryNote?.value?.source?.url) {
    const host = extractDomain(primaryNote.value.source.url);
    if (host) excludeHosts.add(host);
  }

  const query = detokenizeTopicKey(canonicalKey) || topicToSearchPhrase(canonicalKey) || canonicalKey.replace(/[\/_]/g, " ");
  const sanitizedQuery = sanitizeQuery(query);
  if (!sanitizedQuery) {
    logTelemetryEvent({ intent: intent || "auto", topicKey: canonicalKey, wroteCard: false, appendedUpdate: false, proposedBridge: false, tokensSaved: 0, reason: "no_query" });
    return { wroteCard: false, appendedUpdate: false };
  }

  const effectiveQuery = isMeaningfulQuery(sanitizedQuery) ? sanitizedQuery : query;
  const searchArgs = { q: effectiveQuery, k: 5 };
  if (offset > 0) {
    searchArgs.offset = offset;
  }

  let searchResult = null;
  try {
    searchResult = await tool_web_search(searchArgs, { MAX_PAGE_CHARS, BRAVE_API_KEY: process.env.BRAVE_API_KEY });
  } catch (err) {
    console.warn("ensure_card_search_failed", err);
    logTelemetryEvent({ intent: intent || "auto", topicKey: canonicalKey, wroteCard: false, appendedUpdate: false, proposedBridge: false, tokensSaved: 0, reason: "search_error" });
    return { wroteCard: false, appendedUpdate: false };
  }

  const results = Array.isArray(searchResult?.results) ? searchResult.results : [];
  let selectedSource = null;
  for (const entry of results) {
    if (!entry || !entry.url) continue;
    const host = extractDomain(entry.url);
    if (!host || excludeHosts.has(host)) continue;
    const credible = CREDIBLE_SOURCE_WHITELIST.has(host) || /\.(gov|gov\.\w+|mil)$/i.test(host) || /\.(edu)$/i.test(host);
    if (!credible) continue;
    selectedSource = { ...entry, host };
    break;
  }

  if (!selectedSource) {
    logTelemetryEvent({ intent: intent || "auto", topicKey: canonicalKey, wroteCard: false, appendedUpdate: false, proposedBridge: false, tokensSaved: 0, reason: "no_source" });
    return { wroteCard: false, appendedUpdate: false };
  }

  const summaryBase = (selectedSource.snippet || selectedSource.title || "").replace(/[\r\n]+/g, " ").trim();
  const summary = (summaryBase || `Update on ${detokenizeTopicKey(canonicalKey) || canonicalKey}`).slice(0, 400);
  const facetSource = summaryBase.split(/(?:\.|;|\?|!)+/).map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const facets = facetSource.slice(0, 3);
  const now = Date.now();
  const topicLabel = detokenizeTopicKey(canonicalKey) || canonicalKey;

  const card = {
    type: "note",
    topic: topicLabel,
    summary,
    value: {
      source: {
        url: selectedSource.url,
        title: selectedSource.title || topicLabel,
        host: selectedSource.host,
        ts: now
      },
      facets,
      metadata: {
        saved_by: "auto", 
        reason: intent || "auto_learn", 
        saved_at: now,
        intent: intent || ""
      }
    },
    tags: ["auto", "note"],
    entities: [],
    confidence: 0.6,
    created_at: now,
    last_used: now,
    ttl_days: 30,
    conceptKey: canonicalKey
  };

  let wroteCard = false;
  let appendedUpdate = false;
  const cardId = persistCard(card);
  if (cardId) {
    wroteCard = true;
    updatePersistentSeenHosts(canonicalKey, [selectedSource.host]);
    resolveWatch(canonicalKey, cardId);
    maybeBridge({ ...card, id: cardId }, existingCards);
  } else if (shouldSeekUpdate) {
    appendedUpdate = true;
  }

  logTelemetryEvent({ intent: intent || "auto", topicKey: canonicalKey, wroteCard, appendedUpdate, proposedBridge: false, tokensSaved: 0, reason: wroteCard ? "ensure_card" : "ensure_card_skipped" });
  return { wroteCard, appendedUpdate };
}

function cleanAutoResearchQuery(text, topicKey, listQuery) {
  const baseText = typeof text === "string" ? text : "";
  const trimmed = baseText.replace(/[\r\n]+/g, " ").trim();
  let base = typeof listQuery === "string" ? listQuery.trim() : "";
  if (!base) {
    const fromTopic = topicToSearchPhrase(topicKey || "");
    if (fromTopic) base = fromTopic;
  }
  if (!base) base = trimmed;
  if (!base) return "";
  let working = base;
  working = working.replace(/\b(?:what(?:'|’)?s|what is|tell me|give me|any|please|pls|btw)\b/gi, " ");
  working = working.replace(/\b(?:the\s+)?latest\s+(?:on|about)\b/gi, " ");
  working = working.replace(/\bupdate(?:\s+(?:on|about))?\b/gi, " ");
  working = working.replace(/\?+$/g, "");
  working = working.replace(/\s+/g, " ").trim();
  if (!working) working = base.trim();
  working = sanitizeQuery(working).slice(0, 200);
  if (!isMeaningfulQuery(working)) return "";
  return working;
}

const DK_MARKERS = [
  "unknown with current context",
  "i don't have that information",
  "i dont have that information",
  "i'm not sure",
  "im not sure"
];

function isDKMarkerReply(text) {
  const raw = typeof text === "string" ? text : "";
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase().replace(/[’`]/g, "'");
  if (!normalized) return false;
  const boundary = (ch) => {
    if (!ch) return true;
    return /\s|[\.,;:!?()'"\/\]]/.test(ch);
  };
  for (const marker of DK_MARKERS) {
    if (normalized === marker) return true;
    if (normalized.startsWith(marker) && boundary(normalized.charAt(marker.length))) return true;
  }
  return false;
}

function hasCardsForTopic(topicKey) {
  const key = typeof topicKey === "string" ? topicKey.trim() : "";
  if (!key) return false;
  const cards = getTopByTopic(key, { limit: 1 }) || [];
  return cards.length > 0;
}

async function maybeRunAutoResearch({
  ws,
  userId,
  sessionId,
  content,
  topic,
  note,
  stale,
  freshCue,
  listIntent,
  isSearchCommand,
  summarizeCommand,
  hasUrl,
  inReplyToGap,
  conceptContextBlock = "",
  conceptContextKey = "",
  conceptContextCount = 0,
  conceptContextFacets = [],
  turnHooks = null
}) {
  if (!sessionId || !userId) return null;
  if (inReplyToGap) return null;
  if (MAX_AUTO_SEARCHES_PER_TURN <= 0) return null;
  if (getAutoResearchSearchCount(sessionId) >= MAX_AUTO_SEARCHES_PER_TURN) return null;
  if (isSearchCommand || summarizeCommand || hasUrl) return null;
  if (listIntent && !freshCue) return null;
  if (!freshCue && conceptContextCount > 0) return null;

  const lastKdn = getLastKdn(sessionId);
  const rawText = typeof content === "string" ? content : "";
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  const normalizedTopic = topic ? topic : normalizeTopic(trimmed);
  const canonicalTopic = normalizeTopicKey(normalizedTopic || trimmed, "news");

  let trigger = null;
  if (freshCue && (!note || stale)) {
    trigger = "fresh";
  } else if (lastKdn && lastKdn.state === "DK") {
    trigger = "dk";
  } else if (!note && detectNamedEntityPair(trimmed)) {
    const candidateKey = canonicalTopic || normalizeTopicKey(trimmed, "news");
    if (candidateKey && !hasCardsForTopic(candidateKey)) {
      trigger = "new_topic";
    }
  }

  if (!trigger) return null;

  const topicKey = canonicalTopic || normalizeTopicKey(trimmed, "news") || "";
  if (topicKey) {
    updateSessionTopicLastAuto(sessionId, topicKey);
  }
  const query = cleanAutoResearchQuery(trimmed, topicKey, listIntent?.query);
  const context = {
    trigger,
    topic: topicKey,
    searched: false,
    wrote: false,
    candidate: null,
    lastError: null
  };
  setAutoResearchContext(sessionId, context);

  if (!query) {
    return { triggered: true, handled: false, context };
  }

  context.searched = true;
  incrementAutoResearchSearchCount(sessionId);
  const { qlist, keysUsed } = buildQueryList(query, { max: 8 });
  const topicForSearch = bucketTopic(query);
  const runNumber = touchTopicRun(sessionId, topicForSearch);
  const args = { q: query, qlist: qlist.slice(), k: 5 };
  const hasBrave = Boolean((process.env.BRAVE_API_KEY || "").trim());
  if (!hasBrave && runNumber > 1 && args.qlist.length > 1) {
    args.qlist = rotateList(args.qlist, runNumber - 1);
  }

  try {
    const spec = { tool: "web_search", args };
    const conceptMeta = {};
    if (conceptContextBlock) conceptMeta.conceptContextBlock = conceptContextBlock;
    if (conceptContextKey) conceptMeta.conceptContextKey = conceptContextKey;
    if (conceptContextCount) conceptMeta.conceptContextCount = conceptContextCount;
    if (conceptContextFacets?.length) conceptMeta.conceptContextFacets = conceptContextFacets.slice(0, 3);
    await executeTool(ws, {
      userId,
      sessionId,
      spec,
      requestText: query,
      topic: topicForSearch,
      banditKeys: keysUsed,
      runNumber,
      autoResearch: true,
      ...conceptMeta,
      turnHooks
    }, "auto_research");
    return { triggered: true, handled: true, context };
  } catch (err) {
    context.lastError = "search_error";
    console.error("auto_research_error", err);
    return { triggered: true, handled: false, context };
  }
}

async function runAutoResearchForDK({ ws, userId, sessionId }) {
  if (!sessionId || !userId) return;
  if (!AUTO_LEARN_ENABLED) return;
  const searchBudget = getSearchBudget(sessionId);
  if (!searchBudget || searchBudget.turn() <= 0) return;
  if (MAX_AUTO_SEARCHES_PER_TURN <= 0) return;
  if (getAutoResearchSearchCount(sessionId) >= MAX_AUTO_SEARCHES_PER_TURN) return;

  const recentMessages = getRecentMessages(sessionId, 6) || [];
  const lastUser = [...recentMessages].reverse().find(msg => msg?.role === "user");
  const userTextRaw = lastUser?.content ? String(lastUser.content) : "";
  const userText = userTextRaw.replace(/[\r\n]+/g, " ").trim();
  if (!userText) return;

  const activeTopicKey = getActiveTopicKey(sessionId);
  const entityTopicKey = extractEntitiesToKey(userText);
  const topicKey = (activeTopicKey || entityTopicKey || makeFallbackDkTopicKey(userText)).slice(0, 200);
  const context = {
    trigger: "dk",
    topic: topicKey,
    searched: false,
    wrote: false,
    candidate: null,
    lastError: null,
    lastScore: null,
    lastSummary: null,
    lastUrl: null
  };
  setAutoResearchContext(sessionId, context);
  if (topicKey) {
    updateSessionTopicLastAuto(sessionId, topicKey);
  }

  emitInspectorEvent(ws, "auto_research", { trigger: "dk", planned: true, topic: topicKey });

  const query = cleanAutoResearchQuery(userText, topicKey, null);
  if (!query) {
    finalizeAutoResearchEvent(ws, sessionId, context);
    return;
  }

  context.searched = true;
  incrementAutoResearchSearchCount(sessionId);

  const { qlist, keysUsed } = buildQueryList(query, { max: 8 });
  const topicForSearch = bucketTopic(query);
  const runNumber = touchTopicRun(sessionId, topicForSearch);
  const args = { q: query, qlist: qlist.slice(), k: 5 };
  const hasBrave = Boolean((process.env.BRAVE_API_KEY || "").trim());
  if (!hasBrave && runNumber > 1 && args.qlist.length > 1) {
    args.qlist = rotateList(args.qlist, runNumber - 1);
  }

  let run = null;
  let noteSaved = false;

  try {
    const result = await tool_web_search(args, { MAX_PAGE_CHARS, BRAVE_API_KEY: process.env.BRAVE_API_KEY });
    run = saveRunRecord("web_search", args, result);
    const latency_ms = result?.latency_ms || 0;
    const k = result?.k || 0;
    recordSearch({
      userId,
      sessionId,
      topic: topicForSearch,
      q_base: args.q,
      qlist: result?.qlist || args.qlist || [],
      engine: result?.engine || "unknown",
      k,
      latency_ms,
      error: null
    });
    const reward = Math.max(0, Math.min(1, k / 3)) - 0.02 * (latency_ms / 1000);
    if (Array.isArray(keysUsed) && keysUsed.length) updateBandit(keysUsed, reward);

    const entries = Array.isArray(result?.results) ? result.results : [];
    const scoredCandidates = entries
      .map((entry, idx) => {
        const domain = extractDomain(entry?.url || "");
        if (!entry || !entry.url || !domain) return null;
        if (shouldExcludeDomain(domain, entry.url, userText)) return null;
        const prior = getSourcePrior(domain);
        const recency = computeRecencyScore(entry);
        const score = SCORE_PRIOR_WEIGHT * prior + SCORE_RECENCY_WEIGHT * recency;
        return { entry, domain, prior, recency, score, idx };
      })
      .filter(Boolean);

    const dedupedByHost = new Map();
    for (const candidate of scoredCandidates) {
      const key = candidate.domain;
      const prev = dedupedByHost.get(key);
      if (!prev || prev.score < candidate.score) {
        dedupedByHost.set(key, candidate);
      }
    }

    const cleanCandidates = Array.from(dedupedByHost.values())
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return a.idx - b.idx;
      });

    if (!cleanCandidates.length) {
      context.lastError = "no_primary_hit";
    } else {
      const bestCandidate = cleanCandidates[0];
      const best = bestCandidate.entry;
      const title = (best.title || "").replace(/[\r\n]+/g, " ").trim();
      const snippet = (best.snippet || "").replace(/[\r\n]+/g, " ").trim();
      const topicLabel = detokenizeTopicKey(topicKey) || detokenizeTopicKey(topicForSearch) || "";
      const fallbackTopic = topicLabel || query || userText;
      let summary = [title, snippet].filter(Boolean).join(" — ");
      summary = summary.replace(/\s+/g, " ").trim();
      if (!summary) summary = fallbackTopic.replace(/\s+/g, " ").trim();
      summary = summary.slice(0, 400);
      if (!summary) {
        context.lastError = "missing_summary";
      } else {
        const frequency = computeFrequencyScore(runNumber);
        const metrics = { explicitness: 0, recency: bestCandidate.recency, frequency, taskGain: 0 };
        const noteScore = scoreImportance(metrics);
        context.lastScore = noteScore;
        context.lastSummary = summary;
        context.lastUrl = best.url;

        if (noteScore < MIN_WRITE_SCORE) {
          context.lastError = "score_low";
          context.candidate = { summary, url: best.url, score: noteScore };
        } else {
          const payload = {
            topic: topicKey || fallbackTopic || summary,
            summary,
            source: { url: best.url },
            ttl_days: AUTO_RESEARCH_CONFIG.note_ttl_days
          };
          if (title) payload.source.title = title.slice(0, 200);
          const confidence = Math.max(0, Math.min(1, Number(noteScore) || 0));
          payload.confidence = Math.round(confidence * 1000) / 1000;
          const noteResult = saveNoteCardFromPayload({
            payload,
            explicitness: 0,
            userId,
            sessionId,
            run,
            reason: "auto_research_dk",
            topicHint: fallbackTopic || summary,
            autoResearch: true
          });
          if (noteResult?.saved && noteResult.card?.id) {
            noteSaved = true;
            context.wrote = true;
            context.lastError = null;
            context.candidate = null;
            ws.send(JSON.stringify({
              type: "note_saved",
              note: { topic: noteResult.card.topic, score: Number(noteResult.score ?? 0) }
            }));
            rememberLastSavedNoteId(sessionId, noteResult.card.id);
            const linkResult = autoLinkNoteToTopic(ws, sessionId, noteResult.card, { isAutoNote: true });
            const autoTopicKey = getSlotConceptKey(getSessionTopicRecord(sessionId).lastAuto);
            emitInspectorEvent(ws, "auto_research_note", { topic: autoTopicKey });
            maybeSuggestConceptLink(ws, sessionId, noteResult.card);
            maybeProposeAnalogyFromNote(ws, sessionId, noteResult.card, linkResult?.conceptKey);
            if (updateLastEpisode({ note_saved: true })) {
              ws.send(JSON.stringify({ type: "learning_stats", stats: recentStats(20) }));
            }
          } else if (noteResult?.error === "duplicate_note" && noteResult?.conceptKey) {
            context.lastError = "duplicate";
          } else if (noteResult?.error === "auto_paused") {
            context.lastError = "auto_paused";
          } else if (noteResult?.error === "auto_note_limit") {
            context.lastError = "auto_limit";
          } else if (noteResult?.error) {
            context.lastError = noteResult.error;
          }
        }
      }
    }

    recordEpisode({
      userId,
      sessionId,
      topic: topicForSearch,
      success: k > 0,
      note_saved: noteSaved,
      tokens_total: null,
      calls: { web_search: 1, web_get: 0 }
    });
    ws.send(JSON.stringify({ type: "learning_stats", stats: recentStats(20) }));
  } catch (err) {
    context.lastError = "search_error";
    console.error("auto_research_dk_error", err);
  }

  finalizeAutoResearchEvent(ws, sessionId, context);
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
  const wantsQuora = /\binclude\s+quora\b/i.test(text)
    || /\bfrom\s+quora\b/i.test(text)
    || /\bquora\s+(?:answers?|posts?|sources?|links?)\b/i.test(text)
    || /\bquora\.com\//i.test(text);
  const wantsMedium = /\binclude\s+medium(?:\.com)?\b/i.test(text)
    || /\bfrom\s+medium(?:\.com)?\b/i.test(text)
    || /\bmedium(?:\.com)?\s+(?:articles?|posts?|sources?|links?)\b/i.test(text)
    || /\bmedium\.com\/@/i.test(text);
  for (const pattern of DOMAIN_PREFS.exclude || []) {
    if (!pattern) continue;
    const normalizedPattern = pattern.toLowerCase();
    const isRedditPattern = normalizedPattern.includes("reddit");
    const isQuoraPattern = normalizedPattern.includes("quora");
    const isMediumPattern = normalizedPattern.includes("medium.com/@");
    if (pattern.includes("/")) {
      if (!urlLower) continue;
      if (urlLower.includes(pattern)) {
        if (isRedditPattern && wantsReddit) continue;
        if (isQuoraPattern && wantsQuora) continue;
        if (isMediumPattern && wantsMedium) continue;
        return true;
      }
      continue;
    }
    if (domainMatches(domain, pattern)) {
      if (isRedditPattern && wantsReddit) continue;
      if (isQuoraPattern && wantsQuora) continue;
      if (isMediumPattern && wantsMedium) continue;
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

function persistCard(card) {
  try {
    const result = writeCard(card);
    const id = result?.id;
    if (!id) return null;
    updateIndex({ ...card, id });
    return id;
  } catch (err) {
    console.warn("persistCard failed", err);
    return null;
  }
}

function logCardWrite(entry) {
  if (!entry || typeof entry !== "object") return;
  const record = {
    ts: Number(entry.ts) || Date.now(),
    type: entry.type || "unknown",
    topic: entry.topic || "",
    score: Number.isFinite(entry.score) ? entry.score : 0,
    reason: entry.reason || ""
  };
  try {
    fs.appendFileSync(cardWriteLogFile, JSON.stringify(record) + "\n");
  } catch (err) {
    console.warn("CardWriteLog append failed", err);
  }
}

function maybeUpsertNewsCard({ ws, topicKey, topicLabel, selected, qualityScore }) {
  if (!Array.isArray(selected) || !selected.length) return null;
  const canonicalKey = normalizeTopicKey(topicKey || topicLabel || "", "news");
  if (!canonicalKey) return null;
  const score = Number.isFinite(qualityScore) ? qualityScore : 0;
  if (score < MIN_WRITE_SCORE) return null;
  const now = Date.now();
  if (LEARN_COOLDOWN_HOURS > 0) {
    const last = newsCardCooldown.get(canonicalKey);
    const cooldownMs = LEARN_COOLDOWN_HOURS * 60 * 60 * 1000;
    if (last && now - last < cooldownMs) return null;
  }
  const dateKey = new Date(now).toISOString().slice(0, 10);
  if (newsCardDaily.dateKey !== dateKey) {
    newsCardDaily.dateKey = dateKey;
    newsCardDaily.total = 0;
  }
  if (LEARN_BUDGET_PER_DAY > 0 && newsCardDaily.total >= LEARN_BUDGET_PER_DAY) {
    return null;
  }

  const topicName = topicLabel || detokenizeTopicKey(canonicalKey) || canonicalKey;
  const sources = selected
    .slice(0, 3)
    .map((entry, idx) => {
      if (!entry?.url) return null;
      const host = entry.domain || extractDomain(entry.url) || "";
      return {
        url: entry.url,
        title: entry.title || topicName,
        host,
        ts: now,
        rank: idx + 1
      };
    })
    .filter(Boolean);
  if (!sources.length) return null;

  const headlineParts = selected
    .slice(0, 2)
    .map(item => String(item?.title || "").replace(/[\r\n]+/g, " ").trim())
    .filter(Boolean);
  const summaryLine = headlineParts.length
    ? headlineParts.join(" • ")
    : `Top updates from ${sources.length} sources.`;
  const sourceLine = sources.map(src => src.host || extractDomain(src.url) || src.url).filter(Boolean).join(" · ");
  const summary = `${summaryLine.slice(0, 180)}\nSources: ${sourceLine.slice(0, 180)}`;

  const card = {
    type: "note",
    topic: topicName,
    summary,
    value: {
      source: sources[0],
      sources,
      metadata: {
        saved_by: "auto",
        reason: "news_followup",
        saved_at: now,
        intent: "news_card"
      }
    },
    tags: ["auto", "news"],
    entities: [],
    confidence: Math.min(1, Math.max(MIN_WRITE_SCORE, score)),
    created_at: now,
    last_used: now,
    ttl_days: 7,
    conceptKey: canonicalKey
  };

  const noteId = persistCard(card);
  if (!noteId) return null;
  newsCardCooldown.set(canonicalKey, now);
  newsCardDaily.total += 1;
  logCardWrite({ ts: now, type: "news_card", topic: canonicalKey, score, reason: "news_followup" });
  emitInspectorEvent(ws, "card_upsert", {
    topicKey: canonicalKey,
    noteId,
    sources: sources.map(src => src.url)
  });
  return { noteId };
}

function readConceptEdges() {
  try {
    const raw = fs.readFileSync(conceptEdgesFile, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const edges = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const noteId = parsed?.note_id ? String(parsed.note_id).trim() : "";
        const conceptKey = parsed?.concept_key ? normalizeConceptKey(parsed.concept_key) : "";
        if (!noteId || !conceptKey) continue;
        const ts = Number(parsed.ts);
        edges.push({ note_id: noteId, concept_key: conceptKey, ts: Number.isFinite(ts) ? ts : 0 });
      } catch {
        continue;
      }
    }
    return edges;
  } catch {
    return [];
  }
}

function writeConceptEdges(edges) {
  const lines = edges.map(edge => JSON.stringify(edge));
  const payload = lines.join("\n");
  fs.writeFileSync(conceptEdgesFile, payload + (payload.endsWith("\n") || !payload ? "" : "\n"));
}

function addConceptEdge(noteId, conceptKey) {
  const normalizedKey = normalizeConceptKey(conceptKey);
  const cleanNoteId = String(noteId || "").trim();
  if (!cleanNoteId || !normalizedKey) return { added: false, edge: null };
  const edges = readConceptEdges();
  if (edges.some(edge => edge.note_id === cleanNoteId && edge.concept_key === normalizedKey)) {
    return { added: false, edge: edges.find(edge => edge.note_id === cleanNoteId && edge.concept_key === normalizedKey) };
  }
  const entry = { note_id: cleanNoteId, concept_key: normalizedKey, ts: Date.now() };
  edges.push(entry);
  writeConceptEdges(edges);
  return { added: true, edge: entry };
}

function removeConceptEdge(noteId, conceptKey) {
  const normalizedKey = normalizeConceptKey(conceptKey);
  const cleanNoteId = String(noteId || "").trim();
  if (!cleanNoteId || !normalizedKey) return false;
  const edges = readConceptEdges();
  const next = edges.filter(edge => !(edge.note_id === cleanNoteId && edge.concept_key === normalizedKey));
  if (next.length === edges.length) {
    return false;
  }
  writeConceptEdges(next);
  return true;
}

function listConceptEdgesForKey(conceptKey) {
  const normalizedKey = normalizeConceptKey(conceptKey);
  if (!normalizedKey) return [];
  return readConceptEdges().filter(edge => edge.concept_key === normalizedKey);
}

function getNoteConceptKeys(noteId) {
  const cleanNoteId = String(noteId || "").trim();
  if (!cleanNoteId) return [];
  return readConceptEdges()
    .filter(edge => edge.note_id === cleanNoteId)
    .map(edge => edge.concept_key)
    .filter(Boolean);
}

function isNoteLinkedToConcept(noteId, conceptKey) {
  const normalizedKey = normalizeConceptKey(conceptKey);
  const cleanNoteId = String(noteId || "").trim();
  if (!cleanNoteId || !normalizedKey) return false;
  return readConceptEdges().some(edge => edge.note_id === cleanNoteId && edge.concept_key === normalizedKey);
}

let conceptCardCache = null;

function getConceptCards({ refresh = false } = {}) {
  if (!conceptCardCache || refresh) {
    const all = readAllCards();
    conceptCardCache = all.filter(card => card?.type === "concept");
  }
  return conceptCardCache.slice();
}

function invalidateConceptCache() {
  conceptCardCache = null;
}

function findConceptCard(key) {
  const normalizedKey = normalizeConceptKey(key);
  if (!normalizedKey) return null;
  const cards = getConceptCards();
  return cards.find(card => normalizeConceptKey(card?.key) === normalizedKey) || null;
}

function findNoteCard(noteId) {
  const cleanNoteId = String(noteId || "").trim();
  if (!cleanNoteId) return null;
  const all = readAllCards();
  return all.find(card => card?.type === "note" && card?.id === cleanNoteId) || null;
}

function noteTimestamp(note) {
  const candidates = [
    note?.last_used,
    note?.created_at,
    note?.value?.metadata?.saved_at,
    note?.value?.source?.ts,
    note?.ts
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }
  return null;
}

function formatAgeLabel(ts) {
  const numeric = Number(ts);
  if (!Number.isFinite(numeric) || numeric <= 0) return "?";
  const diff = Date.now() - numeric;
  if (!Number.isFinite(diff) || diff < 0) return "0m";
  const minutes = Math.floor(diff / (60 * 1000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 90) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${years}y`;
}

function resolveNoteHost(note) {
  const url = note?.value?.source?.url;
  if (!url || typeof url !== "string") return "";
  try {
    const parsed = new URL(url);
    return parsed.host || "";
  } catch {
    return "";
  }
}

function getSlotConceptKey(slot) {
  if (!slot || typeof slot !== "object") return "";
  const raw = typeof slot.key === "string" ? slot.key.trim() : "";
  if (!raw) return "";
  return toConceptKey(raw);
}

function resolveFallbackConceptFromLastList(sessionId) {
  if (!sessionId) return "";
  const ctx = getLastListContext(sessionId);
  if (!ctx) return "";
  const candidates = [];
  if (ctx.lastTopicKey) candidates.push(ctx.lastTopicKey);
  if (ctx.lastQBase) candidates.push(ctx.lastQBase);
  for (const candidate of candidates) {
    const raw = String(candidate || "").trim();
    if (!raw || TOPIC_COMMAND_PREFIX_RE.test(raw)) continue;
    const normalized = normalizeTopicKey(raw, "news");
    const conceptKey = toConceptKey(normalized || raw);
    if (conceptKey) return conceptKey;
  }
  return "";
}

function resolveNoteTopic(sessionId, { isAutoNote = false, now = Date.now() } = {}) {
  const resolution = { key: "", source: "" };
  if (!sessionId) return resolution;
  const record = getSessionTopicRecord(sessionId);
  if (isAutoNote) {
    const key = getSlotConceptKey(record.lastAuto);
    return { key, source: "lastAuto" };
  }

  const currentTs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const lastListKey = getSlotConceptKey(record.lastList);
  const lastListTs = Number(record?.lastList?.ts) || 0;
  if (lastListKey && currentTs - lastListTs <= 90_000) {
    return { key: lastListKey, source: "lastList" };
  }

  const lastConceptKey = getSlotConceptKey(record.lastConcept);
  if (lastConceptKey) {
    return { key: lastConceptKey, source: "lastConcept" };
  }

  const activeKey = toConceptKey(record.active);
  if (activeKey) {
    return { key: activeKey, source: "active" };
  }

  const fallbackKey = resolveFallbackConceptFromLastList(sessionId);
  if (fallbackKey) {
    return { key: fallbackKey, source: "fallback" };
  }

  return resolution;
}

function ensureConceptForKey(conceptKey) {
  const normalizedKey = normalizeConceptKey(conceptKey);
  if (!normalizedKey) {
    return { promoted: false, concept: null };
  }
  let concept = findConceptCard(normalizedKey);
  if (concept) {
    return { promoted: false, concept };
  }

  const metadata = inferConceptMetadata(normalizedKey);
  const now = Date.now();
  const title = detokenizeTopicKey(normalizedKey) || normalizedKey;
  const conceptCard = {
    ...ConceptCard,
    key: normalizedKey,
    title,
    tags: metadata.tags,
    entities: metadata.entities,
    confidence: metadata.confidence,
    ts: now,
    last_used: null,
    created_at: now,
    ttl_days: null
  };
  const id = persistCard(conceptCard);
  if (!id) {
    return { promoted: false, concept: null };
  }
  concept = { ...conceptCard, id };
  invalidateConceptCache();
  logCardWrite({ ts: now, type: "concept", topic: normalizedKey, score: metadata.confidence, reason: "auto_promote" });
  return { promoted: true, concept };
}

function linkNoteToConceptEdge(noteId, conceptKey) {
  const cleanId = String(noteId || "").trim();
  const normalizedKey = normalizeConceptKey(conceptKey);
  if (!cleanId || !normalizedKey) {
    return { added: false, edge: null };
  }
  return addConceptEdge(cleanId, normalizedKey);
}

function autoLinkNoteToTopic(ws, sessionId, noteCard, { isAutoNote = false } = {}) {
  const resolution = resolveNoteTopic(sessionId, { isAutoNote });
  const topicKey = resolution.key;
  if (!noteCard || !noteCard.id || !topicKey) {
    return { ...resolution, conceptKey: topicKey || "", promoted: false, added: false, linked: false };
  }

  const ensure = ensureConceptForKey(topicKey);
  if (!ensure.concept) {
    return { ...resolution, conceptKey: topicKey, promoted: false, added: false, linked: false };
  }
  const result = linkNoteToConceptEdge(noteCard.id, topicKey);
  if (!result?.edge) {
    return { ...resolution, conceptKey: topicKey, promoted: Boolean(ensure.promoted), added: Boolean(result?.added), linked: false };
  }

  emitInspectorEvent(ws, "auto_link", { noteId: noteCard.id, key: topicKey, promoted: Boolean(ensure.promoted) });
  return { ...resolution, conceptKey: topicKey, promoted: Boolean(ensure.promoted), added: Boolean(result.added), linked: true };
}

function maybeSuggestConceptLink(ws, sessionId, noteCard) {
  if (!ws || !noteCard || !noteCard.id) return;
  const entities = Array.isArray(noteCard.entities) ? noteCard.entities : [];
  const normalizedEntities = new Set(
    entities
      .map(value => String(value || "").trim().toLowerCase())
      .filter(Boolean)
  );
  if (normalizedEntities.size < 2) return;

  const concepts = getConceptCards();
  let best = null;
  for (const concept of concepts) {
    const conceptKey = normalizeConceptKey(concept?.key);
    if (!conceptKey) continue;
    if (isNoteLinkedToConcept(noteCard.id, conceptKey)) continue;
    const conceptEntities = Array.isArray(concept?.entities) ? concept.entities : [];
    const normalizedConceptEntities = new Set(
      conceptEntities
        .map(value => String(value || "").trim().toLowerCase())
        .filter(Boolean)
    );
    if (normalizedConceptEntities.size < 2) continue;
    let matches = 0;
    for (const entity of normalizedConceptEntities) {
      if (normalizedEntities.has(entity)) {
        matches += 1;
      }
    }
    if (matches >= 2) {
      if (!best || matches > best.matches) {
        best = { concept, matches };
      }
    }
  }

  if (!best) return;

  const conceptKey = normalizeConceptKey(best.concept.key);
  if (!conceptKey) return;
  const existing = sessionConceptSuggestions.get(sessionId);
  if (existing && existing.noteId === noteCard.id && existing.conceptKey === conceptKey) {
    return;
  }
  if (consumeSuggestionCooldown(sessionId, noteCard.id, conceptKey)) {
    return;
  }

  const suggestion = {
    noteId: noteCard.id,
    conceptKey,
    title: best.concept.title || conceptKey,
    ts: Date.now()
  };
  sessionConceptSuggestions.set(sessionId, suggestion);
  const text = `suggest_link: note ${suggestion.noteId} -> concept ${conceptKey} (yes/no)`;
  appendMessage(sessionId, { role: "assistant", content: text });
  ws.send(JSON.stringify({ type: "assistant_message", content: text }));
}

function handleConceptSuggestionResponse(ws, sessionId, content) {
  const suggestion = sessionConceptSuggestions.get(sessionId);
  if (!suggestion) return false;
  const normalized = String(content || "").trim().toLowerCase();
  if (!normalized) return false;
  const positive = normalized === "yes" || normalized === "y";
  const negative = normalized === "no" || normalized === "n";
  if (!positive && !negative) return false;

  sessionConceptSuggestions.delete(sessionId);

  if (positive) {
    const note = findNoteCard(suggestion.noteId);
    const concept = findConceptCard(suggestion.conceptKey);
    if (!note || !concept) {
      const reply = `I couldn't complete that link for note ${suggestion.noteId}.`;
      appendMessage(sessionId, { role: "assistant", content: reply });
      ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
      emitEventLog(ws, "concept_link", { noteId: suggestion.noteId, key: suggestion.conceptKey, accepted: false, reason: "missing_note_or_concept" });
      return true;
    }
    const result = addConceptEdge(note.id, suggestion.conceptKey);
    const title = concept.title || suggestion.conceptKey;
    const reply = result.added
      ? `Linked note ${note.id} to concept "${title}".`
      : `Note ${note.id} is already linked to concept "${title}".`;
    appendMessage(sessionId, { role: "assistant", content: reply });
    ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
    emitEventLog(ws, "concept_link", { noteId: note.id, key: suggestion.conceptKey, accepted: true });
    if (result.added) {
      registerSuggestionCooldown(sessionId, { noteId: note.id, conceptKey: suggestion.conceptKey });
      scheduleAnalogyProposal(ws, sessionId, suggestion.conceptKey);
    }
    updateSessionTopicLastConcept(sessionId, suggestion.conceptKey);
    return true;
  }

  if (negative) {
    const reply = `Okay, not linking note ${suggestion.noteId} to concept ${suggestion.conceptKey}.`;
    appendMessage(sessionId, { role: "assistant", content: reply });
    ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
    emitEventLog(ws, "concept_link", { noteId: suggestion.noteId, key: suggestion.conceptKey, accepted: false });
    return true;
  }

  return false;
}

function linkNoteToConcept(ws, sessionId, noteId, conceptKeyRaw, { via = "command" } = {}) {
  const cleanId = String(noteId || "").trim();
  if (!cleanId) {
    const reply = "I need a note id to link.";
    appendMessage(sessionId, { role: "assistant", content: reply });
    ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
    return true;
  }
  const conceptKey = normalizeConceptKey(conceptKeyRaw);
  if (!conceptKey) {
    const reply = "I need a concept key to link that note.";
    appendMessage(sessionId, { role: "assistant", content: reply });
    ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
    return true;
  }
  const note = findNoteCard(cleanId);
  if (!note) {
    const reply = `I couldn't find note ${cleanId}.`;
    appendMessage(sessionId, { role: "assistant", content: reply });
    ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
    return true;
  }
  const concept = findConceptCard(conceptKey);
  if (!concept) {
    const reply = `I don't have concept ${conceptKeyRaw}.`;
    appendMessage(sessionId, { role: "assistant", content: reply });
    ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
    return true;
  }
  const result = addConceptEdge(cleanId, conceptKey);
  const suggestion = sessionConceptSuggestions.get(sessionId);
  if (suggestion && suggestion.noteId === cleanId && suggestion.conceptKey === conceptKey) {
    sessionConceptSuggestions.delete(sessionId);
  }
  if (result.added) {
    registerSuggestionCooldown(sessionId, { noteId: cleanId, conceptKey });
    scheduleAnalogyProposal(ws, sessionId, conceptKey);
  }
  const title = concept.title || conceptKey;
  const reply = result.added
    ? `Linked note ${cleanId} to concept "${title}".`
    : `Note ${cleanId} is already linked to concept "${title}".`;
  appendMessage(sessionId, { role: "assistant", content: reply });
  ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
  emitEventLog(ws, "concept_link", { noteId: cleanId, key: conceptKey, accepted: true, via });
  updateSessionTopicLastConcept(sessionId, conceptKey);
  return true;
}

function normalizeAnalogyName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.toLowerCase();
}

function formatPartyLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/[A-Z]/.test(raw)) return raw;
  return raw.replace(/\b([a-z])/g, (_, ch) => ch.toUpperCase());
}

function gatherParties(signature, concept) {
  const map = new Map();
  const push = (value) => {
    const normalized = normalizeAnalogyName(value);
    if (!normalized) return;
    if (map.has(normalized)) return;
    const display = formatPartyLabel(value);
    if (display) {
      map.set(normalized, display);
    }
  };
  if (Array.isArray(concept?.entities)) {
    for (const entity of concept.entities) {
      push(entity);
    }
  }
  if (Array.isArray(signature?.parties)) {
    for (const party of signature.parties) {
      push(party);
    }
  }
  return Array.from(map.values());
}

function labelFacet(value) {
  const canonical = canonicalizeFacet(value);
  if (canonical) return canonical;
  return String(value || "")
    .trim()
    .replace(/[\s_]+/g, " ")
    .toLowerCase();
}

function formatAnalogyProposalMessage(suggestion) {
  const mapping = suggestion.mapping || {};
  const facets = Array.isArray(mapping.facets) ? mapping.facets.map(labelFacet).join(", ") : "";
  const partyALine = `${mapping.partyA?.from || "partyA"} ↔ ${mapping.partyA?.to || "partyA"}`;
  const partyBLine = `${mapping.partyB?.from || "partyB"} ↔ ${mapping.partyB?.to || "partyB"}`;
  const why = suggestion.why || [];
  const watchout = suggestion.watchout || [];
  const lines = [
    `from: ${suggestion.from}`,
    `to: ${suggestion.to}`,
    "mapping:",
    `  partyA: ${partyALine}`,
    `  partyB: ${partyBLine}`,
    `  facets: ${facets}`,
    "why:",
    `  1) ${why[0] || "Shared structural overlap."}`,
    `  2) ${why[1] || "Comparable party incentives."}`,
    "watchout:",
    `  - ${watchout[0] || "Confirm contextual differences."}`,
    "accept? (yes/no)"
  ];
  return lines.join("\n");
}

function buildAnalogySuggestion({ fromKey, sourceConcept, toConcept, sourceSig, targetSig, sharedFacets, score }) {
  const targetKey = toConcept?.key || "";
  const sourceParties = gatherParties(sourceSig, sourceConcept || getConcept(fromKey) || { key: fromKey });
  const targetParties = gatherParties(targetSig, toConcept);
  const [sourceA, sourceB] = [sourceParties[0] || "partyA", sourceParties[1] || sourceParties[0] || "partyB"];
  const [targetA, targetB] = [targetParties[0] || "partyA", targetParties[1] || targetParties[0] || "partyB"];
  const mappedFacets = sharedFacets.slice(0, 3);
  const facetWhy = sharedFacets.slice(0, 2).map(facet => {
    const label = labelFacet(facet);
    return `Shared facet "${label}" appears in linked notes for ${fromKey} and ${targetKey}.`;
  });
  while (facetWhy.length < 2) {
    facetWhy.push(`Both concepts involve overlapping parties ${sourceA} and ${targetA}.`);
  }
  const uniqueTargetFacets = targetSig.facets.filter(facet => !sourceSig.facets.includes(facet));
  const watchout = uniqueTargetFacets.length
    ? [`${targetKey} also highlights ${uniqueTargetFacets.map(labelFacet).join(", ")} that may diverge from ${fromKey}.`]
    : [`Roles for ${targetA} and ${targetB} may differ from ${sourceA}/${sourceB}.`];
  return {
    from: fromKey,
    to: targetKey,
    mapping: {
      partyA: { from: sourceA, to: targetA },
      partyB: { from: sourceB, to: targetB },
      facets: mappedFacets
    },
    why: facetWhy.slice(0, 2),
    watchout,
    status: "proposed",
    score,
    sharedFacets: mappedFacets.slice(),
    sourceParties,
    targetParties
  };
}

function getAnalogyTodayKey() {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

function resetAnalogyAutoStateIfNeeded() {
  const today = getAnalogyTodayKey();
  if (ANALOGY_AUTO_STATE.dateKey !== today) {
    ANALOGY_AUTO_STATE.dateKey = today;
    ANALOGY_AUTO_STATE.total = 0;
    ANALOGY_CONCEPT_DAILY.clear();
  }
}

function scheduleAnalogyProposal(ws, sessionId, conceptKey) {
  if (!AUTO_ANALOGY_ENABLED) return;
  const normalizedKey = normalizeConceptKey(conceptKey);
  if (!normalizedKey) return;
  const timerKey = `${sessionId || ""}::${normalizedKey}`;
  if (pendingAnalogyTimers.has(timerKey)) return;
  const timer = setTimeout(() => {
    pendingAnalogyTimers.delete(timerKey);
    try {
      maybeAutoProposeAnalogy(ws, sessionId, normalizedKey);
    } catch (err) {
      console.error("auto_analogy_schedule_error", err);
    }
  }, 25);
  if (timer && typeof timer.unref === "function") timer.unref();
  pendingAnalogyTimers.set(timerKey, timer);
}

function dedupeCaseInsensitive(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const raw = String(value || "").trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

function sanitizeAnalogySignature(signature = {}) {
  const rawFacets = Array.isArray(signature.facets) ? signature.facets : [];
  const canonicalFacets = rawFacets
    .map(value => canonicalizeFacet(value))
    .filter(Boolean);
  const facets = dedupeCaseInsensitive(canonicalFacets);
  const parties = dedupeCaseInsensitive(Array.isArray(signature.parties) ? signature.parties : []);
  return { facets, parties };
}

function maybeAutoProposeAnalogy(ws, sessionId, conceptKey) {
  if (!AUTO_ANALOGY_ENABLED) return false;
  if (!ws || !sessionId) return false;

  const normalizedKey = normalizeConceptKey(conceptKey);
  if (!normalizedKey) return false;
  if (sessionAnalogyProposals.has(sessionId)) return false;

  resetAnalogyAutoStateIfNeeded();
  if (ANALOGY_MAX_PROPOSALS_PER_DAY > 0 && ANALOGY_AUTO_STATE.total >= ANALOGY_MAX_PROPOSALS_PER_DAY) {
    return false;
  }

  const todayKey = ANALOGY_AUTO_STATE.dateKey || getAnalogyTodayKey();
  const conceptQuota = ANALOGY_CONCEPT_DAILY.get(normalizedKey);
  if (conceptQuota && conceptQuota.date === todayKey) {
    return false;
  }

  const noteLimit = Math.max(ANALOGY_NOTE_LIMIT, ANALOGY_MIN_NOTES_PER_CONCEPT);
  const { notes: sourceNotes, signature: sourceSignature } = getConceptSignature(normalizedKey, {
    limit: noteLimit,
    minNotes: ANALOGY_MIN_NOTES_PER_CONCEPT
  });
  if (!Array.isArray(sourceNotes) || sourceNotes.length < ANALOGY_MIN_NOTES_PER_CONCEPT) {
    return false;
  }

  const sanitizedSourceSig = sanitizeAnalogySignature(sourceSignature);
  if (sanitizedSourceSig.facets.length < 2) {
    return false;
  }

  const concepts = getConceptCards();
  let best = null;
  let bestScore = 0;
  let highestScore = 0;
  let hadShared = false;
  let bestOverlap = [];

  for (const candidate of concepts) {
    if (!candidate || candidate.type !== "concept") continue;
    const candidateKey = normalizeConceptKey(candidate.key);
    if (!candidateKey || candidateKey === normalizedKey) continue;

    const { notes: targetNotes, signature: targetSignature } = getConceptSignature(candidateKey, {
      limit: noteLimit,
      minNotes: ANALOGY_MIN_NOTES_PER_CONCEPT
    });
    if (!Array.isArray(targetNotes) || targetNotes.length < ANALOGY_MIN_NOTES_PER_CONCEPT) continue;

    const sanitizedTargetSig = sanitizeAnalogySignature(targetSignature);
    if (sanitizedTargetSig.facets.length < 2) continue;

    const sharedFacets = sanitizedTargetSig.facets.filter(facet => sanitizedSourceSig.facets.includes(facet));
    const overlap = Array.from(new Set(sharedFacets.map(value => canonicalizeFacet(value)).filter(Boolean)));
    if (overlap.length < 2) continue;

    hadShared = true;
    const score = scoreAnalogy(sanitizedSourceSig, sanitizedTargetSig);
    if (!Number.isFinite(score)) continue;

    if (score > highestScore) {
      highestScore = score;
      bestOverlap = overlap.slice(0, 3);
    }

    if (score >= ANALOGY_MIN_SCORE && (!best || score > bestScore)) {
      best = { concept: candidate, targetSig: sanitizedTargetSig, sharedFacets: overlap };
      bestScore = score;
    }
  }

  if (!best) {
    if (hadShared) {
      const scoreLabel = Number(highestScore.toFixed(3));
      emitInspectorEvent(ws, "analogy_proposal", { from: normalizedKey, to: null, score: scoreLabel, reason: "below_threshold", overlap: bestOverlap.map(labelFacet) });
    } else {
      emitInspectorEvent(ws, "analogy_proposal", { from: normalizedKey, to: null, score: 0, reason: "no_candidates", overlap: [] });
    }
    return false;
  }

  const conceptCard = findConceptCard(normalizedKey) || getConcept(normalizedKey) || { key: normalizedKey };
  const suggestion = buildAnalogySuggestion({
    fromKey: normalizedKey,
    sourceConcept: conceptCard,
    toConcept: best.concept,
    sourceSig: sanitizedSourceSig,
    targetSig: best.targetSig,
    sharedFacets: best.sharedFacets,
    score: bestScore
  });

  sessionAnalogyProposals.set(sessionId, suggestion);
  const message = formatAnalogyProposalMessage(suggestion);
  appendMessage(sessionId, { role: "assistant", content: message });
  ws.send(JSON.stringify({ type: "assistant_message", content: message }));
  emitInspectorEvent(ws, "analogy_proposal", {
    from: suggestion.from,
    to: suggestion.to,
    score: Number(bestScore.toFixed(3)),
    reason: "ok",
    overlap: suggestion.sharedFacets.map(labelFacet)
  });

  ANALOGY_AUTO_STATE.total += 1;
  ANALOGY_CONCEPT_DAILY.set(normalizedKey, { date: todayKey, to: suggestion.to });
  return true;
}

function maybeProposeAnalogyFromNote(ws, sessionId, noteCard, conceptHint = null) {
  if (!AUTO_ANALOGY_ENABLED) return;
  if (!noteCard || !noteCard.id) return;
  const targets = new Set();
  if (conceptHint) {
    const normalizedHint = normalizeConceptKey(conceptHint);
    if (normalizedHint) targets.add(normalizedHint);
  }
  const conceptKeys = getNoteConceptKeys(noteCard.id);
  for (const key of conceptKeys) {
    const normalizedKey = normalizeConceptKey(key);
    if (!normalizedKey) continue;
    targets.add(normalizedKey);
  }
  for (const key of targets) {
    scheduleAnalogyProposal(ws, sessionId, key);
  }
}

function handleAnalogyCommand(ws, sessionId, content) {
  const match = String(content || "").trim().match(/^propose\s+analogy\s+from\s+(.+)$/i);
  if (!match) return false;
  const conceptKeyRaw = match[1].trim();
  const conceptCard = getConcept(conceptKeyRaw);
  const normalizedKey = normalizeConceptKey(conceptCard?.key || conceptKeyRaw);
  if (!normalizedKey) {
    const reply = "no structural analogy proposed.";
    appendMessage(sessionId, { role: "assistant", content: reply });
    ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
    emitInspectorEvent(ws, "analogy_proposal", { from: conceptKeyRaw || "", to: null, score: 0, reason: "no_candidates", overlap: [] });
    sessionAnalogyProposals.delete(sessionId);
    return true;
  }
  const sourceNotes = getLinkedNotes(normalizedKey, { limit: ANALOGY_NOTE_LIMIT });
  if (!sourceNotes.length) {
    const reply = "no structural analogy proposed.";
    appendMessage(sessionId, { role: "assistant", content: reply });
    ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
    emitInspectorEvent(ws, "analogy_proposal", { from: normalizedKey, to: null, score: 0, reason: "no_candidates", overlap: [] });
    sessionAnalogyProposals.delete(sessionId);
    return true;
  }
  const sourceSig = sanitizeAnalogySignature(extractFacetsFromNotes(sourceNotes));
  const concepts = getConceptCards();
  let best = null;
  let bestScore = 0;
  let hadShared = false;
  let bestOverlap = [];
  let peakScore = 0;
  for (const candidate of concepts) {
    if (!candidate || candidate.type !== "concept") continue;
    const candidateKey = normalizeConceptKey(candidate.key);
    if (!candidateKey || candidateKey === normalizedKey) continue;
    const targetNotes = getLinkedNotes(candidateKey, { limit: ANALOGY_NOTE_LIMIT });
    if (!targetNotes.length) continue;
    const targetSig = sanitizeAnalogySignature(extractFacetsFromNotes(targetNotes));
    const sharedFacets = targetSig.facets.filter(facet => sourceSig.facets.includes(facet));
    const overlap = Array.from(new Set(sharedFacets.map(value => canonicalizeFacet(value)).filter(Boolean)));
    if (overlap.length < 2) continue;
    hadShared = true;
    const score = scoreAnalogy(sourceSig, targetSig);
    if (score > peakScore) {
      peakScore = score;
      bestOverlap = overlap.slice(0, 3);
    }
    if (score >= ANALOGY_MIN_SCORE && (!best || score > bestScore)) {
      best = { concept: candidate, sharedFacets: overlap, targetSig };
      bestScore = score;
    }
  }
  if (!best) {
    const reason = hadShared ? "below_threshold" : "no_candidates";
    const reply = "no structural analogy proposed.";
    appendMessage(sessionId, { role: "assistant", content: reply });
    ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
    const overlap = reason === "below_threshold" ? bestOverlap.map(labelFacet) : [];
    emitInspectorEvent(ws, "analogy_proposal", { from: normalizedKey, to: null, score: Number(peakScore.toFixed(3)), reason, overlap });
    sessionAnalogyProposals.delete(sessionId);
    return true;
  }
  const suggestion = buildAnalogySuggestion({
    fromKey: normalizedKey,
    sourceConcept: conceptCard,
    toConcept: best.concept,
    sourceSig,
    targetSig: best.targetSig,
    sharedFacets: best.sharedFacets,
    score: bestScore
  });
  sessionAnalogyProposals.set(sessionId, suggestion);
  const message = formatAnalogyProposalMessage(suggestion);
  appendMessage(sessionId, { role: "assistant", content: message });
  ws.send(JSON.stringify({ type: "assistant_message", content: message }));
  emitInspectorEvent(ws, "analogy_proposal", { from: suggestion.from, to: suggestion.to, score: Number(bestScore.toFixed(3)), reason: "ok", overlap: suggestion.sharedFacets.map(labelFacet) });
  return true;
}

async function handleAnalogyResponse(ws, sessionId, userId, content, turnHooks) {
  const suggestion = sessionAnalogyProposals.get(sessionId);
  if (!suggestion) return false;
  const normalized = String(content || "").trim().toLowerCase();
  if (!normalized) return false;
  const positive = normalized === "yes" || normalized === "y";
  const negative = normalized === "no" || normalized === "n";
  if (!positive && !negative) return false;
  sessionAnalogyProposals.delete(sessionId);
  if (positive) {
    const result = writeAnalogyCard({
      from: suggestion.from,
      to: suggestion.to,
      mapping: suggestion.mapping,
      why: suggestion.why,
      watchout: suggestion.watchout,
      status: "accepted"
    });
    const id = result?.id || null;
    if (!id) {
      const reply = "I couldn't save that analogy.";
      appendMessage(sessionId, { role: "assistant", content: reply });
      ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
      return true;
    }
    const topicRecord = getSessionTopicRecord(sessionId);
    const now = Date.now();
    const normalizedFrom = normalizeConceptKey(suggestion.from);
    let freshnessHint = null;
    if (normalizedFrom && topicRecord) {
      const activeKey = toConceptKey(topicRecord.active);
      const lastConceptTs = Number(topicRecord?.lastConcept?.ts) || 0;
      if (activeKey && activeKey === normalizedFrom && now - lastConceptTs <= ANALOGY_LATEST_WINDOW_MS) {
        const afterDate = new Date(now - 120 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        freshnessHint = { after: afterDate };
      } else {
        const lastListKey = getSlotConceptKey(topicRecord.lastList);
        const lastListTs = Number(topicRecord?.lastList?.ts) || 0;
        if (lastListKey && lastListKey === normalizedFrom && now - lastListTs <= ANALOGY_LATEST_WINDOW_MS) {
          const afterDate = new Date(now - 120 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          freshnessHint = { after: afterDate };
        }
      }
    }
    const searchQuery = buildAnalogyQuery({
      fromKey: suggestion.from,
      toKey: suggestion.to,
      overlap: suggestion.sharedFacets || [],
      entities: suggestion.targetParties || [],
      freshness: freshnessHint,
      domainPrefs: DOMAIN_PREFS
    });
    const lines = [`Analogy saved.`, `follow-up search: "${searchQuery}"`];
    const reply = lines.join("\n");
    appendMessage(sessionId, { role: "assistant", content: reply });
    ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
    emitEventLog(ws, "analogy_saved", { id, from: suggestion.from, to: suggestion.to });
    emitInspectorEvent(ws, "analogy_followup", { query: searchQuery, to: suggestion.to });
    const cleanedSearchQuery = sanitizeQuery(searchQuery);
    if (cleanedSearchQuery && userId) {
      try {
        const { qlist, keysUsed } = buildQueryList(cleanedSearchQuery, { max: 6 });
        const args = { q: cleanedSearchQuery, qlist: qlist.slice(), k: 5 };
        await executeTool(ws, {
          userId,
          sessionId,
          spec: { tool: "web_search", args },
          requestText: cleanedSearchQuery,
          topic: bucketTopic(cleanedSearchQuery),
          banditKeys: keysUsed,
          turnHooks,
          targetConceptKey: suggestion.to
        }, "analogy_followup");
      } catch (err) {
        console.error("analogy_followup_search_error", err);
      }
    }
    return true;
  }
  if (negative) {
    const reply = `Analogy discarded for ${suggestion.from}.`;
    appendMessage(sessionId, { role: "assistant", content: reply });
    ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
    emitEventLog(ws, "analogy_rejected", { from: suggestion.from, to: suggestion.to });
    return true;
  }
  return false;
}

function handleConceptCommand(ws, sessionId, content) {
  const raw = String(content || "").trim();
  if (!raw) return false;

  const promoteMatch = raw.match(/^promote\s+concept\s+([^:]+):\s*(.+)$/i);
  if (promoteMatch) {
    const keyRaw = promoteMatch[1].trim();
    let title = promoteMatch[2].trim();
    if ((title.startsWith("\"") && title.endsWith("\"")) || (title.startsWith("'") && title.endsWith("'"))) {
      title = title.slice(1, -1).trim();
    }
    const normalizedKey = normalizeConceptKey(keyRaw);
    if (!normalizedKey || !title) {
      const reply = "I need a concept key and title to promote it.";
      appendMessage(sessionId, { role: "assistant", content: reply });
      ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
      return true;
    }
    const existing = findConceptCard(normalizedKey);
    if (existing) {
      const reply = `Concept "${existing.title || normalizedKey}" already exists.`;
      appendMessage(sessionId, { role: "assistant", content: reply });
      ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
      return true;
    }

    const metadata = inferConceptMetadata(normalizedKey);
    const now = Date.now();
    const conceptCard = {
      ...ConceptCard,
      key: normalizedKey,
      title,
      tags: metadata.tags,
      entities: metadata.entities,
      confidence: metadata.confidence,
      ts: now,
      last_used: null,
      created_at: now,
      ttl_days: null
    };

    const id = persistCard(conceptCard);
    if (!id) {
      const reply = "I couldn't save that concept.";
      appendMessage(sessionId, { role: "assistant", content: reply });
      ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
      return true;
    }

    invalidateConceptCache();
    logCardWrite({ ts: now, type: "concept", topic: normalizedKey, score: metadata.confidence, reason: "promote" });
    const reply = `Promoted concept "${title}" (${normalizedKey}).`;
    appendMessage(sessionId, { role: "assistant", content: reply });
    ws.send(JSON.stringify({ type: "assistant_message", content: reply, concept: { key: normalizedKey, title, id } }));
    updateSessionTopicLastConcept(sessionId, normalizedKey);
    return true;
  }

  const linkLastMatch = raw.match(/^link\s+last_note\s*->\s*concept\s+([\w\-./:]+)$/i);
  if (linkLastMatch) {
    const lastNoteId = getLastSavedNoteId(sessionId);
    if (!lastNoteId) {
      const reply = "I don't have a recently saved note in this session.";
      appendMessage(sessionId, { role: "assistant", content: reply });
      ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
      return true;
    }
    const conceptKeyRaw = linkLastMatch[1].trim();
    return linkNoteToConcept(ws, sessionId, lastNoteId, conceptKeyRaw, { via: "last_note" });
  }

  const linkIndexMatch = raw.match(/^link\s+note\s+#(\d+)\s*->\s*concept\s+([\w\-./:]+)$/i);
  if (linkIndexMatch) {
    const list = getLastNoteList(sessionId);
    if (!list) {
      const reply = "I don't have a recent note list to use for that link.";
      appendMessage(sessionId, { role: "assistant", content: reply });
      ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
      return true;
    }
    const index = Number.parseInt(linkIndexMatch[1], 10);
    if (!Number.isFinite(index) || index < 1 || index > list.entries.length) {
      const reply = `Note #${linkIndexMatch[1]} isn't in the most recent list.`;
      appendMessage(sessionId, { role: "assistant", content: reply });
      ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
      return true;
    }
    const conceptKeyRaw = linkIndexMatch[2].trim();
    const target = list.entries[index - 1];
    return linkNoteToConcept(ws, sessionId, target.noteId, conceptKeyRaw, { via: "list_index" });
  }

  const linkMatch = raw.match(/^link\s+note\s+([\w-]+)\s*->\s*concept\s+([\w\-./:]+)$/i);
  if (linkMatch) {
    const noteId = linkMatch[1].trim();
    const conceptKeyRaw = linkMatch[2].trim();
    return linkNoteToConcept(ws, sessionId, noteId, conceptKeyRaw, { via: "command" });
  }

  const unlinkMatch = raw.match(/^unlink\s+note\s+([\w-]+)\s*->\s*concept\s+([\w\-./:]+)$/i);
  if (unlinkMatch) {
    const noteId = unlinkMatch[1].trim();
    const conceptKeyRaw = unlinkMatch[2].trim();
    const conceptKey = normalizeConceptKey(conceptKeyRaw);
    const concept = findConceptCard(conceptKey);
    if (!concept) {
      const reply = `I don't have concept ${conceptKeyRaw}.`;
      appendMessage(sessionId, { role: "assistant", content: reply });
      ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
      return true;
    }
    const removed = removeConceptEdge(noteId, conceptKey);
    const reply = removed
      ? `Unlinked note ${noteId} from concept "${concept.title || conceptKey}".`
      : `Note ${noteId} wasn't linked to concept "${concept.title || conceptKey}".`;
    appendMessage(sessionId, { role: "assistant", content: reply });
    ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
    emitEventLog(ws, "concept_link", { noteId, key: conceptKey, accepted: false, via: "command" });
    return true;
  }

  if (/^concepts\s*$/i.test(raw)) {
    const concepts = getConceptCards();
    if (!concepts.length) {
      const reply = "No concepts saved.";
      appendMessage(sessionId, { role: "assistant", content: reply });
      ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
      return true;
    }
    const lines = concepts
      .map(card => {
        const key = card?.key || "";
        const title = card?.title || key;
        return `- ${title} (${key})`;
      })
      .join("\n");
    const reply = `Concepts:\n${lines}`;
    appendMessage(sessionId, { role: "assistant", content: reply });
    ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
    return true;
  }

  const recentNotesMatch = /^notes\s+recent$/i.test(raw);
  if (recentNotesMatch) {
    const all = readAllCards();
    const notes = all.filter(card => card?.type === "note" && card?.id);
    if (!notes.length) {
      const reply = "I don't have any saved notes yet.";
      appendMessage(sessionId, { role: "assistant", content: reply });
      ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
      return true;
    }
    notes.sort((a, b) => {
      const tsA = noteTimestamp(a) || 0;
      const tsB = noteTimestamp(b) || 0;
      if (tsA !== tsB) return tsB - tsA;
      return (a.id || "").localeCompare(b.id || "");
    });
    const slice = notes.slice(0, 5);
    const lines = slice.map((note, idx) => {
      const topicLabel = preferBucketedTopicLabel(note.topic) || note.topic || "(no topic)";
      const host = resolveNoteHost(note) || "(no host)";
      const summary = formatCardOneLiner(note);
      return `${idx + 1}. ${note.id} | ${topicLabel} | ${host} | ${summary}`;
    });
    const reply = `Recent notes:\n${lines.join("\n")}`;
    appendMessage(sessionId, { role: "assistant", content: reply });
    ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
    setLastNoteList(sessionId, slice.map(note => ({ noteId: note.id })), { context: "recent" });
    return true;
  }

  const notesMatch = raw.match(/^notes\s+([\w\-./:]+)\s*$/i);
  if (notesMatch) {
    const conceptKeyRaw = notesMatch[1].trim();
    const conceptKey = normalizeConceptKey(conceptKeyRaw);
    const concept = findConceptCard(conceptKey);
    if (!concept) {
      const reply = `I don't have concept ${conceptKeyRaw}.`;
      appendMessage(sessionId, { role: "assistant", content: reply });
      ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
      return true;
    }
    const edges = listConceptEdgesForKey(conceptKey);
    if (!edges.length) {
      const reply = `No notes linked to concept "${concept.title || conceptKey}".`;
      appendMessage(sessionId, { role: "assistant", content: reply });
      ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
      return true;
    }
    const all = readAllCards();
    const noteLookup = new Map();
    for (const card of all) {
      if (card?.type === "note" && card?.id) {
        noteLookup.set(card.id, card);
      }
    }
    const lines = [];
    const sorted = edges.slice().sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
    const collected = [];
    for (let idx = 0; idx < sorted.length; idx += 1) {
      const edge = sorted[idx];
      const note = noteLookup.get(edge.note_id);
      if (!note) continue;
      const host = resolveNoteHost(note) || "(no host)";
      const age = formatAgeLabel(noteTimestamp(note) ?? edge.ts);
      const summary = formatCardOneLiner(note);
      lines.push(`${idx + 1}. ${note.id} | ${host} | ${age} | ${summary}`);
      collected.push({ noteId: note.id });
    }
    const reply = lines.length
      ? `Notes for concept "${concept.title || conceptKey}" (${conceptKey}):\n${lines.join("\n")}`
      : `No notes linked to concept "${concept.title || conceptKey}".`;
    appendMessage(sessionId, { role: "assistant", content: reply });
    ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
    if (lines.length) {
      setLastNoteList(sessionId, collected, { context: conceptKey });
    }
    return true;
  }

  return false;
}

function formatCardOneLiner(card) {
  if (!card) return "";
  let summary = "";
  if (typeof card.summary === "string" && card.summary.trim()) {
    summary = card.summary;
  } else if (card.value !== undefined && card.value !== null) {
    if (typeof card.value === "string") {
      summary = card.value;
    } else {
      try {
        summary = JSON.stringify(card.value);
      } catch {
        summary = String(card.value);
      }
    }
  }
  summary = String(summary || "").replace(/\s+/g, " ").trim();
  if (!summary) summary = "[no summary]";
  if (summary.length > 160) summary = `${summary.slice(0, 157)}…`;
  return summary;
}

function buildConceptContextBlock(conceptKey, { limit = 3 } = {}) {
  const normalizedKey = normalizeConceptKey(conceptKey);
  if (!normalizedKey) return { block: "", notes: [], key: "" };
  const edges = listConceptEdgesForKey(normalizedKey);
  if (!edges.length) return { block: "", notes: [], key: normalizedKey };

  const seenIds = new Set();
  const noteEntries = [];
  for (const edge of edges) {
    const note = findNoteCard(edge.note_id);
    if (!note || seenIds.has(note.id)) continue;
    if (note.type && note.type !== "note") continue;
    if (isNoteDemoted(note.id)) continue;
    seenIds.add(note.id);

    const summary = formatCardOneLiner(note);
    const tsCandidates = [
      note.value?.source?.ts,
      note.last_used,
      note.created_at,
      edge.ts
    ];
    let ts = 0;
    for (const candidate of tsCandidates) {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric) && numeric > ts) {
        ts = numeric;
      }
    }
    noteEntries.push({ note, summary, ts });
  }

  if (!noteEntries.length) return { block: "", notes: [], key: normalizedKey };

  noteEntries.sort((a, b) => {
    const tsDiff = (Number(b.ts) || 0) - (Number(a.ts) || 0);
    if (tsDiff !== 0) return tsDiff;
    const confDiff = (Number(b.note?.confidence) || 0) - (Number(a.note?.confidence) || 0);
    if (confDiff !== 0) return confDiff;
    return (a.note?.id || "").localeCompare(b.note?.id || "");
  });

  const closing = "\n[/CONCEPT_CONTEXT]";
  let block = "[CONCEPT_CONTEXT]";
  const included = [];

  for (const entry of noteEntries) {
    if (included.length >= limit) break;
    let lineSummary = entry.summary;
    if (!lineSummary) continue;
    let line = `\n- ${lineSummary}`;
    if (block.length + line.length + closing.length > 400) {
      const available = 400 - block.length - closing.length - 3; // account for prefix and ellipsis
      if (available <= 0) break;
      lineSummary = lineSummary.slice(0, Math.max(0, available)).trim();
      if (!lineSummary) continue;
      if (!/[.!?…]$/.test(lineSummary)) {
        lineSummary = lineSummary.replace(/[\s,;:]+$/, "");
      }
      line = `\n- ${lineSummary}`;
      if (block.length + line.length + closing.length > 400) {
        continue;
      }
    }
    block += line;
    included.push({ card: entry.note, summary: entry.summary, line: lineSummary });
  }

  if (!included.length) return { block: "", notes: [], key: normalizedKey };

  const signature = extractFacetsFromNotes(included, { topN: 3 });
  const rawFacets = Array.isArray(signature?.facets) ? signature.facets : [];
  const facets = (() => {
    const seen = new Set();
    const list = [];
    for (const facet of rawFacets) {
      const display = String(facet || "").trim().replace(/[_\s]+/g, " ").trim();
      if (!display) continue;
      const key = display.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(display);
      if (list.length >= 3) break;
    }
    return list;
  })();

  if (facets.length) {
    const line = `\nKey facets: ${facets.join(", ")}`;
    if (block.length + line.length + closing.length <= 400) {
      block += line;
    }
  }

  block += closing;
  return { block, notes: included, key: normalizedKey, facets };
}

function buildCardContextBlock(cards, fallbackTopic) {
  if (!Array.isArray(cards) || !cards.length) {
    return { block: "", included: [] };
  }
  let block = "[CARD_CONTEXT]";
  const included = [];
  for (const card of cards) {
    if (!card || !card.id) continue;
    const summary = formatCardOneLiner(card);
    const rawTopic = (card.topic || "").toString().trim();
    const topicLabel = (rawTopic || fallbackTopic || "").slice(0, 160);
    const topicValue = topicLabel || "[no topic]";
    const typeLabel = (card.type || "card").toString().trim() || "card";
    const line = `\n- (${typeLabel}) ${topicValue} :: ${summary}`;
    const candidate = `${block}${line}\n[/CARD_CONTEXT]`;
    if (candidate.length > 400) break;
    block += line;
    included.push(card);
  }
  if (!included.length) return { block: "", included: [] };
  block += "\n[/CARD_CONTEXT]";
  return { block, included };
}

function extractPrefKey(text) {
  if (!text) return null;
  const match = String(text).match(/(favorite\s+[a-z0-9][a-z0-9\s-]{0,60}?)(?:[\?!.]|$)/i);
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  return { raw, normalized };
}

function buildNoteFingerprint(note) {
  if (!note || typeof note !== "object") return "";
  const topicKey = normalizeTopicKey(note.topic || note.title || "");
  const summaryKey = String(note.summary || "").trim().toLowerCase();
  const sourceKey = String(note.source?.url || note.url || "").trim().toLowerCase();
  const tsKey = note.ts || note.timestamp || "";
  return [topicKey, summaryKey, sourceKey, tsKey].join("|");
}

function migrateLegacyCardData() {
  let profileCount = 0;
  let prefCount = 0;
  let noteCount = 0;

  const canonicalPrefKey = (value) => {
    if (value === undefined || value === null) return "";
    const raw = String(value).trim();
    if (!raw) return "";
    return raw.toLowerCase();
  };

  const canonicalUserId = (value) => {
    if (value === undefined || value === null) return "";
    const raw = String(value).trim();
    if (!raw) return "";
    return raw.toLowerCase();
  };

  const defaultUserId = (() => {
    const envId = (process.env.DEFAULT_USER_ID || process.env.USER_ID || "").trim();
    if (envId) return envId;
    return "localuser";
  })();

  try {
    const existingCards = readAllCards();
    const existingProfileTopics = new Set();
    const existingPrefKeys = new Set();
    const existingNoteFingerprints = new Set();

    const defaultUserKey = canonicalUserId(defaultUserId);

    for (const card of existingCards) {
      if (!card || typeof card !== "object") continue;
      const normalizedTopic = normalizeTopicKey(card.topic || "");
      const cardUserKey = canonicalUserId(
        card.value?.userId
        || card.value?.legacy?.userId
        || card.value?.profile?.userId
        || card.value?.profile?.id
        || (card.type === "profile" ? String(card.topic || "").replace(/^profile:/i, "") : "")
        || defaultUserId
      );

      if (card.type === "profile") {
        profileCount += 1;
        if (normalizedTopic) existingProfileTopics.add(normalizedTopic);
      } else if (card.type === "pref") {
        prefCount += 1;
        const keyFromValue = canonicalPrefKey(card?.value?.key);
        const topicKey = canonicalPrefKey(String(card.topic || "").replace(/^pref:/i, ""));
        const prefKey = keyFromValue || topicKey;
        if (prefKey) {
          existingPrefKeys.add(`${cardUserKey}::${prefKey}`);
        }
      } else if (card.type === "note") {
        noteCount += 1;
        const fingerprint = card.value?.legacy?.fingerprint || buildNoteFingerprint(card.value?.note || card.value);
        if (fingerprint) {
          existingNoteFingerprints.add(`${cardUserKey}::${fingerprint}`);
        }
      }
    }

    const usersDir = path.resolve("data", "users");
    const userIdMap = new Map();
    const registerUserId = (raw) => {
      const key = canonicalUserId(raw);
      if (!key) return;
      if (!userIdMap.has(key)) {
        userIdMap.set(key, raw);
      }
    };

    registerUserId(defaultUserId);

    if (fs.existsSync(usersDir)) {
      try {
        const entries = fs.readdirSync(usersDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry || !entry.name) continue;
          if (!entry.isDirectory()) continue;
          registerUserId(entry.name);
        }
      } catch (err) {
        console.warn("Failed to scan data/users directory", err);
      }
    }

    const legacyProfilePath = path.resolve("data", "profile.json");
    const legacyNotesPath = path.resolve("data", "notes.jsonl");

    for (const [userKey, userIdRaw] of userIdMap.entries()) {
      const userId = String(userIdRaw || "").trim() || defaultUserId;
      const userDir = path.join(usersDir, userId);

      const profileCandidates = [];
      const profilePath = path.join(userDir, "profile.json");
      if (fs.existsSync(profilePath)) {
        profileCandidates.push({ path: profilePath, source: `users/${userId}/profile.json` });
      }
      if (userKey === defaultUserKey && fs.existsSync(legacyProfilePath)) {
        profileCandidates.push({ path: legacyProfilePath, source: "profile.json" });
      }

      for (const candidate of profileCandidates) {
        try {
          const raw = fs.readFileSync(candidate.path, "utf8");
          const profile = JSON.parse(raw);
          const profileId = String(profile?.id || profile?.user_id || profile?.userId || userId).trim() || userId;
          const topic = `profile:${profileId}`;
          const normalizedTopic = normalizeTopic(topic);
          if (normalizedTopic && existingProfileTopics.has(normalizedTopic)) {
            continue;
          }

          const name = String(profile?.name || "").trim();
          const summaryParts = [];
          if (name) summaryParts.push(`Profile for ${name}`);
          if (profile?.bio) summaryParts.push(String(profile.bio));
          const summary = summaryParts.join(" — ") || `Profile ${profileId}`;
          const entities = [];
          if (name) entities.push(name);
          const profileCard = {
            type: "profile",
            topic,
            summary,
            value: {
              userId,
              profile,
              legacy: { source: candidate.source, userId: userKey }
            },
            tags: Array.from(new Set(["profile", `user:${userId}`])),
            entities,
            confidence: 0.75
          };
          persistCard(profileCard);
          profileCount += 1;
          if (normalizedTopic) existingProfileTopics.add(normalizedTopic);

          if (profile && typeof profile.prefs === "object" && profile.prefs !== null) {
            for (const [rawKey, value] of Object.entries(profile.prefs)) {
              const cleanKey = String(rawKey || "").trim();
              if (!cleanKey) continue;
              const prefKey = canonicalPrefKey(cleanKey);
              if (!prefKey) continue;
              const dedupeKey = `${userKey}::${prefKey}`;
              if (existingPrefKeys.has(dedupeKey)) continue;

              let renderedValue = "";
              if (typeof value === "string") {
                renderedValue = value;
              } else {
                try {
                  renderedValue = JSON.stringify(value);
                } catch {
                  renderedValue = String(value);
                }
              }

              const topicPref = `pref:${prefKey}`;
              const summary = `Preference for ${cleanKey}: ${renderedValue}`.trim();
              const tags = Array.from(new Set([
                "pref",
                cleanKey,
                prefKey,
                `user:${userId}`
              ].map(tag => String(tag || "").trim()).filter(Boolean)));
              const prefCard = {
                type: "pref",
                topic: topicPref,
                summary,
                value: {
                  key: cleanKey,
                  value,
                  userId,
                  legacy: { source: candidate.source, userId: userKey }
                },
                tags,
                entities: [],
                confidence: 0.6
              };
              persistCard(prefCard);
              existingPrefKeys.add(dedupeKey);
              prefCount += 1;
            }
          }
        } catch (err) {
          console.warn(`Failed to migrate ${candidate.source}`, err);
        }
      }

      const notesCandidates = [];
      const notesPath = path.join(userDir, "notes.jsonl");
      if (fs.existsSync(notesPath)) {
        notesCandidates.push({ path: notesPath, source: `users/${userId}/notes.jsonl` });
      }
      if (userKey === defaultUserKey && fs.existsSync(legacyNotesPath)) {
        notesCandidates.push({ path: legacyNotesPath, source: "notes.jsonl" });
      }

      for (const candidate of notesCandidates) {
        try {
          const raw = fs.readFileSync(candidate.path, "utf8");
          const lines = raw.split(/\r?\n/);
          for (const [idx, line] of lines.entries()) {
            if (!line || !line.trim()) continue;
            let note;
            try {
              note = JSON.parse(line);
            } catch (err) {
              console.warn(`Failed to parse ${candidate.source} row ${idx + 1}`, err);
              continue;
            }
            if (!note || typeof note !== "object") continue;

            const fingerprint = buildNoteFingerprint(note);
            const dedupeKey = fingerprint ? `${userKey}::${fingerprint}` : "";
            if (dedupeKey && existingNoteFingerprints.has(dedupeKey)) continue;

            const topicRaw = String(note.topic || note.title || "").trim();
            const summaryRaw = String(note.summary || note.content || note.body || note.text || "").trim();
            if (!topicRaw && !summaryRaw) continue;

            const topic = topicRaw || summaryRaw;
            let summary = summaryRaw || topicRaw;
            summary = summary.replace(/\s+/g, " ").trim();
            if (summary.length > 400) {
              summary = `${summary.slice(0, 397)}…`;
            }

            const tsRaw = note.ts ?? note.timestamp ?? note.date ?? null;
            const tsNumber = Number(tsRaw);
            const lastUsed = Number.isFinite(tsNumber) ? tsNumber : Date.now();

            const tagSet = new Set(["note", `user:${userId}`]);
            if (Array.isArray(note.tags)) {
              for (const tag of note.tags) {
                const clean = String(tag || "").trim();
                if (clean) tagSet.add(clean);
              }
            }

            const entitySet = new Set();
            if (Array.isArray(note.entities)) {
              for (const entity of note.entities) {
                const clean = String(entity || "").trim();
                if (clean) entitySet.add(clean);
              }
            }

            const sourceUrl = String(note?.source?.url || note?.url || "").trim();
            const value = {
              note,
              userId,
              legacy: { source: candidate.source, fingerprint, userId: userKey }
            };
            if (sourceUrl) {
              value.source = { url: sourceUrl };
            }

            const noteCard = {
              type: "note",
              topic,
              summary,
              value,
              tags: Array.from(tagSet),
              entities: Array.from(entitySet),
              confidence: (() => {
                const numeric = Number(note.confidence);
                return Number.isFinite(numeric) ? numeric : 0.5;
              })(),
              last_used: lastUsed
            };

            persistCard(noteCard);
            if (dedupeKey) existingNoteFingerprints.add(dedupeKey);
            noteCount += 1;
          }
        } catch (err) {
          console.warn(`Failed to migrate ${candidate.source}`, err);
        }
      }
    }
  } catch (err) {
    console.warn("Card migration failed", err);
  } finally {
    console.log(`cards_boot {profile:${profileCount}, prefs:${prefCount}, notes:${noteCount}}`);
  }
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

function getSeenHostState(sessionId, topic) {
  const now = Date.now();
  let sessionState = sessionTopicSeenHosts.get(sessionId);
  if (!sessionState) {
    sessionState = { topics: new Map(), lastTopic: topic };
    sessionTopicSeenHosts.set(sessionId, sessionState);
  }
  if (sessionState.lastTopic !== topic) {
    sessionState.lastTopic = topic;
    sessionState.topics = new Map();
  }
  let state = sessionState.topics.get(topic);
  if (!state || !Array.isArray(state.sets) || state.expiresAt <= now) {
    state = { sets: [new Set(), new Set()], expiresAt: now + SEEN_HOST_TTL };
    sessionState.topics.set(topic, state);
  }
  return state;
}

function getSeenHostUnion(sessionId, topic) {
  const state = getSeenHostState(sessionId, topic);
  const union = new Set();
  for (const bucket of state.sets || []) {
    if (!(bucket instanceof Set)) continue;
    for (const host of bucket) {
      if (host) union.add(host);
    }
  }
  const canonical = normalizeTopicKey(topic || "", "news");
  if (canonical) {
    const persistent = getPersistentSeenHosts(canonical);
    for (const host of persistent.hosts) {
      union.add(host);
    }
  }
  return { state, union };
}

function updateSeenHosts(sessionId, topic, hosts = []) {
  const { state } = getSeenHostUnion(sessionId, topic);
  const normalized = Array.from(new Set(hosts.filter(Boolean).map(h => h.toLowerCase())));
  const fresh = new Set(normalized);
  const tail = Array.isArray(state.sets) ? state.sets.filter(bucket => bucket instanceof Set && bucket.size > 0) : [];
  state.sets = [fresh, ...(tail.slice(0, 1))];
  state.expiresAt = Date.now() + SEEN_HOST_TTL;
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

function computeFrequencyScore(touches) {
  const count = Number(touches);
  if (!Number.isFinite(count) || count <= 0) return 0;
  const normalized = count / 5;
  if (normalized >= 1) return 1;
  if (normalized <= 0) return 0;
  return normalized;
}

function parseJsonish(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractDirectNoteCommand(text) {
  if (!text) return null;
  const raw = String(text);
  const tagMatch = raw.match(/\[\[NOTE\]\]\s*({[\s\S]*})/i);
  if (tagMatch) {
    const payload = parseJsonish(tagMatch[1]);
    if (payload && typeof payload === "object") {
      return { payload, explicitness: 1, reason: "user_note_tag" };
    }
  }
  const saveMatch = raw.match(/\bsave\s+note\b/i);
  if (saveMatch) {
    const braceStart = raw.indexOf("{", saveMatch.index);
    const braceEnd = raw.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd > braceStart) {
      const payload = parseJsonish(raw.slice(braceStart, braceEnd + 1));
      if (payload && typeof payload === "object") {
        return { payload, explicitness: 1, reason: "user_save_note" };
      }
    }
  }
  return null;
}

function extractNoteShortcutCommand(text) {
  if (typeof text !== "string") return null;
  const raw = text.trim();
  if (!raw) return null;

  const listMatch = raw.match(/^save\s+note\s+#(\d+)[:\s]+(.+)$/i);
  if (listMatch) {
    const summary = listMatch[2].trim();
    if (!summary) return null;
    const index = Number(listMatch[1]);
    if (!Number.isFinite(index) || index < 1) return null;
    return { kind: "list_item", index, summary };
  }

  const lastSummaryMatch = raw.match(/^save\s+note\s+from\s+last\s+summary\s*:\s*(.+)$/i);
  if (lastSummaryMatch) {
    const summary = lastSummaryMatch[1].trim();
    if (!summary) return null;
    return { kind: "last_summary", summary };
  }

  const linkMatch = raw.match(/^save\s+note\s*:\s*(.+)$/i);
  if (linkMatch) {
    const remainder = linkMatch[1];
    const linkPhrase = remainder.match(/^(.*?)(?:;\s*)?source\s+is\s+that\s+link[\.!?]?$/i);
    if (linkPhrase) {
      const summary = linkPhrase[1].trim();
      if (!summary) return null;
      return { kind: "last_link", summary };
    }
  }

  return null;
}

function rememberLastSummary(sessionId, info) {
  if (!sessionId) return;
  if (!info || !info.url) return;
  const url = String(info.url).trim();
  if (!url) return;
  const title = String(info.title || "").trim();
  const topic = String(info.topic || "").trim();
  const host = info.host ? String(info.host).trim() : extractDomain(url) || "";
  const conceptKey = normalizeConceptKey(info.conceptKey || "");
  const record = {
    url,
    title,
    topic,
    host,
    conceptKey,
    ts: Date.now()
  };
  sessionLastSummary.set(sessionId, record);
  const sessionState = getSessionState(sessionId);
  sessionState.lastSummary = record;
  if (conceptKey) {
    sessionState.currentTopic = conceptKey;
  }
}

function getLastSummary(sessionId) {
  if (!sessionId) return null;
  const stored = sessionLastSummary.get(sessionId);
  if (!stored) return null;
  if (!stored.url) return null;
  return stored;
}

function sanitizeNoteSource(source) {
  if (!source || typeof source !== "object") return null;
  const url = String(source.url || source.href || "").trim();
  if (!url) return null;
  const sanitized = { url };
  if (source.title) {
    const title = String(source.title).replace(/[\r\n]+/g, " ").trim();
    if (title) sanitized.title = title.slice(0, 200);
  }
  if (source.source_url) {
    const alias = String(source.source_url).trim();
    if (alias) sanitized.source_url = alias;
  }
  const ts = Number(source.ts ?? source.timestamp ?? source.accessed_at);
  if (Number.isFinite(ts)) sanitized.ts = ts;
  if (source.note_id) sanitized.note_id = String(source.note_id);
  return sanitized;
}

function findNearDuplicateNote(conceptKey, fingerprint) {
  const normalizedKey = normalizeConceptKey(conceptKey);
  const candidateHash = fingerprint?.simhash;
  const normalizedText = typeof fingerprint?.normalized === "string" ? fingerprint.normalized : "";
  if (!normalizedKey || !candidateHash) return null;
  const edges = listConceptEdgesForKey(normalizedKey);
  if (!edges.length) return null;
  let closest = null;
  for (const edge of edges) {
    const note = findNoteCard(edge.note_id);
    if (!note || note.type !== "note") continue;
    let existingHash = typeof note.value?.metadata?.simhash === "string" ? note.value.metadata.simhash.trim() : "";
    let existingNormalized = typeof note.value?.metadata?.normalized_summary === "string"
      ? note.value.metadata.normalized_summary
      : "";
    if (!existingHash || !existingNormalized) {
      const computed = computeNoteFingerprint(note);
      if (!existingHash && computed?.simhash) existingHash = computed.simhash;
      if (!existingNormalized && computed?.normalized) existingNormalized = computed.normalized;
    }
    if (!existingHash) continue;
    if (normalizedText && existingNormalized && normalizedText === existingNormalized) {
      return { noteId: note.id, distance: 0 };
    }
    const distance = simhashDistance(existingHash, candidateHash);
    if (!Number.isFinite(distance)) continue;
    if (distance <= SIMHASH_DUP_THRESHOLD) {
      if (!closest || distance < closest.distance) {
        closest = { noteId: note.id, distance };
        if (distance === 0) break;
      }
    }
  }
  return closest;
}

function saveNoteCardFromPayload({ payload, explicitness, userId, sessionId, run, reason, topicHint, autoResearch = false }) {
  if (!payload || typeof payload !== "object") {
    return { saved: false, error: "invalid_payload" };
  }

  const now = Date.now();
  const rawTopic = typeof payload.topic === "string" && payload.topic.trim().length ? payload.topic : "";
  const rawSummary = typeof payload.summary === "string" ? payload.summary : "";
  const fallbackTopic = typeof topicHint === "string" ? topicHint : "";
  let topic = rawTopic.trim();
  if (!topic && fallbackTopic) topic = fallbackTopic.trim();
  const summaryClean = rawSummary.replace(/[\r\n]+/g, " ").trim();
  if (!topic && !summaryClean) {
    return { saved: false, error: "missing_content" };
  }
  const finalTopic = (topic || summaryClean).slice(0, 200);
  const trimmedSummary = (summaryClean || finalTopic).slice(0, 400);
  if (!trimmedSummary) {
    return { saved: false, error: "missing_summary" };
  }

  const canonicalTopic = normalizeTopicKey(finalTopic, "news");
  const topicForCard = canonicalTopic || finalTopic;

  const sanitizedSource = sanitizeNoteSource(payload.source || payload);
  if (!sanitizedSource) {
    return { saved: false, error: "missing_source_url" };
  }

  let ttlDays = payload.ttl_days;
  if (ttlDays !== undefined && ttlDays !== null) {
    const ttlNum = Number(ttlDays);
    ttlDays = Number.isFinite(ttlNum) && ttlNum > 0 ? ttlNum : 30;
  } else {
    ttlDays = 30;
  }

  const tsCandidate = Number(payload.ts ?? payload.timestamp ?? run?.ts);
  const ageMs = Number.isFinite(tsCandidate) ? Math.max(0, Date.now() - tsCandidate) : null;
  const recency = ageMs === null ? 1 : recencyFromAge(ageMs);

  const topicKey = normalizeTopicKey(topicForCard, "news") || normalizeTopic(topicForCard);
  let touches = 0;
  if (topicKey) {
    const state = getTopicState(sessionId, topicKey);
    touches = Number(state?.runCount || 0);
  }
  const frequency = computeFrequencyScore(touches);

  const docChars = Number(run?.result_summary?.chars ?? payload.source?.chars ?? 0);
  const summaryChars = trimmedSummary.length;
  let taskGain = 0;
  if (docChars > 0 && summaryChars > 0) {
    const reduction = Math.max(0, 1 - Math.min(1, summaryChars / docChars));
    taskGain = docChars >= 800 ? Math.max(reduction, 0.8) : reduction;
  }

  const metrics = { explicitness: Number(explicitness) || 0, recency, frequency, taskGain };
  const score = scoreImportance(metrics);

  const autoContext = autoResearch ? getAutoResearchContext(sessionId) : null;
  if (autoContext) {
    autoContext.lastScore = score;
    autoContext.lastSummary = trimmedSummary;
    autoContext.lastUrl = sanitizedSource.url;
    autoContext.candidate = null;
    autoContext.lastError = null;
  }

  if (autoResearch) {
    const currentCount = getAutoResearchNoteCount(sessionId);
    if (currentCount >= MAX_AUTO_NOTES_PER_SESSION) {
      if (autoContext) {
        autoContext.lastError = "auto_limit";
      }
      return { saved: false, error: "auto_note_limit", score, metrics };
    }
  }

  const entitiesRaw = Array.isArray(payload.entities) ? payload.entities : [];
  const entities = entitiesRaw
    .map(value => String(value || "").trim())
    .filter(Boolean)
    .slice(0, 6);

  const card = {
    type: "note",
    topic: topicForCard,
    summary: trimmedSummary,
    value: {
      source: sanitizedSource,
      data: {
        ...payload,
        topic: topicForCard,
        summary: trimmedSummary
      },
      metadata: {
        saved_by: (Number(explicitness) || 0) >= 1 ? "user" : "model",
        reason: reason || "",
        run_id: run?.id || null,
        metrics,
        saved_at: now
      }
    },
    tags: ["note"],
    entities,
    confidence: (Number(explicitness) || 0) >= 1 ? 0.7 : 0.6,
    created_at: now,
    last_used: now,
    ttl_days: ttlDays
  };

  const payloadConfidence = Number(payload.confidence);
  if (Number.isFinite(payloadConfidence)) {
    const bounded = Math.max(0, Math.min(1, payloadConfidence));
    card.confidence = bounded;
  }

  const fingerprint = computeNoteFingerprint(card);
  if (fingerprint?.simhash) {
    card.value.metadata.simhash = fingerprint.simhash;
  }
  if (fingerprint?.normalized) {
    card.value.metadata.normalized_summary = fingerprint.normalized;
  }

  const inferredConcept = inferConceptKey(card);
  let conceptKey = "";
  if (inferredConcept) {
    const colonIdx = inferredConcept.indexOf(":");
    const body = colonIdx >= 0 ? inferredConcept.slice(colonIdx + 1) : inferredConcept;
    conceptKey = normalizeConceptKey(body);
  }

  if (!shouldSave(card, metrics)) {
    if (autoContext) {
      autoContext.lastError = "score_low";
      autoContext.candidate = { summary: trimmedSummary, url: sanitizedSource.url, score };
    }
    return { saved: false, error: "score_low", score, metrics, conceptKey };
  }

  if (autoResearch && conceptKey && isConceptAutoWritePaused(conceptKey)) {
    if (autoContext) {
      autoContext.lastError = "paused_low_utility";
    }
    return { saved: false, error: "auto_paused", score, metrics, conceptKey };
  }

  if (conceptKey && fingerprint?.simhash) {
    const duplicate = findNearDuplicateNote(conceptKey, fingerprint);
    if (duplicate) {
      if (autoContext) {
        autoContext.lastError = "duplicate";
      }
      return { saved: false, error: "duplicate_note", score, metrics, conceptKey, duplicate };
    }
  }

  const id = persistCard(card);
  if (!id) {
    if (autoContext) {
      autoContext.lastError = "persist_failed";
    }
    return { saved: false, error: "persist_failed", score, metrics, conceptKey };
  }

  if (topicKey) {
    resolveWatch(topicKey, id);
  }

  if (autoResearch) {
    incrementAutoResearchNoteCount(sessionId);
    if (autoContext) {
      autoContext.wrote = true;
      autoContext.lastError = null;
    }
  }

  const logReason = reason || ((Number(explicitness) || 0) >= 1 ? "user_reply" : "");
  logCardWrite({ ts: now, type: card.type, topic: card.topic, score, reason: logReason });
  return { saved: true, card: { ...card, id }, score, metrics, conceptKey };
}

function formatScore(score) {
  if (!Number.isFinite(score)) return "0.60";
  const clamped = Math.max(0, Math.min(1, score));
  return clamped.toFixed(2);
}

function isGreeting(s) { return /^\s*(hi|hello|hey|howdy|yo|sup|hiya|hellooo)\s*[!?\.]*\s*$/i.test(s || ""); }

const LIST_INTENT_REGEX = /^\s*(find|show|list|look up)\s+(more\s+)?(web\s*sites|websites|sites|sources|articles)\b/i;
const LIST_ABOUT_FALLBACK_REGEX = /^\s*(find|show|list)\s+.*\babout\b\s+(.+)/i;
const LATEST_ON_REGEX = /^\s*(?:what(?:'s| is)?\s+)?(?:the\s+)?latest\s+(?:on|about)\s+(.+)/i;

function detectListIntent(text) {
  const raw = String(text || "");
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const mainMatch = trimmed.match(LIST_INTENT_REGEX);
  if (mainMatch) {
    let remainder = trimmed.slice(mainMatch[0].length).trim();
    if (!remainder) {
      const aboutMatch = trimmed.match(/\babout\b\s+(.+)/i);
      if (aboutMatch) remainder = aboutMatch[1].trim();
    }
    remainder = remainder.replace(/^(about|on|regarding)\s+/i, "").trim();
    const hasTopic = remainder.length > 0;
    const fallback = raw.replace(LIST_INTENT_REGEX, "").trim();
    const fallbackValid = fallback && fallback !== trimmed ? fallback : "";
    const query = hasTopic ? remainder : fallbackValid;
    return { query, topicless: !hasTopic };
  }

  const aboutFallback = trimmed.match(LIST_ABOUT_FALLBACK_REGEX);
  if (aboutFallback) {
    const query = (aboutFallback[2] || "").trim();
    return { query: query || trimmed, topicless: false };
  }

  const latestOn = trimmed.match(LATEST_ON_REGEX);
  if (latestOn) {
    let remainder = (latestOn[1] || "").trim();
    remainder = remainder.replace(/[?!.]+$/g, "").trim();
    return { query: remainder || trimmed, topicless: false };
  }

  return null;
}

function wantsListOnly(text) { return Boolean(detectListIntent(text)); }

function cleanConceptPhrase(text) {
  if (!text) return "";
  return String(text)
    .replace(/^[\s,;:\-]+/, "")
    .replace(/[?!.\s]+$/g, "")
    .trim();
}

function extractConceptPhrases(text) {
  const raw = typeof text === "string" ? text : "";
  if (!raw.trim()) return [];
  const normalized = raw.replace(/\s+/g, " ");
  const phrases = new Set();

  const push = (value) => {
    const cleaned = cleanConceptPhrase(value);
    if (!cleaned) return;
    if (cleaned.length < 3) return;
    phrases.add(cleaned);
  };

  const patterns = [
    /(?:two[-\s]?sentence|brief|quick|short)?\s*update\s+(?:on|about|regarding)\s+([^?!.]+)/gi,
    /(?:what(?:'s| is)?\s+)?(?:the\s+)?latest\s+(?:on|about|regarding)\s+([^?!.]+)/gi,
    /(?:news|info|information|story|coverage|background|recap)\s+(?:on|about|regarding)\s+([^?!.]+)/gi,
    /(?:summary|recap)\s+(?:on|about|regarding)\s+([^?!.]+)/gi,
    /\b(?:on|about|regarding)\s+([^?!.]+?)(?:\?|$)/gi
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(normalized))) {
      if (match && match[1]) {
        push(match[1]);
      }
    }
  }

  const quoteRegex = /["“”'‘’]([^"“”'‘’]{3,})["“”'‘’]/g;
  let quoteMatch;
  while ((quoteMatch = quoteRegex.exec(normalized))) {
    if (quoteMatch && quoteMatch[1]) {
      push(quoteMatch[1]);
    }
  }

  return Array.from(phrases);
}

function conceptKeyFromText(text) {
  const normalizedTopicKey = normalizeTopicKey(text, "news");
  if (!normalizedTopicKey) return "";
  const colonIdx = normalizedTopicKey.indexOf(":");
  const body = colonIdx >= 0 ? normalizedTopicKey.slice(colonIdx + 1) : normalizedTopicKey;
  return normalizeConceptKey(body);
}

function gatherConceptKeyCandidates({ content = "", topic = "", listIntent = null } = {}) {
  const candidates = new Map();
  const addCandidate = (value, weight = 1) => {
    if (!value) return;
    const key = conceptKeyFromText(value);
    if (!key) return;
    const existing = candidates.get(key);
    if (!existing || weight > existing.weight) {
      candidates.set(key, { key, weight });
    }
  };

  addCandidate(content, 1);
  if (topic) addCandidate(topic, 1.4);
  if (listIntent?.query) addCandidate(listIntent.query, 1.6);

  const focusPhrases = extractConceptPhrases(content);
  let phraseWeight = 1.3;
  for (const phrase of focusPhrases) {
    addCandidate(phrase, phraseWeight);
    phraseWeight = Math.max(1.05, phraseWeight - 0.05);
  }

  return Array.from(candidates.values())
    .sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return a.key.localeCompare(b.key);
    })
    .map(entry => entry.key);
}

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
    const rawContent = (msg.content || "").toString().slice(0, 8000);
    const segments = rawContent.split(/\r?\n+/).map(line => line.trim()).filter(Boolean);
    const messagesToProcess = segments.length > 1
      ? segments.map(segment => ({ ...msg, content: segment }))
      : [{ ...msg, content: rawContent }];

    const turnConceptStats = new Map();
    const turnTokenMeter = { concept: 0, search: 0 };
    const bumpTurnConcept = (key, delta = {}) => {
      const str = typeof key === "string" ? key.trim() : String(key || "").trim();
      if (!str) return;
      const existing = turnConceptStats.get(str) || { used: 0, saved: 0 };
      if (delta.used) existing.used += Number(delta.used) || 0;
      if (delta.saved) existing.saved += Number(delta.saved) || 0;
      turnConceptStats.set(str, existing);
    };
    const registerConceptUsage = (key, count = 0, blockLength = 0) => {
      if (count > 0) {
        bumpTurnConcept(key, { used: count });
      }
      if (blockLength > 0) {
        const est = Math.max(1, Math.round(blockLength / 4));
        turnTokenMeter.concept += est;
      }
    };
    const registerConceptSave = (key, count = 1) => {
      if (count <= 0) return;
      bumpTurnConcept(key, { saved: count });
    };
    const registerSearchTokens = (tokens = 0) => {
      const numeric = Number(tokens);
      if (!Number.isFinite(numeric) || numeric <= 0) return;
      turnTokenMeter.search += Math.round(numeric);
    };
    const turnHooks = { registerConceptUsage, registerConceptSave, registerSearchTokens };
    let turnFinalized = false;
    const finalizeTurn = () => {
      if (turnFinalized) return;
      finalizeConceptTurn(ws, turnConceptStats, turnTokenMeter);
      turnFinalized = true;
    };

    const handleUserMessage = async (messageObj) => {
          const content = (messageObj.content || "").toString().slice(0, 8000);
          const inReplyToGap = messageObj.in_reply_to_gap || null;
            const topic = normalizeTopic(content);
            const ensuredTopicKey = ensureTopic(content, sessionId);
            if (sessionId) {
              const sessionState = getSessionState(sessionId);
              sessionState.currentTopic = ensuredTopicKey;
            }
            const trimmedContent = content.trim();
            const refreshMatch = trimmedContent.match(/^refresh(?:\s+(.+))?$/i);
            const refreshArg = refreshMatch ? (refreshMatch[1] || "").trim() : "";
            const freshRegexCue = FRESH_CUE_REGEX.test(content);
            let freshCue = freshRegexCue;
            if (refreshMatch) freshCue = true;
            if (TWO_SENTENCE_REGEX.test(content) && !freshRegexCue) {
              freshCue = false;
            }
            let freshnessAction = "none";
            let freshnessTopic = topic;
            let freshnessTopicSource = "message";
            let note = null;
            let stale = false;
            let conceptContextBlock = "";
            let conceptContextNotes = [];
            let conceptContextKey = "";
            let conceptContextFacets = [];
            let freshnessEventSent = false;
            const sendFreshnessEvent = () => {
              if (freshnessEventSent) return;
              const canonicalTopic = freshnessTopic ? normalizeTopicKey(freshnessTopic, "news") : "";
              emitEventLog(ws, "freshness_gate", {
                cue: Boolean(freshCue),
                note: Boolean(note),
                stale: Boolean(stale),
                action: freshnessAction,
                topic: canonicalTopic
              });
              freshnessEventSent = true;
            };
      
          const shortcutNote = extractNoteShortcutCommand(content);
          if (shortcutNote) {
            appendMessage(sessionId, { role: "user", content });
            const summary = shortcutNote.summary.trim().slice(0, 400);
            if (!summary) {
              ws.send(JSON.stringify({ type: "note_rejected", reason: "missing_summary" }));
              const reply = "I need a short summary to save that note.";
              appendMessage(sessionId, { role: "assistant", content: reply });
              ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
              sendFreshnessEvent();
              return;
            }
      
            let payload = null;
            let topicHint = summary;
            let rejectMessage = "";
            let rejectReason = "invalid_note_command";
            let savedListIndex = null;
            let noteTopicLabel = "";
            let lastSummaryConceptKey = "";
      
            if (shortcutNote.kind === "list_item") {
              const sessionCtx = getLastListContext(sessionId);
              const idx = shortcutNote.index - 1;
              const listItems = Array.isArray(sessionCtx?.lastList?.items) ? sessionCtx.lastList.items : [];
              const topicKey = sessionCtx?.lastTopicKey ? String(sessionCtx.lastTopicKey).trim() : "";
              const item = listItems[idx];
              if (item && item.url && topicKey) {
                noteTopicLabel = topicKey;
                const source = { url: item.url };
                if (item.title) source.title = item.title;
                payload = { topic: topicKey, summary, source };
                topicHint = topicKey;
                savedListIndex = shortcutNote.index;
              } else {
                if (!sessionCtx || !Array.isArray(sessionCtx?.lastList?.items) || !sessionCtx.lastList.items.length) {
                  rejectMessage = "I don't have a recent list to pull from.";
                  rejectReason = "no_list";
                } else if (!Number.isFinite(idx) || idx < 0 || idx >= listItems.length) {
                  rejectMessage = "unknown with current context.";
                  rejectReason = "out_of_range";
                } else if (!item?.url) {
                  rejectMessage = `I don't have a link for list item #${shortcutNote.index}.`;
                  rejectReason = "missing_source_url";
                } else {
                  rejectMessage = "I don't have a topic saved for that list.";
                  rejectReason = "missing_topic";
                }
              }
            } else if (shortcutNote.kind === "last_summary" || shortcutNote.kind === "last_link") {
              const last = getLastSummary(sessionId);
              if (last && last.url) {
                const topicRecord = getSessionTopicRecord(sessionId);
                const summaryConceptKey = toConceptKey(last.conceptKey);
                const activeConceptKey = toConceptKey(topicRecord.active);
                const lastListConceptKey = getSlotConceptKey(topicRecord.lastList);
                const sessionState = getSessionState(sessionId);
                const conceptKey = shortcutNote.kind === "last_summary"
                  ? (sessionState.currentTopic || summaryConceptKey || activeConceptKey || lastListConceptKey)
                  : "";
                if (conceptKey) {
                  lastSummaryConceptKey = conceptKey;
                }
                const topicCandidate = conceptKey ? detokenizeTopicKey(conceptKey) : (last.title || summary);
                const topicValue = topicCandidate ? String(topicCandidate).trim() : summary;
                const topicFinal = topicValue || summary;
                noteTopicLabel = topicFinal;
                const source = { url: last.url, source_url: last.url };
                if (last.title) source.title = last.title;
                if (last.host) source.host = last.host;
                payload = { topic: topicFinal, summary, source };
                topicHint = conceptKey || topicFinal;
              } else {
                ws.send(JSON.stringify({ type: "note_rejected", reason: "missing_source_url" }));
                sendGapPrompt(ws, {
                  userId,
                  sessionId,
                  prompt: "Which source? (paste a link or say #n)",
                  q: "Need a source for the last summary note",
                  why: "User asked to save a note without an available link"
                });
                sendFreshnessEvent();
                return;
              }
            }
      
            if (!payload) {
              const reason = rejectMessage ? rejectReason : "invalid_note_command";
              ws.send(JSON.stringify({ type: "note_rejected", reason }));
              const reply = rejectMessage || "I couldn't save that note.";
              appendMessage(sessionId, { role: "assistant", content: reply });
              ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
              if (reason === "out_of_range") {
                sendKdn(ws, sessionId, { state: "DK", reason: "explicit unknown", ambiguous: false });
              }
              sendFreshnessEvent();
              return;
            }
      
            const result = saveNoteCardFromPayload({
              payload,
              explicitness: 1,
              userId,
              sessionId,
              run: null,
              reason: "user_reply",
              topicHint
            });
      
            if (result.saved) {
              const sessionAckTopic = savedListIndex !== null
                ? getLastListContext(sessionId)?.lastTopicKey || noteTopicLabel
                : null;
              const fallbackAck = noteTopicLabel || result.card.topic || "";
              const ackTopic = (() => {
                const raw = savedListIndex !== null ? sessionAckTopic : fallbackAck;
                if (typeof raw === "string") return raw.trim();
                return String(raw || "");
              })();
              ws.send(JSON.stringify({
                type: "note_saved",
                note: { topic: result.card.topic, score: Number(result.score ?? 0) }
              }));
              const noteId = result.card?.id ? String(result.card.id).trim() : "";
              const idSuffix = noteId ? ` id:${noteId}` : "";
              const successMsg = savedListIndex !== null
                ? `note_saved: "${ackTopic}" (#${savedListIndex})${idSuffix ? ` ${idSuffix}` : ""}`
                : `note_saved: "${ackTopic || result.card.topic}"${idSuffix ? ` ${idSuffix}` : ""}`;
              appendMessage(sessionId, { role: "assistant", content: successMsg });
              ws.send(JSON.stringify({ type: "assistant_message", content: successMsg }));
              if (noteId) {
                rememberLastSavedNoteId(sessionId, noteId);
              }
              const linkResult = autoLinkNoteToTopic(ws, sessionId, result.card);
              const inspectorTopic = shortcutNote.kind === "last_summary"
                ? (lastSummaryConceptKey || linkResult?.conceptKey || "")
                : (linkResult?.conceptKey || "");
              const inspectorSource = shortcutNote.kind === "last_summary"
                ? "lastSummary"
                : (linkResult?.source || "");
              emitInspectorEvent(ws, "user_note_attributed", {
                topic: inspectorTopic,
                source: inspectorSource
              });
              maybeSuggestConceptLink(ws, sessionId, result.card);
              maybeProposeAnalogyFromNote(ws, sessionId, result.card, linkResult?.conceptKey);
              if (updateLastEpisode({ note_saved: true })) {
                ws.send(JSON.stringify({ type: "learning_stats", stats: recentStats(20) }));
              }
            } else {
              const reason = result.error || "unknown";
              ws.send(JSON.stringify({ type: "note_rejected", reason }));
              const reply = reason === "duplicate_note"
                ? "That note is very similar to one I already saved for this concept."
                : "I couldn't save that note.";
              appendMessage(sessionId, { role: "assistant", content: reply });
              ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
            }
            sendFreshnessEvent();
            return;
          }
      
          const directNote = extractDirectNoteCommand(content);
          if (directNote) {
            appendMessage(sessionId, { role: "user", content });
            const result = saveNoteCardFromPayload({
              payload: directNote.payload,
              explicitness: directNote.explicitness,
              userId,
              sessionId,
              run: null,
              reason: directNote.reason,
              topicHint: directNote.payload?.topic || content
            });
            if (result.saved) {
              ws.send(JSON.stringify({
                type: "note_saved",
                note: { topic: result.card.topic, score: Number(result.score ?? 0) }
              }));
              if (result.card?.id) {
                rememberLastSavedNoteId(sessionId, result.card.id);
              }
              const linkResult = autoLinkNoteToTopic(ws, sessionId, result.card);
              emitInspectorEvent(ws, "user_note_attributed", {
                topic: linkResult?.conceptKey || "",
                source: linkResult?.source || ""
              });
              maybeSuggestConceptLink(ws, sessionId, result.card);
              maybeProposeAnalogyFromNote(ws, sessionId, result.card, linkResult?.conceptKey);
              if (updateLastEpisode({ note_saved: true })) {
                ws.send(JSON.stringify({ type: "learning_stats", stats: recentStats(20) }));
              }
            } else {
              const reason = result.error || "unknown";
              ws.send(JSON.stringify({
                type: "note_rejected",
                reason
              }));
              if (reason === "duplicate_note") {
                const reply = "That note looks like a duplicate of what I already have.";
                appendMessage(sessionId, { role: "assistant", content: reply });
                ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
              }
            }
            sendFreshnessEvent();
            return;
          }
      
          let cards = topic ? getTopByTopic(topic, { limit: 3 }) : [];
          cards = cards.filter(card => {
            if (!card || card.type !== "note") return true;
            return !isNoteDemoted(card.id);
          });
          const cardsById = new Map();
          for (const card of cards) {
            if (card && card.id) {
              cardsById.set(card.id, card);
            }
          }
          note = cards.find(card => card?.type === "note") || null;
          stale = note ? isStale(note, FRESH_TTL_DAYS) : false;
          const wantsNameAnswer = /\bwhat(?:'|’)?s my name\b/i.test(content) || /\bwho am i\b/i.test(content);
          let listIntent = detectListIntent(content);
          const prefKeyInfo = extractPrefKey(content);
          const profileTopicNormalized = normalizeTopic(`profile:${userId}`);
          const routerIntent = listIntent ? "list" : (freshCue ? "fresh" : "chat");
          try {
            await ensureCard(ensuredTopicKey, routerIntent, { sessionId, userId });
          } catch (err) {
            console.warn("ensure_card_failed", err);
          }
          const touchedCardIds = new Set();
          let cardsUsageLogged = false;
          const touchCardOnce = (card) => {
            if (!card || !card.id) return;
            if (touchedCardIds.has(card.id)) return;
            touch(card.id);
            touchedCardIds.add(card.id);
          };
          const tryAddCardsFromTopic = (topicKey) => {
            if (!topicKey || cards.length >= 3) return;
            if (topicKey === topic) return;
            const extras = getTopByTopic(topicKey, { limit: 3 });
            for (const extra of extras) {
              if (!extra || !extra.id || cardsById.has(extra.id)) continue;
              cards.push(extra);
              cardsById.set(extra.id, extra);
              if (cards.length >= 3) break;
            }
          };
          if (cards.length < 3 && wantsNameAnswer) {
            tryAddCardsFromTopic(profileTopicNormalized);
          }
          if (cards.length < 3 && prefKeyInfo?.normalized) {
            const prefTopicNormalized = normalizeTopic(`pref:${prefKeyInfo.normalized}`);
            tryAddCardsFromTopic(prefTopicNormalized);
          }
      
          const { block: cardContextBlock, included: contextCards } = buildCardContextBlock(cards, topic);
          for (const card of contextCards) {
            touchCardOnce(card);
          }
          if (!conceptContextBlock) {
            const candidateKeys = gatherConceptKeyCandidates({ content, topic, listIntent });
            for (const keyCandidate of candidateKeys) {
              const context = buildConceptContextBlock(keyCandidate);
              if (context?.notes?.length) {
                conceptContextBlock = context.block;
                conceptContextNotes = context.notes.slice(0, 3);
                conceptContextKey = context.key || keyCandidate;
                conceptContextFacets = Array.isArray(context.facets) ? context.facets.slice(0, 3) : [];
                break;
              }
            }
          }

          if (conceptContextBlock && conceptContextNotes.length) {
            for (const entry of conceptContextNotes) {
              if (entry?.card) touchCardOnce(entry.card);
            }
            emitEventLog(ws, "concept_context", {
              key: conceptContextKey,
              cards_used: conceptContextNotes.length,
              facets: conceptContextFacets
            });
            if (!note) {
              const conceptNote = conceptContextNotes[0]?.card || null;
              if (conceptNote) {
                note = conceptNote;
                stale = isStale(note, FRESH_TTL_DAYS);
              }
            }
          }
          const conceptContextMeta = conceptContextBlock
            ? {
                conceptContextBlock,
                conceptContextKey,
                conceptContextCount: conceptContextNotes.length,
                conceptContextFacets
              }
            : null;
          const withConceptContext = (meta = {}) => {
            const base = { ...meta, turnHooks };
            if (!conceptContextMeta) return base;
            return { ...base, ...conceptContextMeta };
          };
      
          const flushCardUsage = () => {
            if (cardsUsageLogged) return;
            if (touchedCardIds.size) {
              emitEventLog(ws, `cards_used:${touchedCardIds.size}`, { count: touchedCardIds.size });
            }
            cardsUsageLogged = true;
          };
      
          appendMessage(sessionId, { role: "user", content });

          const ackOnly = /^(ok|okay|sounds good|👍)$/i.test(trimmedContent);
          if (ackOnly) {
            const ackReply = "👍";
            appendMessage(sessionId, { role: "assistant", content: ackReply });
            ws.send(JSON.stringify({ type: "assistant_message", content: ackReply }));
            sendKdn(ws, sessionId, { state: "KNOWN", reason: "ack", ambiguous: false });
            flushCardUsage();
            return;
          }

          if (await handleAnalogyResponse(ws, sessionId, userId, trimmedContent, turnHooks)) {
            flushCardUsage();
            sendFreshnessEvent();
            return;
          }
      
          if (handleConceptSuggestionResponse(ws, sessionId, trimmedContent)) {
            flushCardUsage();
            sendFreshnessEvent();
            return;
          }
      
          if (handleConceptCommand(ws, sessionId, trimmedContent)) {
            flushCardUsage();
            sendFreshnessEvent();
            return;
          }
      
          if (handleAnalogyCommand(ws, sessionId, trimmedContent)) {
            flushCardUsage();
            sendFreshnessEvent();
            return;
          }
      
          if (isGreeting(content) && !inReplyToGap) {
            const reply = "Hi! What do you need help with?";
            appendMessage(sessionId, { role:"assistant", content: reply });
            ws.send(JSON.stringify({ type:"assistant_message", content: reply }));
            sendKdn(ws, sessionId, { state:"DK", reason:"greeting/ambiguous", ambiguous:true });
            flushCardUsage();
            sendFreshnessEvent();
            return;
          }
      
          let fastPathReply = "";
          let fastPathUsedCard = null;
      
          if (!inReplyToGap && wantsNameAnswer) {
            const profileCard = cards.find(card => card?.type === "profile");
            const profileName = profileCard?.value?.profile?.name || profileCard?.value?.name;
            if (profileCard && profileName) {
              fastPathReply = `Your name is ${profileName}.`;
              fastPathUsedCard = profileCard;
            }
          }
      
          if (!fastPathReply && !inReplyToGap && prefKeyInfo) {
            const targetTopic = normalizeTopic(`pref:${prefKeyInfo.normalized}`);
            const prefCard = cards.find(card => {
              if (!card || card.type !== "pref") return false;
              const cardKey = String(card.value?.key || "").toLowerCase();
              if (cardKey && cardKey === prefKeyInfo.normalized) return true;
              const cardTopic = normalizeTopic(card.topic || "");
              return cardTopic && targetTopic && cardTopic === targetTopic;
            });
            if (prefCard) {
              let prefValue = "";
              const rawValue = prefCard.value?.value ?? prefCard.value?.pref ?? prefCard.value?.answer;
              if (typeof rawValue === "string") {
                prefValue = rawValue.trim();
              } else if (rawValue !== undefined && rawValue !== null) {
                prefValue = JSON.stringify(rawValue);
              } else if (typeof prefCard.summary === "string") {
                const summaryMatch = prefCard.summary.match(/:\s*(.+)$/);
                if (summaryMatch) prefValue = summaryMatch[1].trim();
              }
              if (prefValue) {
                const prefLabel = prefKeyInfo.raw.replace(/\s+/g, " ").trim();
                fastPathReply = `Your ${prefLabel} is ${prefValue}.`;
                fastPathUsedCard = prefCard;
              }
            }
          }
      
          if (fastPathReply) {
            if (fastPathUsedCard) touchCardOnce(fastPathUsedCard);
            appendMessage(sessionId, { role:"assistant", content: fastPathReply });
            ws.send(JSON.stringify({ type:"assistant_message", content: fastPathReply }));
            flushCardUsage();
            sendFreshnessEvent();
            return;
          }
      
          const wantsBriefUpdate = /\b(update|summary|two sentences|2-?sentence)\b/i.test(content);
          const isSearchCommand = /^\s*(search|look up)\b/i.test(content);
      
          if (!inReplyToGap && refreshMatch) {
            const lastList = getLastListContext(sessionId);
            let requestBase = refreshArg;
            let targetTopicKey = refreshArg ? normalizeTopic(refreshArg) : "";
            let usedLastListTopic = false;
      
            if (!targetTopicKey && lastList?.lastTopicKey) {
              targetTopicKey = lastList.lastTopicKey;
              requestBase = lastList.lastQBase || requestBase;
              usedLastListTopic = Boolean(targetTopicKey);
            }
      
            if (!targetTopicKey) {
              freshnessAction = "gap";
              sendFreshnessEvent();
              flushCardUsage();
              sendGapPrompt(ws, { userId, sessionId, prompt: "Refresh what topic?" });
              return;
            }
      
            if (!requestBase) {
              requestBase = detokenizeTopicKey(targetTopicKey);
            }
      
            const base = String(requestBase || "").trim();
            const topicForSearch = bucketTopic(base || targetTopicKey);
            const { qlist, keysUsed } = buildQueryList(base, { max: 8 });
            const runNumber = touchTopicRun(sessionId, topicForSearch);
            const args = { q: base, qlist: qlist.slice(), k: 5 };
            const hasBrave = Boolean((process.env.BRAVE_API_KEY || "").trim());
            if (!hasBrave && runNumber > 1 && args.qlist.length > 1) {
              args.qlist = rotateList(args.qlist, runNumber - 1);
            }
            const spec = { tool: "web_search", args };
            freshnessAction = "search";
            const fallbackTopic = normalizeTopic(base);
            freshnessTopic = targetTopicKey || fallbackTopic;
            if (usedLastListTopic && freshnessTopic) {
              freshnessTopicSource = "list";
            } else if (fallbackTopic) {
              freshnessTopicSource = "message";
            }
            sendFreshnessEvent();
            flushCardUsage();
            await executeTool(ws, withConceptContext({ userId, sessionId, spec, requestText: base, topic: topicForSearch, banditKeys: keysUsed, runNumber }));
            return;
          }
      
          if (freshCue && !listIntent) {
            listIntent = { query: trimmedContent || content, topicless: false, forceFresh: true };
          }
      
          const summarizeCommand = /^\s*summarize\s*#\d+\s*$/i.test(content);
          const hasUrl = /https?:\/\/\S+/i.test(content);
          const wantsTwoSentenceUpdate = TWO_SENTENCE_REGEX.test(content);
      
          if (!freshCue && !inReplyToGap && wantsTwoSentenceUpdate && conceptContextNotes.length && !listIntent && !isSearchCommand && !summarizeCommand) {
            const conceptCard = conceptContextKey ? findConceptCard(conceptContextKey) : null;
            const conceptTitle = conceptCard?.title ? String(conceptCard.title).trim() : "";
            const conceptLabel = conceptTitle || conceptContextKey || "";
            const enrichedNotes = conceptContextNotes.map(entry => ({
              ...entry,
              conceptTitle,
              conceptKey: conceptContextKey,
              conceptLabel
            }));
            const replyCandidate = twoSentenceFromNotes(enrichedNotes, { facets: conceptContextFacets });
            const reply = replyCandidate || "I don't have any notes on that yet.";
            freshnessAction = "note";
            registerConceptUsage(conceptContextKey, conceptContextNotes.length, conceptContextBlock.length);
            for (const entry of conceptContextNotes) {
              if (entry?.card) touchCardOnce(entry.card);
            }
            appendMessage(sessionId, { role: "assistant", content: reply });
            ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
            sendFreshnessEvent();
            flushCardUsage();
            return;
          }
      
          if (conceptContextBlock && conceptContextNotes.length) {
            registerConceptUsage(conceptContextKey, conceptContextNotes.length, conceptContextBlock.length);
          }
      
          let autoResearchOutcome = null;
          try {
            autoResearchOutcome = await maybeRunAutoResearch({
              ws,
              userId,
              sessionId,
              content,
              topic,
              note,
              stale,
              freshCue,
              listIntent,
              isSearchCommand,
              summarizeCommand,
              hasUrl,
              inReplyToGap,
              conceptContextBlock,
              conceptContextKey,
              conceptContextCount: conceptContextNotes.length,
              conceptContextFacets,
              turnHooks
            });
          } catch (err) {
            console.error("auto_research_invoke_error", err);
          }
      
          if (autoResearchOutcome?.triggered) {
            const context = autoResearchOutcome.context || null;
            if (context?.topic) {
              freshnessTopic = context.topic;
              freshnessTopicSource = "auto";
            }
            if (autoResearchOutcome.handled) {
              freshnessAction = "search";
              sendFreshnessEvent();
              flushCardUsage();
              return;
            }
            finalizeAutoResearchEvent(ws, sessionId, context);
          }
      
          if (!freshCue && !inReplyToGap && note && !stale && wantsBriefUpdate && !listIntent && !isSearchCommand && !summarizeCommand) {
            const reply = note.summary || "I don't have an update saved.";
            freshnessAction = "note";
            if (note) touchCardOnce(note);
            appendMessage(sessionId, { role: "assistant", content: reply });
            ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
            sendFreshnessEvent();
            flushCardUsage();
            return;
          }
      
          if (!freshCue && !inReplyToGap && note && stale && !listIntent && !isSearchCommand && !summarizeCommand) {
            const base = note.summary || "Here's the last note I saved.";
            const reply = `${base}\n\nThis note may be stale. Say 'refresh' to update.`;
            freshnessAction = "note+hint";
            if (note) touchCardOnce(note);
            appendMessage(sessionId, { role: "assistant", content: reply });
            ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
            sendFreshnessEvent();
            flushCardUsage();
            return;
          }
      
          // URL → auto web_get
          if (!inReplyToGap) {
            const urlMatch = content.match(/https?:\/\/\S+/i);
            if (urlMatch) {
              const spec = { tool: "web_get", args: { url: urlMatch[0] } };
              sendFreshnessEvent();
              flushCardUsage();
              await executeTool(ws, withConceptContext({ userId, sessionId, spec, requestText: content }));
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
              sendKdn(ws, sessionId, { state: "DK", reason: "explicit unknown", ambiguous: false });
              flushCardUsage();
              sendFreshnessEvent();
              return;
            }
      
            if (!Number.isFinite(idx) || idx < 1 || idx > 5) {
              emitEventLog(ws, "summarize_pick", { n: numberValid, ok: false, reason: "out_of_range" });
              const reply = "unknown with current context.";
              appendMessage(sessionId, { role: "assistant", content: reply });
              ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
              sendKdn(ws, sessionId, { state: "DK", reason: "explicit unknown", ambiguous: false });
              flushCardUsage();
              sendFreshnessEvent();
              return;
            }
      
            if (idx > items.length) {
              emitEventLog(ws, "summarize_pick", { n: idx, ok: false, reason: "missing_item" });
              const reply = "unknown with current context.";
              appendMessage(sessionId, { role: "assistant", content: reply });
              ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
              sendKdn(ws, sessionId, { state: "DK", reason: "explicit unknown", ambiguous: false });
              flushCardUsage();
              sendFreshnessEvent();
              return;
            }
      
            const target = items[idx - 1];
            emitEventLog(ws, "summarize_pick", { n: idx, ok: true, reason: "ok", host: target.host || null });
            const spec = { tool: "web_get", args: { url: target.url } };
            sendFreshnessEvent();
            flushCardUsage();
            await executeTool(ws, withConceptContext({ userId, sessionId, spec, requestText: content, topic: stored.topic }), "auto");
            return;
          }
      
          // Search intents
          if (listIntent) {
            const storedList = getStoredListContext(sessionId);
            let baseRaw = String(listIntent.query || "").trim();
            let base = sanitizeQuery(baseRaw);
            let topic = null;
            const previous = sessionSearch.get(sessionId) || null;
            const storedReuse = sanitizeQuery(storedList?.queryForReuse || previous?.lastQuery || "");
            const storedTopic = storedList?.topic || previous?.topic || "";
            const storedTopicKey = storedList?.lastTopicKey || previous?.lastTopicKey || "";
            let followupMode = false;

            if (listIntent.topicless) {
              if (storedReuse) {
                base = storedReuse;
                followupMode = true;
              } else {
                flushCardUsage();
                sendGapPrompt(ws, {
                  userId,
                  sessionId,
                  prompt: "What topic do you want?",
                  q: "Need topic for list request",
                  why: "User asked for more sources without a topic"
                });
                sendFreshnessEvent();
                return;
              }
            }

            if (!base) {
              base = sanitizeQuery(content.trim() || content);
            }

            const policyCheck = evaluatePolicyGate(content, base);
            if (policyCheck.blocked) {
              flushCardUsage();
              const topicCandidate = normalizeTopicKey(base || content, "news") || storedTopicKey || "";
              emitInspectorEvent(ws, "policy_gate", { reason: policyCheck.reason, topicKey: topicCandidate });
              const reply = policyCheck.reason === "voter_info"
                ? "For official voting information, please visit Vote.gov or your local election office."
                : "I can't help with that topic right now.";
              appendMessage(sessionId, { role: "assistant", content: reply });
              ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
              sendFreshnessEvent();
              return;
            }
            const searchIntent = policyCheck.intent || "";

            const shortOrFollowup = !isMeaningfulQuery(base) || FOLLOWUP_KEYWORD_REGEX.test(baseRaw.trim().toLowerCase());
            if (shortOrFollowup && storedReuse) {
              base = storedReuse;
              followupMode = true;
            } else if (shortOrFollowup && !storedReuse) {
              if (STRICT_FOLLOWUP) {
                const reply = "I need the topic again to keep searching.";
                appendMessage(sessionId, { role: "assistant", content: reply });
                ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
                sendFreshnessEvent();
                return;
              }
            }

            if (!base) {
              flushCardUsage();
              sendGapPrompt(ws, {
                userId,
                sessionId,
                prompt: "What topic do you want?",
                q: "Need topic for list request",
                why: "User asked for sources without a usable query"
              });
              sendFreshnessEvent();
              return;
            }

            if (!topic) {
              const topicSource = followupMode && storedTopic ? storedTopic : (listIntent.topicless && storedList?.topic ? storedList.topic : null);
              topic = topicSource || bucketTopic(base || content);
            }

            const canonicalListKey = (() => {
              const options = [
                storedTopicKey,
                storedList?.topic,
                ensureTopic(base || content, sessionId)
              ];
              for (const candidate of options) {
                if (!candidate) continue;
                const normalized = normalizeTopicKey(candidate, "news");
                if (normalized) return normalized;
              }
              return "";
            })();

            const persistentInfo = canonicalListKey ? getPersistentSeenHosts(canonicalListKey) : { offset: 0 };

            const { qlist, keysUsed } = buildQueryList(base, { max: 8 });
            const runNumber = touchTopicRun(sessionId, topic);
            const args = { q: base, qlist: qlist.slice(), k: 5 };
            let pageIndex = 0;
            const previousTopicKey = previous?.lastTopicKey || "";
            if (followupMode) {
              const prevPage = Number(previous?.pageIndex);
              pageIndex = Number.isFinite(prevPage) && prevPage >= 0 ? prevPage + 1 : 1;
              if (RESET_OFFSET_ON_TOPIC_CHANGE && canonicalListKey && previousTopicKey && previousTopicKey !== canonicalListKey) {
                pageIndex = 1;
              }
            } else if (RESET_OFFSET_ON_TOPIC_CHANGE && canonicalListKey && previousTopicKey && previousTopicKey !== canonicalListKey) {
              pageIndex = 0;
            }
            const computedOffset = pageIndex > 0 ? pageIndex * 5 : 0;
            let offsetToUse = Number.isFinite(persistentInfo?.offset) ? persistentInfo.offset : 0;
            if (followupMode) {
              offsetToUse = Math.max(offsetToUse, computedOffset);
            } else if (computedOffset > 0) {
              offsetToUse = computedOffset;
            }
            if (offsetToUse > 0) {
              args.offset = offsetToUse;
            }
            const canonicalListTopic = normalizeTopic(base);
            if (followupMode) {
              const followupKey = canonicalListKey || storedTopicKey || normalizeTopicKey(base || content, "news") || "";
              if (followupKey) {
                emitInspectorEvent(ws, "followup_resolved", { topicKey: followupKey, offset: pageIndex });
              }
            }
            const hasBrave = Boolean((process.env.BRAVE_API_KEY || "").trim());
            if (!hasBrave && runNumber > 1 && args.qlist.length > 1) {
              args.qlist = rotateList(args.qlist, runNumber - 1);
            }
            const spec = { tool: "web_search", args };
            if (freshCue) freshnessAction = "search";
            if (canonicalListTopic) {
              freshnessTopic = canonicalListTopic;
              freshnessTopicSource = "list";
            }
            sendFreshnessEvent();
            flushCardUsage();
            await executeTool(ws, withConceptContext({
              userId,
              sessionId,
              spec,
              requestText: content,
              topic,
              banditKeys: keysUsed,
              runNumber,
              canonicalTopicKey: canonicalListKey,
              listFollowup: Boolean(listIntent.topicless || followupMode),
              pageIndex,
              searchIntent
            }));
            return;
          }
      
          if (/^\s*(search|look up)\b/i.test(content)) {
            const topic = bucketTopic(content);
            const rawBase = content.replace(/^\s*(search|look up)\b/i, "").trim() || content;
            let base = sanitizeQuery(rawBase);
            if (!isMeaningfulQuery(base)) {
              const fallbackStored = sanitizeQuery(getStoredListContext(sessionId)?.queryForReuse || sessionSearch.get(sessionId)?.lastQuery || "");
              if (fallbackStored) {
                base = fallbackStored;
              } else if (STRICT_FOLLOWUP) {
                const reply = "I need the topic again to search properly.";
                appendMessage(sessionId, { role: "assistant", content: reply });
                ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
                sendFreshnessEvent();
                return;
              }
            }
            const policyCheck = evaluatePolicyGate(content, base);
            if (policyCheck.blocked) {
              flushCardUsage();
              const topicCandidate = normalizeTopicKey(base || content, "news") || "";
              emitInspectorEvent(ws, "policy_gate", { reason: policyCheck.reason, topicKey: topicCandidate });
              const reply = policyCheck.reason === "voter_info"
                ? "For official voting information, please visit Vote.gov or your local election office."
                : "I can't help with that topic right now.";
              appendMessage(sessionId, { role: "assistant", content: reply });
              ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
              sendFreshnessEvent();
              return;
            }
            const searchIntent = policyCheck.intent || "";
            const { qlist, keysUsed } = buildQueryList(base, { max: 8 });
            const runNumber = touchTopicRun(sessionId, topic);
            const args = { q: base, qlist: qlist.slice(), k: 5 };
            const hasBrave = Boolean((process.env.BRAVE_API_KEY || "").trim());
            if (!hasBrave && runNumber > 1 && args.qlist.length > 1) {
              args.qlist = rotateList(args.qlist, runNumber - 1);
            }
            const spec = { tool: "web_search", args };
            if (freshCue) freshnessAction = "search";
            const canonicalSearchTopic = normalizeTopic(base);
            if (canonicalSearchTopic) {
              freshnessTopic = canonicalSearchTopic;
              freshnessTopicSource = "list";
            }
            sendFreshnessEvent();
            flushCardUsage();
            await executeTool(ws, withConceptContext({ userId, sessionId, spec, requestText: content, topic, banditKeys: keysUsed, runNumber, searchIntent }));
            return;
          }
      
          // Default → model
          const profile = getUserProfile(userId);
          let systemPrompt = buildSystemPrompt(profile);
          const contextBlocks = [];
          if (cardContextBlock) contextBlocks.push(cardContextBlock);
          if (conceptContextBlock) contextBlocks.push(conceptContextBlock);
          if (contextBlocks.length) {
            systemPrompt = `${systemPrompt}\n\n${contextBlocks.join("\n\n")}`;
          }
          const recent = getTrimmedHistory(sessionId);
          const messages = [
            { role: "system", content: systemPrompt },
            ...recent,
            { role: "user", content }
          ];
      
          try {
            sendFreshnessEvent();
            flushCardUsage();
            const { content: completion, usage } = await callOpenAI(messages);
            await handleAssistantResponse(ws, { completion, usage, userId, sessionId }, turnHooks);
          } catch (err) {
            sendFreshnessEvent();
            ws.send(JSON.stringify({ type: "assistant_message", content: "unknown with current context (API error)." }));
            console.error(err);
          }
    };

    resetAutoResearchSearchCount(sessionId);
    try {
      for (const messageObj of messagesToProcess) {
        await handleUserMessage(messageObj);
      }
    } catch (err) {
      console.error("chat_turn_error", err);
    } finally {
      finalizeTurn();
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

      if (meta.turnHooks?.registerSearchTokens) {
        meta.turnHooks.registerSearchTokens(Math.round((result?.chars || 0) / 4));
      }

      const topicRecord = getSessionTopicRecord(meta.sessionId);
      const activeConceptKey = toConceptKey(topicRecord?.active);
      const lastListConceptKey = getSlotConceptKey(topicRecord?.lastList);
      const summaryConceptKey = activeConceptKey || lastListConceptKey || "";
      rememberLastSummary(meta.sessionId, {
        url: result.url,
        title: result.title,
        topic: meta.topic || bucketTopic(meta.requestText || result.title || ""),
        host: result.url ? extractDomain(result.url) : "",
        conceptKey: summaryConceptKey
      });

      await callModelWithGetResult(ws, meta, run);
    } else if (meta.spec.tool === "web_search") {
      const t0 = Date.now();
      const topic = meta.topic || bucketTopic(meta.requestText || meta.spec.args.q);
      if (!meta.runNumber) {
        touchTopicRun(meta.sessionId, topic);
      }
      const canonicalHintKey = meta.canonicalTopicKey ? normalizeTopicKey(meta.canonicalTopicKey, "news") : "";
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
      if (meta.turnHooks?.registerSearchTokens) {
        const estimate = (result?.k || 0) * 60;
        meta.turnHooks.registerSearchTokens(estimate);
      }
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
      const { union: seenHostUnion } = getSeenHostUnion(meta.sessionId, topic);
      const rankWeight = (entry) => {
        let weight = 0;
        if (isPreferredDomain(entry.domain)) weight += 2;
        if (!entry.domain || !seenHostUnion.has(entry.domain)) weight += 1;
        return weight;
      };

      const searchIntent = typeof meta?.searchIntent === "string" ? meta.searchIntent : "";
      const adjustmentLog = [];

      const scoreEntries = (entries, baseIdx = 0, logArray = adjustmentLog) => {
        return (entries || []).map((entry, idx) => {
          const domain = extractDomain(entry?.url || "");
          const prior = getSourcePrior(domain);
          const recency = computeRecencyScore(entry);
          const baseScore = SCORE_PRIOR_WEIGHT * prior + SCORE_RECENCY_WEIGHT * recency;
          let adjustment = 0;
          if (domain && NEWS_ALLOWLIST.has(domain)) adjustment += 0.15;
          if (domain && NEWS_DOWNRANK.has(domain)) adjustment -= 0.25;
          if (domain && searchIntent === "press_release" && OFFICIAL_PR_DOMAINS.has(domain)) adjustment += 0.1;
          const score = baseScore + adjustment;
          if (logArray) {
            logArray.push({
              host: domain || "",
              base: Number(baseScore.toFixed(3)),
              adj: Number(adjustment.toFixed(3)),
              final: Number(score.toFixed(3))
            });
          }
          return { ...entry, domain, prior, recency, score, baseScore, adjustment, idx: baseIdx + idx };
        }).filter(entry => entry && entry.url && !shouldExcludeDomain(entry.domain, entry.url, meta.requestText));
      };

      const hostKeyForEntry = (entry) => {
        if (!entry) return null;
        if (entry.domain) return entry.domain.toLowerCase();
        if (entry.url) return entry.url.split("#")[0].toLowerCase();
        if (Number.isFinite(entry.idx)) return `__idx_${entry.idx}`;
        return null;
      };

      const compareEntries = (a, b) => {
        const wa = rankWeight(a);
        const wb = rankWeight(b);
        if (wa !== wb) return wb - wa;
        const scoreA = Number.isFinite(a.score) ? a.score : 0;
        const scoreB = Number.isFinite(b.score) ? b.score : 0;
        if (scoreA !== scoreB) return scoreB - scoreA;
        return a.idx - b.idx;
      };

      const rankEntries = (entries) => entries.slice().sort(compareEntries);

      const dedupeByHost = (entries) => {
        const best = new Map();
        for (const entry of entries) {
          const key = hostKeyForEntry(entry);
          if (!key) continue;
          const prev = best.get(key);
          if (!prev || compareEntries(entry, prev) < 0) {
            best.set(key, entry);
          }
        }
        return Array.from(best.values());
      };

      const candidatePool = new Map();
      const mergeCandidates = (entries) => {
        for (const entry of entries) {
          const key = hostKeyForEntry(entry);
          if (!key) continue;
          const prev = candidatePool.get(key);
          if (!prev || compareEntries(entry, prev) < 0) {
            candidatePool.set(key, entry);
          }
        }
      };

      const selected = [];
      const selectedHostKeys = new Set();
      let exploreReason = "none";
      const markExplore = (reason) => {
        if (!reason) return;
        if (exploreReason === "none") exploreReason = reason;
      };

      const tryAddEntry = (entry, opts = {}) => {
        if (!entry || !entry.url) return false;
        const hostKey = hostKeyForEntry(entry);
        if (!hostKey) return false;
        if (selectedHostKeys.has(hostKey)) return false;
        const host = entry.domain;
        if (!opts.allowSeen && host && seenHostUnion.has(host)) return false;
        selected.push(entry);
        selectedHostKeys.add(hostKey);
        if (!host || !seenHostUnion.has(host)) {
          const reason = opts.reason && opts.reason !== "seen_fallback" ? opts.reason : "unseen";
          markExplore(reason);
        } else if (opts.reason && opts.reason !== "seen_fallback") {
          markExplore(opts.reason);
        }
        return true;
      };

      const addFromCandidates = (entries, opts = {}) => {
        for (const entry of entries) {
          if (selected.length >= 5) break;
          tryAddEntry(entry, opts);
        }
      };

      let idxCursor = 0;
      const baseProcessed = scoreEntries(result?.results || [], idxCursor);
      idxCursor += baseProcessed.length;
      const baseCandidates = rankEntries(dedupeByHost(baseProcessed));
      mergeCandidates(baseCandidates);
      addFromCandidates(baseCandidates, { allowSeen: true });

      if (selected.length < 5) {
        try {
          const baseOffsetRaw = Number(meta.spec.args.offset ?? 0);
          const baseOffset = Number.isFinite(baseOffsetRaw) ? baseOffsetRaw : 0;
          const offsetArgs = { ...meta.spec.args, offset: baseOffset + 5 };
          const offsetResult = await tool_web_search(offsetArgs, { MAX_PAGE_CHARS, BRAVE_API_KEY: process.env.BRAVE_API_KEY });
          const offsetProcessed = scoreEntries(offsetResult?.results || [], idxCursor);
          idxCursor += offsetProcessed.length;
          const offsetCandidates = rankEntries(dedupeByHost(offsetProcessed));
          mergeCandidates(offsetCandidates);
          addFromCandidates(offsetCandidates, { allowSeen: false, reason: "offset" });
        } catch (err) {
          console.error("offset_search_failed", err);
        }
      }

      if (selected.length < 5) {
        const qlist = Array.isArray(meta.spec.args.qlist) ? meta.spec.args.qlist.filter(Boolean) : [];
        if (qlist.length > 1) {
          try {
            const rotated = rotateList(qlist, 1);
            const variantArgs = { ...meta.spec.args, q: rotated[0], qlist: rotated, offset: 0 };
            const variantResult = await tool_web_search(variantArgs, { MAX_PAGE_CHARS, BRAVE_API_KEY: process.env.BRAVE_API_KEY });
            const variantProcessed = scoreEntries(variantResult?.results || [], idxCursor);
            idxCursor += variantProcessed.length;
            const variantCandidates = rankEntries(dedupeByHost(variantProcessed));
            mergeCandidates(variantCandidates);
            addFromCandidates(variantCandidates, { allowSeen: false, reason: "variant" });
          } catch (err) {
            console.error("variant_search_failed", err);
          }
        }
      }

      if (selected.length < 5) {
        const fallbackCandidates = rankEntries(Array.from(candidatePool.values()));
        addFromCandidates(fallbackCandidates, { allowSeen: true, reason: "seen_fallback" });
      }

      const ensureHighTrustQuota = () => {
        if (!NEWS_ALLOWLIST.size) return;
        const currentTrusted = new Set(
          selected
            .map(item => (item?.domain && NEWS_ALLOWLIST.has(item.domain) ? item.domain : null))
            .filter(Boolean)
        );
        if (currentTrusted.size >= 3) return;
        const trustedCandidates = rankEntries(Array.from(candidatePool.values())).filter(
          entry => entry?.domain && NEWS_ALLOWLIST.has(entry.domain)
        );
        for (const candidate of trustedCandidates) {
          if (currentTrusted.size >= 3) break;
          const hostKey = hostKeyForEntry(candidate);
          if (!hostKey || selectedHostKeys.has(hostKey)) continue;
          if (selected.length < 5) {
            if (tryAddEntry(candidate, { allowSeen: true, reason: "high_trust" })) {
              currentTrusted.add(candidate.domain);
            }
            continue;
          }
          const replaceable = selected
            .map((entry, idx) => ({ entry, idx }))
            .filter(item => !item.entry?.domain || !NEWS_ALLOWLIST.has(item.entry.domain))
            .sort((a, b) => {
              const scoreA = Number.isFinite(a.entry?.score) ? a.entry.score : -Infinity;
              const scoreB = Number.isFinite(b.entry?.score) ? b.entry.score : -Infinity;
              return scoreA - scoreB;
            });
          if (!replaceable.length) break;
          const target = replaceable[0];
          const removed = selected.splice(target.idx, 1, candidate)[0];
          if (removed) {
            const removedKey = hostKeyForEntry(removed);
            if (removedKey) selectedHostKeys.delete(removedKey);
          }
          selectedHostKeys.add(hostKey);
          currentTrusted.add(candidate.domain);
          markExplore("high_trust");
        }
      };

      ensureHighTrustQuota();

      if (adjustmentLog.length) {
        const trimmedLog = adjustmentLog.slice(0, 15);
        emitInspectorEvent(ws, "rank_adjust", trimmedLog);
      }

      const selectedHosts = selected.map(item => item?.domain || null);
      const exploreFlag = exploreReason !== "none";

      if (selected.length) {
        updateSeenHosts(meta.sessionId, topic, selectedHosts.filter(Boolean));
        if (canonicalHintKey) {
          updatePersistentSeenHosts(canonicalHintKey, selectedHosts.filter(Boolean));
        }
        const baseQuery = typeof meta.spec.args.q === "string" ? meta.spec.args.q : "";
        const storedQlist = Array.isArray(meta.spec.args.qlist) ? meta.spec.args.qlist.filter(Boolean) : [];
        const normalizedQuery = topicToSearchPhrase(topic);
        const normalizedTopic = (() => {
          const phrase = normalizedQuery || baseQuery || meta.requestText || "";
          const normalized = normalizeTopic(phrase);
          return normalized ? normalized.trim() : "";
        })();
        const humanQuery = String(meta.requestText || baseQuery || "").trim();
        const originalUserQuery = humanQuery || baseQuery || "";
        const targetConceptKey = call_id === "analogy_followup"
          ? toConceptKey(meta?.targetConceptKey)
          : "";
        let canonicalTopicKey = (() => {
          const candidates = [
            canonicalHintKey,
            originalUserQuery,
            normalizedTopic,
            normalizedQuery,
            topicToSearchPhrase(topic),
            baseQuery,
            topic
          ];
          for (const candidate of candidates) {
            if (!candidate) continue;
            const normalized = normalizeTopicKey(candidate, "news");
            if (normalized) return normalized;
          }
          return "";
        })();
        if (targetConceptKey) {
          canonicalTopicKey = targetConceptKey;
        }
        const listItems = selected.map(r => ({ title: r.title || "", url: r.url, host: r.domain || null }));
        setLastListContext(meta.sessionId, {
          topicKey: canonicalTopicKey,
          qBase: originalUserQuery,
          items: listItems
        });
        sessionSearch.set(meta.sessionId, {
          topic,
          runId: run?.id || null,
          query: baseQuery,
          qlist: storedQlist,
          normalizedQuery,
          normalizedTopic,
          list: listItems,
          ts: Date.now(),
          lastTopicKey: canonicalTopicKey,
          lastQBase: originalUserQuery,
          lastQuery: baseQuery,
          pageIndex: Number.isFinite(meta?.pageIndex) ? Math.max(0, Number(meta.pageIndex)) : 0
        });

        const averageScore = selected.length
          ? selected.reduce((sum, entry) => sum + (Number(entry.score) || 0), 0) / selected.length
          : 0;
        maybeUpsertNewsCard({
          ws,
          topicKey: canonicalTopicKey,
          topicLabel: normalizedTopic || topic,
          selected,
          qualityScore: averageScore
        });
      }

      let handedToModel = false;

      if (selected.length) {
        const lines = selected.map((r,i) => `#${i+1} — ${r.title || "(no title)"} (score ${formatScore(r.score)}) — ${r.url}`).join("\n");
        const msg = `Here are ${selected.length} sources:\n${lines}`;
        appendMessage(meta.sessionId, { role:"assistant", content: msg });
        ws.send(JSON.stringify({ type:"assistant_message", content: msg }));
        ws.send(JSON.stringify({ type: "list_posted", explore: exploreFlag, reason: exploreReason, hosts: selectedHosts }));
        const canonicalListTopic = (targetConceptKey ? normalizeTopicKey(targetConceptKey, "news") : (canonicalHintKey || canonicalTopicKey))
          || normalizeTopicKey(normalizedTopic || "", "news")
          || normalizeTopicKey(humanQuery || normalizedQuery || topicToSearchPhrase(topic) || topic, "news");
        emitEventLog(ws, "list_posted", {
          runId: run?.id || null,
          items: selected.length,
          hosts: selectedHosts,
          explore: exploreFlag,
          reason: exploreReason,
          topic: canonicalListTopic
        });
      } else {
        const pb = playbookFor(topic);
        const hint = (pb?.if_k0 && pb.if_k0.length) ? `Tried variants. Consider: ${pb.if_k0.slice(0,3).join(", ")}` : "Try adding org names or dates.";
        const msg = meta.listFollowup
          ? "I've already shared the reliable sites I can find right now. Try a different angle or topic."
          : `I couldn't find credible sources for that query. ${hint}`;
        appendMessage(meta.sessionId, { role:"assistant", content: msg });
        ws.send(JSON.stringify({ type:"assistant_message", content: msg }));
      }

      // If not list-only, continue to model to pick best URL
      if (!wantsListOnly(meta.requestText || "") && selected.length) {
        handedToModel = true;
        await callModelWithSearchResults(ws, meta, run);
      }

      if (meta?.autoResearch && !handedToModel) {
        const context = getAutoResearchContext(meta.sessionId);
        if (context) finalizeAutoResearchEvent(ws, meta.sessionId, context);
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
  let systemPrompt = buildSystemPrompt(profile);
  const contextBlocks = [];
  if (meta?.conceptContextBlock) contextBlocks.push(meta.conceptContextBlock);
  if (contextBlocks.length) {
    systemPrompt = `${systemPrompt}\n\n${contextBlocks.join("\n\n")}`;
  }
  const recent = getTrimmedHistory(sessionId, { omitAssistantTail: true });
  const doc = cleanAndCapDoc(run?.result?.text || "", MAX_PAGE_CHARS);

  const messages = [
    { role:"system", content: systemPrompt },
    ...recent,
    { role:"system", content: `CALLRESULT {"tool":"web_get","ref":"${run.id}","url":"${run.result_summary.url}","title":"${(run.result_summary.title||"").replace(/"/g,'\"')}","chars":${doc.length}}` },
    { role:"system", content: `DOC:\n${doc}` },
    { role:"user", content: "Write five tight bullets about DOC. Start with the page title plus URL in parentheses. If it is evergreen, append one [[NOTE]] (≤400 chars) citing the source." }
  ];

  const { content: completion, usage } = await callOpenAI(messages);
  const forced = enforceSummaryCompletionFormat(completion, run);
  await handleAssistantResponse(ws, { completion: forced, usage, userId, sessionId, origin: "web_get_summary", run, meta }, meta.turnHooks || null);
}

async function callModelWithSearchResults(ws, meta, run) {
  const { userId, sessionId } = meta;
  const profile = getUserProfile(userId);
  let systemPrompt = buildSystemPrompt(profile);
  const contextBlocks = [];
  if (meta?.conceptContextBlock) contextBlocks.push(meta.conceptContextBlock);
  if (contextBlocks.length) {
    systemPrompt = `${systemPrompt}\n\n${contextBlocks.join("\n\n")}`;
  }
  const recent = getTrimmedHistory(sessionId, { omitAssistantTail: true });
  const results = JSON.stringify(run?.result?.results || []);

  const messages = [
    { role:"system", content: systemPrompt },
    ...recent,
    { role:"system", content: `CALLRESULT {"tool":"web_search","ref":"${run.id}","k":${run?.result_summary?.k || 0}}` },
    { role:"system", content: `RESULTS: ${results}` },
    { role:"user", content: "From RESULTS, pick the best single URL to open and propose exactly one [[CALL]] {\"tool\":\"web_get\",\"args\":{\"url\":\"...\"}}." }
  ];

  const { content: completion, usage } = await callOpenAI(messages);
  await handleAssistantResponse(ws, { completion, usage, userId, sessionId, meta }, meta.turnHooks || null);
}

function hasRecentServerList(sessionId, windowMs = 2500) {
  const stored = sessionSearch.get(sessionId);
  if (!stored || !Number.isFinite(stored.ts)) return false;
  return (Date.now() - stored.ts) <= windowMs;
}

async function handleAssistantResponse(ws, { completion, usage, userId, sessionId, origin = null, run = null, meta = null }, turnHooks = null) {
  const artifacts = extractArtifactsTolerant(completion);
  let cleanText = artifacts.cleanText;
  const { memo, gap, evidence, kdn, call, note } = artifacts;
  const finalizeAutoResearch = () => {
    if (meta?.autoResearch) {
      const context = getAutoResearchContext(sessionId);
      if (context) finalizeAutoResearchEvent(ws, sessionId, context);
    }
  };
  if (usage) {
    ws.send(JSON.stringify({ type:"telemetry", usage }));
    if (usage.total_tokens && updateLastEpisode({ tokens_total: usage.total_tokens })) {
      ws.send(JSON.stringify({ type:"learning_stats", stats: recentStats(20) }));
    }
  }

  const triggerServerListFallback = async () => {
    const recentMessages = getRecentMessages(sessionId, 6) || [];
    const lastUser = [...recentMessages].reverse().find(msg => msg?.role === "user");
    const fallbackText = lastUser?.content ? String(lastUser.content) : "";
    if (!fallbackText) return false;
    const listIntent = detectListIntent(fallbackText);
    const storedList = getStoredListContext(sessionId);
    const previous = sessionSearch.get(sessionId) || null;
    let baseRaw = String(listIntent?.query || "").trim();
    let base = sanitizeQuery(baseRaw);
    let topic = null;
    const storedReuse = sanitizeQuery(storedList?.queryForReuse || previous?.lastQuery || "");
    const storedTopic = storedList?.topic || previous?.topic || "";
    const storedTopicKey = storedList?.lastTopicKey || previous?.lastTopicKey || "";
    let followupMode = false;
    if (listIntent?.topicless) {
      if (!storedReuse) return false;
      base = storedReuse;
      followupMode = true;
      topic = storedTopicKey || storedTopic || bucketTopic(base);
    }
    if (!base) {
      base = sanitizeQuery(fallbackText.trim());
    }
    if (!base) return false;
    const shortOrFollowup = !isMeaningfulQuery(base) || FOLLOWUP_KEYWORD_REGEX.test(baseRaw.trim().toLowerCase());
    if (shortOrFollowup && storedReuse) {
      base = storedReuse;
      followupMode = true;
    } else if (shortOrFollowup && !storedReuse) {
      if (STRICT_FOLLOWUP) return false;
    }
    const policyCheck = evaluatePolicyGate(fallbackText, base);
    if (policyCheck.blocked) {
      const topicCandidate = normalizeTopicKey(base || fallbackText, "news") || storedTopicKey || "";
      emitInspectorEvent(ws, "policy_gate", { reason: policyCheck.reason, topicKey: topicCandidate });
      return false;
    }
    const searchIntent = policyCheck.intent || "";
    if (!topic) {
      const topicSource = followupMode && storedTopic ? storedTopic : (listIntent?.topicless && storedList?.lastTopicKey
        ? storedList.lastTopicKey
        : storedList?.topic);
      topic = topicSource || bucketTopic(base || fallbackText);
    }
    const canonicalListKey = (() => {
      const options = [storedTopicKey, storedList?.topic, ensureTopic(base || fallbackText, sessionId)];
      for (const candidate of options) {
        if (!candidate) continue;
        const normalized = normalizeTopicKey(candidate, "news");
        if (normalized) return normalized;
      }
      return "";
    })();
    const persistentInfo = canonicalListKey ? getPersistentSeenHosts(canonicalListKey) : { offset: 0 };
    const { qlist, keysUsed } = buildQueryList(base, { max: 8 });
    const runNumber = touchTopicRun(sessionId, topic);
    const args = { q: base, qlist: qlist.slice(), k: 5 };
    let pageIndex = 0;
    const previousTopicKey = previous?.lastTopicKey || "";
    if (followupMode) {
      const prevPage = Number(previous?.pageIndex);
      pageIndex = Number.isFinite(prevPage) && prevPage >= 0 ? prevPage + 1 : 1;
      if (RESET_OFFSET_ON_TOPIC_CHANGE && canonicalListKey && previousTopicKey && previousTopicKey !== canonicalListKey) {
        pageIndex = 1;
      }
    }
    const computedOffset = pageIndex > 0 ? pageIndex * 5 : 0;
    let offsetToUse = Number.isFinite(persistentInfo?.offset) ? persistentInfo.offset : 0;
    if (followupMode) {
      offsetToUse = Math.max(offsetToUse, computedOffset);
    } else if (computedOffset > 0) {
      offsetToUse = computedOffset;
    }
    if (offsetToUse > 0) {
      args.offset = offsetToUse;
    }
    const hasBrave = Boolean((process.env.BRAVE_API_KEY || "").trim());
    if (!hasBrave && runNumber > 1 && args.qlist.length > 1) {
      args.qlist = rotateList(args.qlist, runNumber - 1);
    }
    const spec = { tool: "web_search", args };
    if (followupMode) {
      const followupKey = canonicalListKey || storedTopicKey || normalizeTopicKey(base || fallbackText, "news") || "";
      if (followupKey) {
        emitInspectorEvent(ws, "followup_resolved", { topicKey: followupKey, offset: pageIndex });
      }
    }
    const conceptMeta = meta?.conceptContextBlock
      ? {
          conceptContextBlock: meta.conceptContextBlock,
          conceptContextKey: meta.conceptContextKey || "",
          conceptContextCount: meta.conceptContextCount || 0,
          conceptContextFacets: Array.isArray(meta.conceptContextFacets)
            ? meta.conceptContextFacets.slice(0, 3)
            : []
        }
      : {};
    await executeTool(ws, { userId, sessionId, spec, requestText: fallbackText, topic, banditKeys: keysUsed, runNumber, pageIndex, canonicalTopicKey: canonicalListKey, searchIntent, ...conceptMeta, turnHooks });
    return true;
  };

  const listHeaderRegex = /^\s*here\s+are\s+\d+\s+(?:sources?|links?|results?)\b/i;
  const looksLikeListHeader = listHeaderRegex.test(cleanText || "");
  const policyBlockDetected = !!(cleanText && /policy/i.test(cleanText) && /(can't|cannot|unable)/i.test(cleanText));
  if (policyBlockDetected) {
    emitInspectorEvent(ws, "policy_override", { note: "news_ok" });
    if (await triggerServerListFallback()) { finalizeAutoResearch(); return; }
  }
  if (looksLikeListHeader && !hasRecentServerList(sessionId, 2000)) {
    const storedList = getStoredListContext(sessionId);
    const canonicalListTopic = storedList?.lastTopicKey
      || normalizeTopicKey(storedList?.normalizedTopic || "", "news")
      || normalizeTopicKey(storedList?.topic || "", "news");
    emitEventLog(ws, "list_model_blocked", { topic: canonicalListTopic, reason: "model_block" });
    if (await triggerServerListFallback()) { finalizeAutoResearch(); return; }
    cleanText = "";
  }

  const wantsServerList = /here are\s+5\s+sources\b/i.test(cleanText || "");
  if (wantsServerList && !hasRecentServerList(sessionId)) {
    if (await triggerServerListFallback()) { finalizeAutoResearch(); return; }
  }

  if (kdn) {
    try {
      const parsed = JSON.parse(kdn);
      sendKdn(ws, sessionId, parsed);
    } catch {
      // ignore parse errors
    }
  } else {
    const state = computeKDNFallback(cleanText, !!gap);
    sendKdn(ws, sessionId, state);
  }

  if (call) {
    let spec; try { spec = JSON.parse(call); } catch {}
    if (spec && (spec.tool === "web_get" || spec.tool === "web_search")) {
      const nextMeta = { userId, sessionId, spec, turnHooks: turnHooks || meta?.turnHooks || null };
      if (meta?.conceptContextBlock) {
        nextMeta.conceptContextBlock = meta.conceptContextBlock;
        nextMeta.conceptContextKey = meta.conceptContextKey || "";
        nextMeta.conceptContextCount = meta.conceptContextCount || 0;
        if (Array.isArray(meta.conceptContextFacets)) {
          nextMeta.conceptContextFacets = meta.conceptContextFacets.slice(0, 3);
        }
      }
      if (meta?.autoResearch) nextMeta.autoResearch = true;
      await executeTool(ws, nextMeta, meta?.autoResearch ? "auto_research" : "auto");
      return;
    }
  }

  if (cleanText && cleanText.trim().length) {
    appendMessage(sessionId, { role: "assistant", content: cleanText });
    ws.send(JSON.stringify({ type: "assistant_message", content: cleanText }));
  }

  const trimmedAssistant = cleanText ? cleanText.trim() : "";
  if (!origin && !meta?.autoResearch && trimmedAssistant && isDKMarkerReply(trimmedAssistant)) {
    if (AUTO_LEARN_ENABLED) {
      const searchBudget = getSearchBudget(sessionId);
      const remaining = searchBudget ? searchBudget.turn() : 0;
      if (remaining > 0 && getAutoResearchSearchCount(sessionId) < MAX_AUTO_SEARCHES_PER_TURN) {
        const timer = setTimeout(() => {
          runAutoResearchForDK({ ws, userId, sessionId }).catch(err => {
            console.error("auto_research_dk_invoke_error", err);
          });
        }, 0);
        if (timer && typeof timer.unref === "function") timer.unref();
      }
    }
  }

  if (gap) {
    let gapObj; try { gapObj = JSON.parse(gap); } catch {}
    if (gapObj && gapObj.q && gapObj.next_probe) {
      const gap_id = "gap_" + Date.now();
      appendGap(userId, { gap_id, ...gapObj });
      ws.send(JSON.stringify({ type:"gap", gap: { ...gapObj, gap_id, status: "open" } }));
    }
  }

  if (note && origin === "web_get_summary") {
    let parsedNote = null;
    try { parsedNote = JSON.parse(note); } catch {}
    if (parsedNote && typeof parsedNote === "object") {
      const result = saveNoteCardFromPayload({
        payload: parsedNote,
        explicitness: 0.6,
        userId,
        sessionId,
        run,
        reason: "web_get_note",
        topicHint: parsedNote.topic || meta?.topic || run?.result_summary?.title || "",
        autoResearch: Boolean(meta?.autoResearch)
      });
      if (result.saved) {
        ws.send(JSON.stringify({
          type: "note_saved",
          note: { topic: result.card.topic, score: Number(result.score ?? 0) }
        }));
        if (result.card?.id) {
          rememberLastSavedNoteId(meta.sessionId, result.card.id);
        }
        const isAutoNote = Boolean(meta?.autoResearch);
        const linkResult = autoLinkNoteToTopic(ws, meta.sessionId, result.card, { isAutoNote });
        if (isAutoNote) {
          const autoTopicKey = getSlotConceptKey(getSessionTopicRecord(meta.sessionId).lastAuto);
          emitInspectorEvent(ws, "auto_research_note", { topic: autoTopicKey });
        } else {
          emitInspectorEvent(ws, "user_note_attributed", {
            topic: linkResult?.conceptKey || "",
            source: linkResult?.source || ""
          });
        }
        maybeSuggestConceptLink(ws, meta.sessionId, result.card);
        maybeProposeAnalogyFromNote(ws, meta.sessionId, result.card, linkResult?.conceptKey);
        const conceptForRegister = linkResult?.conceptKey || result.conceptKey;
        if (meta?.autoResearch && turnHooks?.registerConceptSave && conceptForRegister) {
          turnHooks.registerConceptSave(conceptForRegister, 1);
        }
        if (updateLastEpisode({ note_saved: true })) {
          ws.send(JSON.stringify({ type:"learning_stats", stats: recentStats(20) }));
        }
      } else if (result.error === "missing_source_url") {
        ws.send(JSON.stringify({ type: "note_rejected", reason: "missing_source_url" }));
      }
    } else {
      ws.send(JSON.stringify({ type: "note_rejected", reason: "invalid_note_payload" }));
    }
  }

  finalizeAutoResearch();
}

function getTrimmedHistory(sessionId, { omitAssistantTail = false } = {}) {
  const limit = Math.max(0, RECENT_N);
  if (!limit) return [];
  const history = getRecentMessages(sessionId, limit);
  if (!history.length) return [];
  const deduped = dedupeSequential(history);
  if (!omitAssistantTail) return deduped;
  const trimmed = deduped.slice();
  while (trimmed.length && trimmed[trimmed.length - 1]?.role === "assistant") {
    trimmed.pop();
  }
  return trimmed;
}

function dedupeSequential(list) {
  const out = [];
  for (const item of list) {
    if (!item || typeof item.content !== "string") continue;
    if (out.length) {
      const prev = out[out.length - 1];
      if (prev.role === item.role && prev.content === item.content) continue;
    }
    out.push({ role: item.role, content: item.content });
  }
  return out;
}

function cleanAndCapDoc(raw, limit) {
  if (!limit) return "";
  const text = typeof raw === "string" ? raw : "";
  const normalized = text.replace(/\r\n/g, "\n");
  const paragraphs = normalized.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const filtered = paragraphs.filter(p => p.replace(/\s+/g, " ").trim().length >= 60);
  const joined = (filtered.length ? filtered : paragraphs).join("\n\n");
  return joined.slice(0, limit);
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
  const cleaned = sanitized.map(line => stripHeaderRepetitions(line, title, url));
  const normalized = cleaned.map(finalizeBulletText);
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

function stripHeaderRepetitions(line, title, url) {
  let out = String(line || "").trim();
  if (!out) return out;

  const collapse = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedTitle = collapse(title);
  const normalizedUrl = collapse(url);

  const removeFragment = (text, fragment) => {
    if (!fragment) return text;
    let working = text;
    let lowerWorking = working.toLowerCase();
    const fragLength = fragment.length;
    while (lowerWorking.includes(fragment)) {
      const idx = lowerWorking.indexOf(fragment);
      working = working.slice(0, idx) + working.slice(idx + fragLength);
      lowerWorking = working.toLowerCase();
    }
    return working;
  };

  out = removeFragment(out, normalizedUrl);
  out = removeFragment(out, normalizedTitle);

  out = out.replace(/\(\s*\)/g, "");
  out = out.replace(/\s+/g, " ").trim();

  if (out.toLowerCase() === normalizedTitle || out.toLowerCase() === normalizedUrl) {
    out = "";
  }

  return out;
}
