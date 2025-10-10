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

const stopwords = new Set([
  "find",
  "more",
  "sites",
  "sources",
  "articles",
  "websites",
  "about",
  "the",
  "a",
  "an",
  "and",
  "or",
  "news"
]);

const synonymPatterns = [
  { pattern: /\bopen\s*ai\b/g, replacement: "openai" },
  { pattern: /\bopenai\b/g, replacement: "openai" },
  { pattern: /\badvanced\s+micro\s+devices\b/g, replacement: "amd" },
  { pattern: /\bamd\b/g, replacement: "amd" },
  { pattern: /\bdeal\b|\bagreement\b|\bpartnership\b/g, replacement: "deal" }
];

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

export function normalizeTopic(text) {
  const raw = String(text || "").toLowerCase();
  if (!raw.trim()) return "";
  let normalized = raw;
  for (const { pattern, replacement } of synonymPatterns) {
    normalized = normalized.replace(pattern, ` ${replacement} `);
  }
  normalized = normalized.replace(/[^a-z0-9\s]+/g, " ");
  normalized = normalized.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const tokens = normalized
    .split(" ")
    .map(t => t.trim())
    .filter(Boolean)
    .filter(token => !stopwords.has(token));
  return tokens.join(" ");
}

export function writeCard(card) {
  ensureStorage();
  const now = Date.now();
  const id = card.id || randomUUID();
  const record = {
    ...card,
    id,
    created_at: card.created_at ?? now,
    last_used: card.last_used ?? now
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
  const topicKey = normalizeTopic(card.topic || "");
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
  const normalizedTopic = normalizeTopic(topic);
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
    picked.push({
      id: card.id,
      type: card.type,
      topic: card.topic,
      summary: card.summary,
      value: card.value,
      confidence: card.confidence,
      last_used: card.last_used,
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
