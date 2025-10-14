import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const DAY_MS = 24 * 60 * 60 * 1000;
const cardsDir = path.resolve("data", "cards");
const indexDir = path.resolve("data", "index");
const cardsFile = path.join(cardsDir, "cards.jsonl");
const indexFile = path.join(indexDir, "cards_index.json");

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
