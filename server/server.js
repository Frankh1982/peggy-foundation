import "dotenv/config";
import fs from "fs";
import path from "path";
import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import { buildSystemPrompt } from "./prompt.js";
import { getUserProfile, updateUserProfile, appendMessage, getRecentMessages, appendGap, closeGap } from "./memory.js";
import { tool_web_get, tool_web_search, saveRunRecord } from "./tools.js";
import { bucketTopic, recordSearch, recordFetch, recordEpisode, recentStats, buildQueryList, playbookFor, updateBandit, updateLastEpisode } from "./learn.js";
import { normalizeTopic, writeCard, updateIndex, readAllCards, getTopByTopic, touch, scoreImportance, shouldSave, isStale } from "./cards.js";

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
const PEG_BUILD = "2025-10-04-v3j-learn";
const DEFAULT_SOURCE_PRIOR = 0.45;
const SCORE_PRIOR_WEIGHT = 0.45;
const SCORE_RECENCY_WEIGHT = 0.55;
const RECENCY_FALLBACK = 0.6;
const SOURCE_PRIORS = loadSourcePriors();
const DOMAIN_PREFS = loadDomainPrefs();
const SEEN_HOST_TTL = 15 * 60 * 1000;
const FRESH_CUE_REGEX = /\b(latest|breaking|today|tonight|this\s*week|refresh)\b|\bupdate\b.*\b(now|today)\b|\b(now|today)\b.*\bupdate\b/i;
const TWO_SENTENCE_REGEX = /\b(?:two|2)[-\s]?sentence\b/i;

const cardsDirPath = path.resolve("data", "cards");
const indexDirPath = path.resolve("data", "index");
fs.mkdirSync(cardsDirPath, { recursive: true });
fs.mkdirSync(indexDirPath, { recursive: true });
const cardWriteLogFile = path.join(cardsDirPath, "CardWriteLog.jsonl");
if (!fs.existsSync(cardWriteLogFile)) {
  fs.writeFileSync(cardWriteLogFile, "");
}

migrateLegacyCardData();

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

function topicToSearchPhrase(topic) {
  const raw = String(topic || "").trim();
  if (!raw) return "";
  const colon = raw.indexOf(":");
  const body = colon >= 0 ? raw.slice(colon + 1) : raw;
  const cleaned = body.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.split("/").map(part => part.trim()).filter(Boolean).join(" ");
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
  const result = writeCard(card);
  const id = result?.id;
  if (!id) return null;
  updateIndex({ ...card, id });
  return id;
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
  const topicKey = normalizeTopic(note.topic || note.title || "");
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
      const normalizedTopic = normalizeTopic(card.topic || "");
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

  const listMatch = raw.match(/^save\s+note\s+#(\d+)(?::|\s)+(.+)$/i);
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
  const record = {
    url: String(info.url).trim(),
    title: String(info.title || "").trim(),
    topic: String(info.topic || "").trim(),
    ts: Date.now()
  };
  sessionLastSummary.set(sessionId, record);
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
  const ts = Number(source.ts ?? source.timestamp ?? source.accessed_at);
  if (Number.isFinite(ts)) sanitized.ts = ts;
  if (source.note_id) sanitized.note_id = String(source.note_id);
  return sanitized;
}

function saveNoteCardFromPayload({ payload, explicitness, userId, sessionId, run, reason, topicHint }) {
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

  const topicKey = normalizeTopic(finalTopic);
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

  const entitiesRaw = Array.isArray(payload.entities) ? payload.entities : [];
  const entities = entitiesRaw
    .map(value => String(value || "").trim())
    .filter(Boolean)
    .slice(0, 6);

  const card = {
    type: "note",
    topic: finalTopic,
    summary: trimmedSummary,
    value: {
      source: sanitizedSource,
      data: {
        ...payload,
        topic: finalTopic,
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

  if (!shouldSave(card, metrics)) {
    return { saved: false, error: "score_low", score, metrics };
  }

  const id = persistCard(card);
  if (!id) {
    return { saved: false, error: "persist_failed", score, metrics };
  }

  const logReason = reason || ((Number(explicitness) || 0) >= 1 ? "user_reply" : "");
  logCardWrite({ ts: now, type: card.type, topic: card.topic, score, reason: logReason });
  return { saved: true, card: { ...card, id }, score, metrics };
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
    const topic = normalizeTopic(content);
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
    let note = null;
    let stale = false;
    let freshnessEventSent = false;
    const sendFreshnessEvent = () => {
      if (freshnessEventSent) return;
      emitEventLog(ws, "freshness_gate", {
        cue: Boolean(freshCue),
        note: Boolean(note),
        stale: Boolean(stale),
        action: freshnessAction,
        topic
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

      if (shortcutNote.kind === "list_item") {
        const stored = sessionSearch.get(sessionId);
        const idx = shortcutNote.index - 1;
        const listItems = Array.isArray(stored?.list) ? stored.list : [];
        const item = listItems[idx];
        if (item && item.url) {
          const topicCandidate = stored?.topic || item.title || summary;
          const topicValue = topicCandidate ? String(topicCandidate).trim() : summary;
          const topicFinal = topicValue || summary;
          const source = { url: item.url };
          if (item.title) source.title = item.title;
          payload = { topic: topicFinal, summary, source };
          topicHint = topicFinal;
          savedListIndex = shortcutNote.index;
        } else {
          if (!stored || !listItems.length) {
            rejectMessage = "I don't have a recent list to pull from.";
            rejectReason = "no_list";
          } else if (!Number.isFinite(idx) || idx < 0 || idx >= listItems.length) {
            rejectMessage = "unknown with current context.";
            rejectReason = "out_of_range";
          } else {
            rejectMessage = `I don't have a link for list item #${shortcutNote.index}.`;
            rejectReason = "missing_source_url";
          }
        }
      } else if (shortcutNote.kind === "last_summary" || shortcutNote.kind === "last_link") {
        const last = getLastSummary(sessionId);
        if (last && last.url) {
          const topicCandidate = last.topic || last.title || summary;
          const topicValue = topicCandidate ? String(topicCandidate).trim() : summary;
          const topicFinal = topicValue || summary;
          const source = { url: last.url };
          if (last.title) source.title = last.title;
          payload = { topic: topicFinal, summary, source };
          topicHint = topicFinal;
        } else {
          ws.send(JSON.stringify({ type: "note_rejected", reason: "missing_source_url" }));
          sendGapPrompt(ws, {
            userId,
            sessionId,
            prompt: "Can you share the link you want me to cite?",
            q: "Need a source URL for the note",
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
          ws.send(JSON.stringify({ type: "kdn", kdn: { state: "DK", reason: "explicit unknown", ambiguous: false } }));
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
        ws.send(JSON.stringify({
          type: "note_saved",
          note: { topic: result.card.topic, score: Number(result.score ?? 0) }
        }));
        const successMsg = savedListIndex !== null
          ? `note_saved: "${result.card.topic}" (#${savedListIndex})`
          : `note_saved: "${result.card.topic}"`;
        appendMessage(sessionId, { role: "assistant", content: successMsg });
        ws.send(JSON.stringify({ type: "assistant_message", content: successMsg }));
        if (updateLastEpisode({ note_saved: true })) {
          ws.send(JSON.stringify({ type: "learning_stats", stats: recentStats(20) }));
        }
      } else {
        ws.send(JSON.stringify({ type: "note_rejected", reason: result.error || "unknown" }));
        const reply = "I couldn't save that note.";
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
        if (updateLastEpisode({ note_saved: true })) {
          ws.send(JSON.stringify({ type: "learning_stats", stats: recentStats(20) }));
        }
      } else {
        ws.send(JSON.stringify({
          type: "note_rejected",
          reason: result.error || "unknown"
        }));
      }
      sendFreshnessEvent();
      return;
    }

    let cards = topic ? getTopByTopic(topic, { limit: 3 }) : [];
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
    const flushCardUsage = () => {
      if (cardsUsageLogged) return;
      if (touchedCardIds.size) {
        emitEventLog(ws, `cards_used:${touchedCardIds.size}`, { count: touchedCardIds.size });
      }
      cardsUsageLogged = true;
    };

    appendMessage(sessionId, { role: "user", content });

    if (isGreeting(content) && !inReplyToGap) {
      const reply = "Hi! What do you need help with?";
      appendMessage(sessionId, { role:"assistant", content: reply });
      ws.send(JSON.stringify({ type:"assistant_message", content: reply }));
      ws.send(JSON.stringify({ type:"kdn", kdn: { state:"DK", reason:"greeting/ambiguous", ambiguous:true } }));
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
      let base = refreshArg;
      let refreshTopic = null;
      if (!base && note) {
        base = note.topic || note.summary || "";
        refreshTopic = note.topic ? bucketTopic(note.topic) : null;
      }
      if (!base) {
        const stored = getStoredListContext(sessionId);
        if (stored) {
          base = stored.queryForReuse || stored.normalizedQuery || stored.fallbackQuery || stored.topic || "";
          refreshTopic = stored.topic || stored.normalizedTopic || null;
        }
      }
      if (!base) {
        const reply = "I need a topic to refresh.";
        appendMessage(sessionId, { role: "assistant", content: reply });
        ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
        freshnessAction = "none";
        sendFreshnessEvent();
        flushCardUsage();
        return;
      }
      const topicForSearch = refreshTopic || bucketTopic(base);
      const { qlist, keysUsed } = buildQueryList(base, { max: 8 });
      const runNumber = touchTopicRun(sessionId, topicForSearch);
      const args = { q: base, qlist: qlist.slice(), k: 5 };
      const hasBrave = Boolean((process.env.BRAVE_API_KEY || "").trim());
      if (!hasBrave && runNumber > 1 && args.qlist.length > 1) {
        args.qlist = rotateList(args.qlist, runNumber - 1);
      }
      const spec = { tool: "web_search", args };
      freshnessAction = "search";
      sendFreshnessEvent();
      flushCardUsage();
      await executeTool(ws, { userId, sessionId, spec, requestText: base, topic: topicForSearch, banditKeys: keysUsed, runNumber });
      return;
    }

    if (freshCue && !listIntent) {
      listIntent = { query: trimmedContent || content, topicless: false, forceFresh: true };
    }

    const summarizeCommand = /^\s*summarize\s*#\d+\s*$/i.test(content);

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
        flushCardUsage();
        sendFreshnessEvent();
        return;
      }

      if (!Number.isFinite(idx) || idx < 1 || idx > 5) {
        emitEventLog(ws, "summarize_pick", { n: numberValid, ok: false, reason: "out_of_range" });
        const reply = "unknown with current context.";
        appendMessage(sessionId, { role: "assistant", content: reply });
        ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
        ws.send(JSON.stringify({ type: "kdn", kdn: { state: "DK", reason: "explicit unknown", ambiguous: false } }));
        flushCardUsage();
        sendFreshnessEvent();
        return;
      }

      if (idx > items.length) {
        emitEventLog(ws, "summarize_pick", { n: idx, ok: false, reason: "missing_item" });
        const reply = "unknown with current context.";
        appendMessage(sessionId, { role: "assistant", content: reply });
        ws.send(JSON.stringify({ type: "assistant_message", content: reply }));
        ws.send(JSON.stringify({ type: "kdn", kdn: { state: "DK", reason: "explicit unknown", ambiguous: false } }));
        flushCardUsage();
        sendFreshnessEvent();
        return;
      }

      const target = items[idx - 1];
      emitEventLog(ws, "summarize_pick", { n: idx, ok: true, reason: "ok", host: target.host || null });
      const spec = { tool: "web_get", args: { url: target.url } };
      sendFreshnessEvent();
      flushCardUsage();
      await executeTool(ws, { userId, sessionId, spec, requestText: content, topic: stored.topic }, "auto");
      return;
    }

    // Search intents
    if (listIntent) {
      const storedList = getStoredListContext(sessionId);
      let base = String(listIntent.query || "").trim();
      let topic = null;

      if (listIntent.topicless) {
        const reuseTopic = storedList?.normalizedTopic ? storedList.normalizedTopic.trim() : "";
        const reuse = reuseTopic || (storedList?.queryForReuse ? storedList.queryForReuse.trim() : "");
        if (reuse) {
          base = reuse;
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
        base = content.trim() || content;
      }

      if (!topic) {
        const topicSource = listIntent.topicless && storedList?.topic ? storedList.topic : null;
        topic = topicSource || bucketTopic(base || content);
      }

      const { qlist, keysUsed } = buildQueryList(base, { max: 8 });
      const runNumber = touchTopicRun(sessionId, topic);
      const args = { q: base, qlist: qlist.slice(), k: 5 };
      const hasBrave = Boolean((process.env.BRAVE_API_KEY || "").trim());
      if (!hasBrave && runNumber > 1 && args.qlist.length > 1) {
        args.qlist = rotateList(args.qlist, runNumber - 1);
      }
      const spec = { tool: "web_search", args };
      if (freshCue) freshnessAction = "search";
      sendFreshnessEvent();
      flushCardUsage();
      await executeTool(ws, { userId, sessionId, spec, requestText: content, topic, banditKeys: keysUsed, runNumber });
      return;
    }

    if (/^\s*(search|look up)\b/i.test(content)) {
      const topic = bucketTopic(content);
      const base = content.replace(/^\s*(search|look up)\b/i, "").trim() || content;
      const { qlist, keysUsed } = buildQueryList(base, { max: 8 });
      const runNumber = touchTopicRun(sessionId, topic);
      const args = { q: base, qlist: qlist.slice(), k: 5 };
      const hasBrave = Boolean((process.env.BRAVE_API_KEY || "").trim());
      if (!hasBrave && runNumber > 1 && args.qlist.length > 1) {
        args.qlist = rotateList(args.qlist, runNumber - 1);
      }
      const spec = { tool: "web_search", args };
      if (freshCue) freshnessAction = "search";
      sendFreshnessEvent();
      flushCardUsage();
      await executeTool(ws, { userId, sessionId, spec, requestText: content, topic, banditKeys: keysUsed, runNumber });
      return;
    }

    // Default → model
    const profile = getUserProfile(userId);
    let systemPrompt = buildSystemPrompt(profile);
    if (cardContextBlock) {
      systemPrompt = `${systemPrompt}\n\n${cardContextBlock}`;
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
      await handleAssistantResponse(ws, { completion, usage, userId, sessionId });
    } catch (err) {
      sendFreshnessEvent();
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

      rememberLastSummary(meta.sessionId, {
        url: result.url,
        title: result.title,
        topic: meta.topic || bucketTopic(meta.requestText || result.title || "")
      });

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
      const { union: seenHostUnion } = getSeenHostUnion(meta.sessionId, topic);
      const rankWeight = (entry) => {
        let weight = 0;
        if (isPreferredDomain(entry.domain)) weight += 2;
        if (!entry.domain || !seenHostUnion.has(entry.domain)) weight += 1;
        return weight;
      };

      const scoreEntries = (entries, baseIdx = 0) => {
        return (entries || []).map((entry, idx) => {
          const domain = extractDomain(entry?.url || "");
          const prior = getSourcePrior(domain);
          const recency = computeRecencyScore(entry);
          const score = SCORE_PRIOR_WEIGHT * prior + SCORE_RECENCY_WEIGHT * recency;
          return { ...entry, domain, prior, recency, score, idx: baseIdx + idx };
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

      const selectedHosts = selected.map(item => item?.domain || null);
      const exploreFlag = exploreReason !== "none";

      if (selected.length) {
        updateSeenHosts(meta.sessionId, topic, selectedHosts.filter(Boolean));
        const baseQuery = typeof meta.spec.args.q === "string" ? meta.spec.args.q : "";
        const storedQlist = Array.isArray(meta.spec.args.qlist) ? meta.spec.args.qlist.filter(Boolean) : [];
        const normalizedQuery = topicToSearchPhrase(topic);
        const normalizedTopic = (() => {
          const phrase = normalizedQuery || baseQuery || meta.requestText || "";
          const normalized = normalizeTopic(phrase);
          return normalized ? normalized.trim() : "";
        })();
        sessionSearch.set(meta.sessionId, {
          topic,
          runId: run?.id || null,
          query: baseQuery,
          qlist: storedQlist,
          normalizedQuery,
          normalizedTopic,
          list: selected.map(r => ({ title: r.title || "", url: r.url, host: r.domain || null })),
          ts: Date.now()
        });
      }

      if (selected.length) {
        const lines = selected.map((r,i) => `#${i+1} — ${r.title || "(no title)"} (score ${formatScore(r.score)}) — ${r.url}`).join("\n");
        const msg = `Here are ${selected.length} sources:\n${lines}`;
        appendMessage(meta.sessionId, { role:"assistant", content: msg });
        ws.send(JSON.stringify({ type:"assistant_message", content: msg }));
        ws.send(JSON.stringify({ type: "list_posted", explore: exploreFlag, reason: exploreReason, hosts: selectedHosts }));
        emitEventLog(ws, "list_posted", { runId: run?.id || null, items: selected.length, hosts: selectedHosts, explore: exploreFlag, reason: exploreReason });
      } else {
        const pb = playbookFor(topic);
        const hint = (pb?.if_k0 && pb.if_k0.length) ? `Tried variants. Consider: ${pb.if_k0.slice(0,3).join(", ")}` : "Try adding org names or dates.";
        const msg = `I couldn't find credible sources for that query. ${hint}`;
        appendMessage(meta.sessionId, { role:"assistant", content: msg });
        ws.send(JSON.stringify({ type:"assistant_message", content: msg }));
      }

      // If not list-only, continue to model to pick best URL
      if (!wantsListOnly(meta.requestText || "") && selected.length) {
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
  await handleAssistantResponse(ws, { completion: forced, usage, userId, sessionId, origin: "web_get_summary", run, meta });
}

async function callModelWithSearchResults(ws, meta, run) {
  const { userId, sessionId } = meta;
  const profile = getUserProfile(userId);
  const systemPrompt = buildSystemPrompt(profile);
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
  await handleAssistantResponse(ws, { completion, usage, userId, sessionId, meta });
}

function hasRecentServerList(sessionId, windowMs = 2500) {
  const stored = sessionSearch.get(sessionId);
  if (!stored || !Number.isFinite(stored.ts)) return false;
  return (Date.now() - stored.ts) <= windowMs;
}

async function handleAssistantResponse(ws, { completion, usage, userId, sessionId, origin = null, run = null, meta = null }) {
  const artifacts = extractArtifactsTolerant(completion);
  let cleanText = artifacts.cleanText;
  const { memo, gap, evidence, kdn, call, note } = artifacts;
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
    let base = String(listIntent?.query || "").trim();
    let topic = null;
    if (listIntent?.topicless) {
      const reuse = storedList?.queryForReuse ? storedList.queryForReuse.trim() : "";
      if (!reuse) return false;
      base = reuse;
      topic = storedList?.topic || bucketTopic(base);
    }
    if (!base) {
      base = fallbackText.trim();
    }
    if (!base) return false;
    if (!topic) {
      const topicSource = listIntent?.topicless && storedList?.topic ? storedList.topic : null;
      topic = topicSource || bucketTopic(base || fallbackText);
    }
    const { qlist, keysUsed } = buildQueryList(base, { max: 8 });
    const runNumber = touchTopicRun(sessionId, topic);
    const args = { q: base, qlist: qlist.slice(), k: 5 };
    const hasBrave = Boolean((process.env.BRAVE_API_KEY || "").trim());
    if (!hasBrave && runNumber > 1 && args.qlist.length > 1) {
      args.qlist = rotateList(args.qlist, runNumber - 1);
    }
    const spec = { tool: "web_search", args };
    await executeTool(ws, { userId, sessionId, spec, requestText: fallbackText, topic, banditKeys: keysUsed, runNumber });
    return true;
  };

  const listHeaderRegex = /^\s*here\s+are\s+\d+\s+(?:sources?|links?|results?)\b/i;
  const looksLikeListHeader = listHeaderRegex.test(cleanText || "");
  if (looksLikeListHeader && !hasRecentServerList(sessionId, 2000)) {
    emitEventLog(ws, "list_model_blocked", true);
    if (await triggerServerListFallback()) return;
    cleanText = "";
  }

  const wantsServerList = /here are\s+5\s+sources\b/i.test(cleanText || "");
  if (wantsServerList && !hasRecentServerList(sessionId)) {
    if (await triggerServerListFallback()) return;
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
        topicHint: parsedNote.topic || meta?.topic || run?.result_summary?.title || ""
      });
      if (result.saved) {
        ws.send(JSON.stringify({
          type: "note_saved",
          note: { topic: result.card.topic, score: Number(result.score ?? 0) }
        }));
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
