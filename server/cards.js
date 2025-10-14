import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const DAY_MS = 24 * 60 * 60 * 1000;
const cardsDir = path.resolve("data", "cards");
const indexDir = path.resolve("data", "index");
const cardsFile = path.join(cardsDir, "cards.jsonl");
const indexFile = path.join(indexDir, "cards_index.json");
const conceptEdgesFile = path.join(cardsDir, "edges.jsonl");

const clamp01 = value => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (num <= 0) return 0;
  if (num >= 1) return 1;
  return num;
};

export function scoreImportance({ explicitness = 0, recency = 0, frequency = 0, taskGain = 0 } = {}) {
  const E = clamp01(explicitness);
  const R = clamp01(recency);
  const F = clamp01(frequency);
  const G = clamp01(taskGain);
  return 0.4 * E + 0.2 * R + 0.2 * F + 0.2 * G;
}

export function shouldSave(_card, metrics = {}) {
  const score = scoreImportance(metrics);
  return score >= 0.6;
}

export function applyTTL(card, { now = Date.now() } = {}) {
  if (!card || typeof card !== "object") return card;
  const copy = { ...card };
  const type = (card.type || "").toLowerCase();

  if (type === "profile" || type === "pref") {
    copy.ttl_days = null;
    copy.stale = false;
    return copy;
  }

  let ttlDays = copy.ttl_days;
  if (ttlDays === undefined || ttlDays === null) {
    if (type === "note" || type === "claim") {
      ttlDays = 30;
    } else {
      ttlDays = null;
    }
  }

  if (ttlDays !== null) {
    const numeric = Number(ttlDays);
    ttlDays = Number.isFinite(numeric) && numeric > 0 ? numeric : 30;
  }

  copy.ttl_days = ttlDays === null ? null : ttlDays;

  if (copy.ttl_days === null) {
    copy.stale = false;
    return copy;
  }

  const createdAt = Number(copy.created_at ?? copy.last_used ?? 0);
  const ttlMs = copy.ttl_days * DAY_MS;
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    copy.stale = false;
    return copy;
  }

  copy.stale = now - createdAt > ttlMs;
  return copy;
}

export function isStale(card, ttlDays, now = Date.now()) {
  if (!card || typeof card !== "object") return false;
  const ts = Number(card.ts ?? card.last_used ?? card.created_at ?? 0);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  const diff = now - ts;
  if (diff <= 0) return false;
  const ownTtl = Number(card.ttl_days);
  if (Number.isFinite(ownTtl) && ownTtl > 0) {
    return diff > ownTtl * DAY_MS;
  }
  if (ttlDays && card.type !== "profile" && card.type !== "pref") {
    const fallback = Number(ttlDays);
    if (Number.isFinite(fallback) && fallback > 0) {
      return diff > fallback * DAY_MS;
    }
  }
  return false;
}

export const ProfileCard = {
  type: "profile",
  topic: "",
  summary: "",
  value: {},
  tags: [],
  entities: [],
  confidence: 0.5,
  last_used: 0,
  created_at: 0
};

export const PrefCard = {
  type: "pref",
  topic: "",
  summary: "",
  value: {},
  tags: [],
  entities: [],
  confidence: 0.5,
  last_used: 0,
  created_at: 0
};

export const NoteCard = {
  type: "note",
  topic: "",
  summary: "",
  value: {},
  tags: [],
  entities: [],
  confidence: 0.5,
  last_used: 0,
  created_at: 0
};

export const ClaimCard = {
  type: "claim",
  topic: "",
  summary: "",
  value: {},
  tags: [],
  entities: [],
  confidence: 0.5,
  last_used: 0,
  created_at: 0
};

export const ConceptCard = {
  type: "concept",
  key: "",
  title: "",
  tags: [],
  entities: [],
  confidence: 0.7,
  ts: 0,
  last_used: null
};

export const AnalogyCard = {
  type: "analogy",
  from: "",
  to: "",
  topic: "",
  mapping: { partyA: "", partyB: "", facet: [] },
  why: [],
  watchout: [],
  status: "proposed",
  ts: 0,
  summary: "",
  tags: [],
  entities: [],
  confidence: 0.6,
  last_used: 0,
  created_at: 0,
  value: {}
};

const conceptPresets = new Map([
  ["openai/amd/deal", {
    entities: ["openai", "amd"],
    tags: ["deal", "ai-chips"],
    confidence: 0.7
  }]
]);

function dedupeStrings(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push(trimmed);
  }
  return result;
}

export function inferConceptMetadata(key) {
  const raw = String(key || "").trim().toLowerCase();
  if (!raw) {
    return { key: "", entities: [], tags: [], confidence: 0.6 };
  }
  const preset = conceptPresets.get(raw) || {};
  const segments = raw.split(/[\/]+/).map(part => part.trim()).filter(Boolean);
  const defaultEntities = segments.slice(0, Math.max(0, segments.length - 1));
  const defaultTags = segments.length ? [segments[segments.length - 1]] : [];
  const entities = dedupeStrings(Array.isArray(preset.entities) ? preset.entities : defaultEntities);
  const tags = dedupeStrings(Array.isArray(preset.tags) ? preset.tags : defaultTags);
  const confidence = Number.isFinite(preset.confidence) ? preset.confidence : 0.6;
  return { key: raw, entities, tags, confidence };
}

function collectNoteEntities(note) {
  if (!note || typeof note !== "object") return [];
  const sources = [
    note.entities,
    note.value?.entities,
    note.value?.data?.entities,
    note.value?.data?.parties,
    note.value?.source?.entities,
    note.value?.source?.parties
  ];
  const seen = new Set();
  const entities = [];
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      const raw = String(entry || "").trim();
      if (!raw) continue;
      const normalized = raw.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      entities.push(raw);
    }
  }
  return entities;
}

export function inferConceptKey(note) {
  if (!note || typeof note !== "object") return "";

  const candidateMap = new Map();
  const addCandidate = (value, weight = 1) => {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return;
    const normalized = normalizeTopicKey(raw, "news");
    if (!normalized) return;
    const colonIdx = normalized.indexOf(":");
    const body = colonIdx >= 0 ? normalized.slice(colonIdx + 1) : normalized;
    if (!body) return;
    const tokens = body.split("/").filter(Boolean);
    if (!tokens.length) return;
    const tokenScore = tokens.length + (tokens.length >= 3 ? 0.5 : 0);
    const score = tokenScore * weight;
    const prev = candidateMap.get(normalized);
    if (!prev || score > prev.score) {
      candidateMap.set(normalized, { key: normalized, score, tokens });
    }
  };

  addCandidate(note.topic, 5);
  addCandidate(note.value?.topic, 4);
  addCandidate(note.value?.data?.topic, 4);
  addCandidate(note.summary, 1.5);
  addCandidate(note.value?.data?.summary, 1.25);
  addCandidate(note.value?.source?.title, 1.75);

  const entities = collectNoteEntities(note);
  if (entities.length) {
    const lowered = entities.map(value => value.toLowerCase());
    if (lowered.length >= 3) {
      addCandidate(lowered.slice(0, 3).join(" "), 3.5);
    }
    if (lowered.length >= 2) {
      addCandidate(lowered.slice(0, 2).join(" "), 3.75);
    }
    addCandidate(lowered[0], 1);
  }

  if (!candidateMap.size) {
    return "";
  }

  const best = Array.from(candidateMap.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.tokens.length !== a.tokens.length) return b.tokens.length - a.tokens.length;
      return a.key.localeCompare(b.key);
    })[0];

  return best?.key || "";
}

const stopwords = new Set([
  "what",
  "s",
  "the",
  "latest",
  "on",
  "find",
  "more",
  "about",
  "sites",
  "sources",
  "articles",
  "websites",
  "news",
  "a",
  "an",
  "and",
  "or",
  "give",
  "me",
  "update",
  "sentence",
  "two"
]);

const synonymPatterns = [
  { pattern: /\bopen\s*ai\b/g, replacement: "openai" },
  { pattern: /\badvanced\s+micro\s+devices\b/g, replacement: "amd" },
  { pattern: /\bagreement\b|\bpartnership\b/g, replacement: "deal" }
];

function sanitizeKind(kind, fallback = "news") {
  const raw = String(kind ?? "").toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9]+/g, "");
  if (cleaned) return cleaned;
  return String(fallback ?? "news").replace(/[^a-z0-9]+/g, "") || "news";
}

function canonicalTopicTokens(text) {
  if (text === undefined || text === null) return [];
  let working = String(text).toLowerCase();
  if (!working.trim()) return [];

  working = working.replace(/^[^a-z0-9]+/, "");
  working = working.replace(/[\/]+/g, " ");
  working = working.replace(/[^a-z0-9\s]+/g, " ");

  for (const { pattern, replacement } of synonymPatterns) {
    working = working.replace(pattern, ` ${replacement} `);
  }

  working = working.replace(/\s+/g, " ").trim();
  if (!working) return [];

  const seen = new Set();
  const tokens = [];
  for (const token of working.split(" ")) {
    const trimmed = token.trim();
    if (!trimmed || stopwords.has(trimmed)) continue;
    if (/^\d+$/.test(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    tokens.push(trimmed);
  }
  return tokens;
}

export function normalizeTopicKey(text, kind = "news") {
  const raw = String(text ?? "");
  if (!raw.trim()) return "";

  let inferredKind = kind;
  let body = raw;
  const match = raw.match(/^\s*([a-z0-9]+):/i);
  if (match) {
    inferredKind = match[1];
    body = raw.slice(match[0].length);
  }

  const tokens = canonicalTopicTokens(body);
  if (!tokens.length) return "";
  const topicKind = sanitizeKind(inferredKind);
  return `${topicKind}:${tokens.join("/")}`;
}

function ensureStorage() {
  fs.mkdirSync(cardsDir, { recursive: true });
  fs.mkdirSync(indexDir, { recursive: true });
  if (!fs.existsSync(cardsFile)) {
    fs.writeFileSync(cardsFile, "");
  }
  if (!fs.existsSync(indexFile)) {
    const emptyIndex = { topics: {}, tags: {}, entities: {} };
    fs.writeFileSync(indexFile, JSON.stringify(emptyIndex, null, 2));
  }
  if (!fs.existsSync(conceptEdgesFile)) {
    fs.writeFileSync(conceptEdgesFile, "");
  }
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  return raw.split("\n").filter(Boolean);
}

function writeLines(file, lines) {
  const content = lines.join("\n");
  fs.writeFileSync(file, content + (content.endsWith("\n") || !content ? "" : "\n"));
}

export function normalizeTopic(text, { prefix = "" } = {}) {
  const raw = String(text ?? "");
  if (!raw.trim()) return "";

  let body = raw;
  let existingKind = "";
  const match = raw.match(/^\s*([a-z0-9]+):/i);
  if (match) {
    existingKind = match[1];
    body = raw.slice(match[0].length);
  }

  const tokens = canonicalTopicTokens(body);
  if (!tokens.length) return "";

  if (prefix) {
    const sanitized = sanitizeKind(prefix);
    return sanitized ? `${sanitized}:${tokens.join("/")}` : tokens.join("/");
  }

  if (existingKind) {
    const sanitized = sanitizeKind(existingKind);
    if (sanitized) {
      return `${sanitized}:${tokens.join("/")}`;
    }
  }

  return tokens.join("/");
}

export function writeCard(card) {
  ensureStorage();
  const now = Date.now();
  const id = card.id || randomUUID();
  const record = {
    ...card,
    id,
    created_at: Object.prototype.hasOwnProperty.call(card, "created_at") ? card.created_at : now,
    last_used: Object.prototype.hasOwnProperty.call(card, "last_used") ? card.last_used : now
  };
  fs.appendFileSync(cardsFile, JSON.stringify(record) + "\n");
  return { id };
}

function loadIndex() {
  ensureStorage();
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Invalid index");
    }
    return {
      topics: parsed.topics && typeof parsed.topics === "object" ? parsed.topics : {},
      tags: parsed.tags && typeof parsed.tags === "object" ? parsed.tags : {},
      entities: parsed.entities && typeof parsed.entities === "object" ? parsed.entities : {}
    };
  } catch {
    const fallback = { topics: {}, tags: {}, entities: {} };
    fs.writeFileSync(indexFile, JSON.stringify(fallback, null, 2));
    return fallback;
  }
}

function saveIndex(index) {
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
}

function addToIndex(map, key, id) {
  if (!key) return;
  if (!map[key]) {
    map[key] = [];
  }
  if (!map[key].includes(id)) {
    map[key].push(id);
  }
}

export function updateIndex(card) {
  if (!card || !card.id) return;
  const index = loadIndex();
  const topicKey = normalizeTopicKey(card.topic || "");
  if (topicKey) addToIndex(index.topics, topicKey, card.id);
  if (Array.isArray(card.tags)) {
    for (const tag of card.tags) {
      const key = normalizeTopic(tag);
      if (key) addToIndex(index.tags, key, card.id);
    }
  }
  if (Array.isArray(card.entities)) {
    for (const entity of card.entities) {
      const key = normalizeTopic(entity);
      if (key) addToIndex(index.entities, key, card.id);
    }
  }
  saveIndex(index);
}

export function readAllCards() {
  ensureStorage();
  const lines = readLines(cardsFile);
  const out = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        out.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return out;
}

export function getTopByTopic(topic, { limit = 3 } = {}) {
  const normalizedTopic = normalizeTopicKey(topic);
  if (!normalizedTopic) return [];
  const index = loadIndex();
  const ids = index.topics[normalizedTopic] || [];
  if (!ids.length) return [];
  const cards = readAllCards();
  const lookup = new Map(cards.map(card => [card.id, card]));
  const picked = [];
  for (const id of ids) {
    const card = lookup.get(id);
    if (!card) continue;
    const enriched = applyTTL(card);
    const tsCandidates = [
      card.value?.source?.ts,
      card.last_used,
      card.created_at
    ];
    let ts = null;
    for (const candidate of tsCandidates) {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric) && numeric > 0) {
        ts = numeric;
        break;
      }
    }
    picked.push({
      id: card.id,
      type: card.type,
      topic: card.topic,
      summary: card.summary,
      value: card.value,
      confidence: card.confidence,
      last_used: card.last_used,
      ts,
      ttl_days: enriched?.ttl_days ?? null,
      stale: Boolean(enriched?.stale)
    });
  }
  picked.sort((a, b) => (Number(b.last_used) || 0) - (Number(a.last_used) || 0));
  return picked.slice(0, Math.max(0, limit));
}

export function touch(cardId) {
  if (!cardId) return;
  const cards = readAllCards();
  let changed = false;
  const now = Date.now();
  const lines = cards.map(card => {
    if (card.id === cardId) {
      changed = true;
      card.last_used = now;
    }
    return JSON.stringify(card);
  });
  if (changed) {
    writeLines(cardsFile, lines);
  }
}

export function reindexTopicKeys({ logger = console } = {}) {
  const index = loadIndex();
  const topicIndex = index.topics || {};
  const moves = new Map();

  for (const key of Object.keys(topicIndex)) {
    const canonical = normalizeTopicKey(key || "");
    if (!canonical || canonical === key) continue;
    const bucket = moves.get(canonical) || { from: [], ids: new Set() };
    bucket.from.push(key);
    const ids = Array.isArray(topicIndex[key]) ? topicIndex[key] : [];
    for (const id of ids) {
      if (id) bucket.ids.add(id);
    }
    moves.set(canonical, bucket);
  }

  if (!moves.size) return [];

  const logs = [];
  let modified = false;

  for (const [canonical, info] of moves.entries()) {
    const destination = Array.isArray(topicIndex[canonical]) ? new Set(topicIndex[canonical]) : new Set();
    for (const id of info.ids) {
      if (!id) continue;
      if (!destination.has(id)) {
        destination.add(id);
      }
    }
    topicIndex[canonical] = Array.from(destination);
    for (const fromKey of info.from) {
      if (fromKey !== canonical) {
        delete topicIndex[fromKey];
      }
    }
    modified = true;
    const payload = { moved: info.ids.size, from: info.from, to: canonical };
    logs.push(payload);
    if (logger && typeof logger.info === "function") {
      logger.info("cards_reindex", payload);
    } else if (logger && typeof logger.log === "function") {
      logger.log("cards_reindex", payload);
    } else {
      console.log("cards_reindex", payload);
    }
  }

  if (modified) {
    saveIndex(index);
  }

  return logs;
}

const NUMBER_UNIT_REGEX = /\b\d+(?:\.\d+)?\s?(?:GW|MW|M|B|%)\b/gi;
const DATE_SNIPPET_REGEX = /\b(?:H1|H2|Q[1-4]|20\d{2})\b/gi;
const KEY_FACET_REGEX = /\b(?:warrants|stake|deployment|MI\d+)\b/gi;

function ensureSentence(text) {
  let out = String(text || "").replace(/[\s\r\n]+/g, " ").trim();
  if (!out) return "";
  out = out.replace(/[\s,;:]+$/, "");
  if (!/[.!?]$/.test(out)) {
    out += ".";
  }
  return out;
}

function extractNoteTimestamp(note) {
  const candidates = [
    note?.value?.source?.ts,
    note?.last_used,
    note?.created_at,
    note?.ts
  ];
  let best = 0;
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > best) {
      best = numeric;
    }
  }
  return best || null;
}

function formatAgeFromTimestamp(ts) {
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

function extractHost(note) {
  const url = note?.value?.source?.url || note?.value?.url || note?.url;
  if (!url || typeof url !== "string") return "";
  try {
    const parsed = new URL(url);
    const host = parsed.host || "";
    return host.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function firstSentenceClause(text) {
  const cleaned = String(text || "").replace(/[\s\r\n]+/g, " ").trim();
  if (!cleaned) return "";
  const match = cleaned.match(/[^.!?]+[.!?]?/);
  let clause = match ? match[0].trim() : cleaned;
  clause = clause.replace(/[.!?]+$/g, "");
  return clause;
}

function truncateClause(text, max) {
  let clause = String(text || "").trim();
  if (!clause) return clause;
  if (clause.length <= max) return clause;
  clause = clause.slice(0, Math.max(0, max)).trim();
  clause = clause.replace(/[\s,;:]+$/g, "");
  return clause;
}

function collectFacetsFromNotes(notes) {
  const facets = [];
  const seen = new Set();
  const addFacet = (value) => {
    const trimmed = String(value || "").replace(/[\s\r\n]+/g, " ").trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    facets.push(trimmed);
  };

  const textBlob = notes
    .map(entry => {
      const parts = [];
      if (typeof entry?.summary === "string") parts.push(entry.summary);
      if (typeof entry?.card?.summary === "string") parts.push(entry.card.summary);
      if (typeof entry?.card?.value?.data?.summary === "string") parts.push(entry.card.value.data.summary);
      return parts.join(" ");
    })
    .join(" ");

  if (textBlob) {
    let match;
    while ((match = NUMBER_UNIT_REGEX.exec(textBlob))) {
      let value = match[0].replace(/\s+/g, " ").toUpperCase();
      value = value.replace(/ %/g, "%");
      addFacet(value);
    }
    NUMBER_UNIT_REGEX.lastIndex = 0;

    while ((match = DATE_SNIPPET_REGEX.exec(textBlob))) {
      addFacet(match[0].toUpperCase());
    }
    DATE_SNIPPET_REGEX.lastIndex = 0;

    while ((match = KEY_FACET_REGEX.exec(textBlob))) {
      const raw = match[0];
      const facet = /mi\d+/i.test(raw) ? raw.toUpperCase() : raw.toLowerCase();
      addFacet(facet);
    }
    KEY_FACET_REGEX.lastIndex = 0;
  }

  return facets.slice(0, 3);
}

function resolveConceptLabel(notes) {
  const primary = notes[0] || {};
  const candidates = [
    primary.conceptTitle,
    primary.conceptLabel,
    primary.conceptKey,
    primary.card?.value?.data?.concept_title,
    primary.card?.value?.data?.concept,
    primary.card?.topic,
    primary.card?.title
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").replace(/[\s\r\n]+/g, " ").trim();
    if (value) return value.slice(0, 80);
  }
  return "Concept";
}

export function twoSentenceFromNotes(notes = []) {
  if (!Array.isArray(notes) || notes.length === 0) {
    return "";
  }

  const entries = notes.slice(0, 3).filter(Boolean);
  if (!entries.length) return "";

  const primary = entries[0];
  const conceptLabel = resolveConceptLabel(entries);
  let summaryClause = firstSentenceClause(primary?.summary || primary?.card?.summary || "");
  if (!summaryClause) {
    summaryClause = "No recent notes";
  }

  const facetsBase = collectFacetsFromNotes(entries);
  let facets = facetsBase.length ? facetsBase.slice(0, 3) : ["n/a"];
  const noteCard = primary?.card || {};
  const host = extractHost(noteCard) || "unknown";
  const age = formatAgeFromTimestamp(extractNoteTimestamp(noteCard)) || "?";
  const prefix = `${conceptLabel} update: `;

  const buildSentences = () => {
    const sentenceOne = ensureSentence(`${prefix}${summaryClause}`);
    const facetsLabel = facets.length ? facets.join(", ") : "n/a";
    const sentenceTwo = ensureSentence(`Key facets: ${facetsLabel} — source ${host}, ${age}`);
    return { sentenceOne, sentenceTwo };
  };

  let { sentenceOne, sentenceTwo } = buildSentences();
  let combined = `${sentenceOne} ${sentenceTwo}`.trim();

  while (combined.length > 220 && facets.length > 1) {
    facets = facets.slice(0, facets.length - 1);
    ({ sentenceOne, sentenceTwo } = buildSentences());
    combined = `${sentenceOne} ${sentenceTwo}`.trim();
  }

  if (combined.length > 220) {
    const availableForSummary = Math.max(10, 220 - (prefix.length + sentenceTwo.length + 1));
    summaryClause = truncateClause(summaryClause, availableForSummary);
    ({ sentenceOne, sentenceTwo } = buildSentences());
    combined = `${sentenceOne} ${sentenceTwo}`.trim();
  }

  if (combined.length > 220 && facets.length) {
    facets = [facets[0]];
    if (!facets[0] || facets[0] === "n/a") {
      facets[0] = "n/a";
    }
    ({ sentenceOne, sentenceTwo } = buildSentences());
    combined = `${sentenceOne} ${sentenceTwo}`.trim();
  }

  if (combined.length > 220) {
    const availableForSummary = Math.max(5, 220 - (prefix.length + sentenceTwo.length + 1));
    summaryClause = truncateClause(summaryClause, availableForSummary);
    ({ sentenceOne, sentenceTwo } = buildSentences());
    combined = `${sentenceOne} ${sentenceTwo}`.trim();
  }

  return combined;
}

const ANALOGY_FACET_RULES = [
  {
    key: "supply",
    pattern: /\b(?:supply|capacity|reserve|offtake|commit|gpu|chips)\b/i
  },
  {
    key: "warrants",
    pattern: /\b(?:warrant|option|stake|equity)\b/i
  },
  {
    key: "staged_deploy",
    pattern: /\b(?:staged|phased|rollout|h1|h2|q[1-4]|20\d{2}|mi\d+)\b/i
  }
];

function normalizeParty(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.toLowerCase();
}

function readConceptEdges() {
  ensureStorage();
  if (!fs.existsSync(conceptEdgesFile)) return [];
  const raw = fs.readFileSync(conceptEdgesFile, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        const parsed = JSON.parse(line);
        const noteId = String(parsed?.note_id || "").trim();
        const conceptKey = String(parsed?.concept_key || "").trim().toLowerCase();
        const ts = Number(parsed?.ts);
        if (!noteId || !conceptKey) return null;
        return { note_id: noteId, concept_key: conceptKey, ts: Number.isFinite(ts) ? ts : 0 };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function extractFacetsFromNotes(notes = []) {
  const parties = new Set();
  const facets = new Set();
  const textChunks = [];

  for (const note of notes || []) {
    if (!note || typeof note !== "object") continue;
    const noteEntities = Array.isArray(note.entities) ? note.entities : [];
    const cardEntities = Array.isArray(note.card?.entities) ? note.card.entities : [];
    for (const entity of [...noteEntities, ...cardEntities]) {
      const normalized = normalizeParty(entity);
      if (normalized) parties.add(normalized);
    }

    const parts = [];
    if (typeof note.summary === "string") parts.push(note.summary);
    if (typeof note.card?.summary === "string") parts.push(note.card.summary);
    if (typeof note.card?.value?.data?.summary === "string") parts.push(note.card.value.data.summary);
    if (typeof note.card?.value?.source?.title === "string") parts.push(note.card.value.source.title);
    if (typeof note.card?.value?.source?.excerpt === "string") parts.push(note.card.value.source.excerpt);
    if (parts.length) {
      textChunks.push(parts.join(" "));
    }
  }

  if (textChunks.length) {
    const blob = textChunks.join(" \n ");
    for (const rule of ANALOGY_FACET_RULES) {
      if (rule.pattern.test(blob)) {
        facets.add(rule.key);
      }
      rule.pattern.lastIndex = 0;
    }
  }

  return {
    parties: Array.from(parties),
    facets: Array.from(facets)
  };
}

export function getConcept(key) {
  const normalizedKey = normalizeParty(key);
  if (!normalizedKey) return null;
  const all = readAllCards();
  return (
    all.find(
      card =>
        card?.type === "concept" && normalizeParty(card?.key) === normalizedKey
    ) || null
  );
}

export function getLinkedNotes(key, { limit = 5 } = {}) {
  const normalizedKey = normalizeParty(key);
  if (!normalizedKey) return [];
  const edges = readConceptEdges().filter(edge => edge.concept_key === normalizedKey);
  if (!edges.length) return [];
  edges.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const limited = edges.slice(0, Math.max(1, Number(limit) || 5));
  const noteIds = new Set(limited.map(edge => edge.note_id));
  if (!noteIds.size) return [];
  const cards = readAllCards();
  const notes = cards.filter(card => card?.type === "note" && noteIds.has(card.id));
  notes.sort((a, b) => {
    const edgeA = edges.find(edge => edge.note_id === a.id);
    const edgeB = edges.find(edge => edge.note_id === b.id);
    return (edgeB?.ts || 0) - (edgeA?.ts || 0);
  });
  return notes.slice(0, limited.length);
}

export function getConceptSignature(key, { limit = 5, minNotes = 1 } = {}) {
  const normalizedKey = normalizeParty(key);
  if (!normalizedKey) {
    return { key: "", notes: [], signature: { parties: [], facets: [] } };
  }
  const noteLimit = Math.max(1, Number(limit) || 5);
  const notes = getLinkedNotes(normalizedKey, { limit: noteLimit });
  const minimum = Math.max(1, Number(minNotes) || 1);
  const signature = notes.length >= minimum ? extractFacetsFromNotes(notes) : { parties: [], facets: [] };
  return { key: normalizedKey, notes, signature };
}

export function scoreAnalogy(sourceSig = {}, targetSig = {}) {
  const sourceFacets = new Set(Array.isArray(sourceSig.facets) ? sourceSig.facets : []);
  const targetFacets = new Set(Array.isArray(targetSig.facets) ? targetSig.facets : []);
  const facetUnion = new Set([...sourceFacets, ...targetFacets]);
  const facetIntersection = [...sourceFacets].filter(value => targetFacets.has(value));
  const facetScore = facetUnion.size === 0 ? 0 : facetIntersection.length / facetUnion.size;

  const sourceParties = new Set(Array.isArray(sourceSig.parties) ? sourceSig.parties : []);
  const targetParties = new Set(Array.isArray(targetSig.parties) ? targetSig.parties : []);
  const partyUnion = new Set([...sourceParties, ...targetParties]);
  const partyIntersection = [...sourceParties].filter(value => targetParties.has(value));
  const partyScore = partyUnion.size === 0 ? 0 : partyIntersection.length / partyUnion.size;

  if (!Number.isFinite(facetScore) || !Number.isFinite(partyScore)) {
    return 0;
  }
  return Math.max(0, Math.min(1, (facetScore + partyScore) / 2));
}

export function writeAnalogyCard({ from = "", to = "", mapping = {}, why = [], watchout = [], status = "proposed" } = {}) {
  const now = Date.now();
  const record = {
    type: "analogy",
    from,
    to,
    topic: from,
    mapping,
    why: Array.isArray(why) ? why.slice() : [],
    watchout: Array.isArray(watchout) ? watchout.slice() : [],
    status,
    ts: now,
    created_at: now,
    last_used: now,
    confidence: 0.6,
    tags: ["analogy"],
    value: {}
  };
  const result = writeCard(record);
  const id = result?.id;
  if (id) {
    updateIndex({ ...record, id });
  }
  return { id };
}
