import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const BASE_DIR = path.resolve("data", "autocard");
const CARDS_FILE = path.join(BASE_DIR, "cards.jsonl");
const CONCEPTS_FILE = path.join(BASE_DIR, "concepts.json");
const LINKS_FILE = path.join(BASE_DIR, "links.jsonl");
const LEDGER_FILE = path.join(BASE_DIR, "ledger.jsonl");

function ensureStorage() {
  fs.mkdirSync(BASE_DIR, { recursive: true });
  if (!fs.existsSync(CARDS_FILE)) fs.writeFileSync(CARDS_FILE, "");
  if (!fs.existsSync(CONCEPTS_FILE)) fs.writeFileSync(CONCEPTS_FILE, JSON.stringify({}, null, 2));
  if (!fs.existsSync(LINKS_FILE)) fs.writeFileSync(LINKS_FILE, "");
  if (!fs.existsSync(LEDGER_FILE)) fs.writeFileSync(LEDGER_FILE, "");
}

ensureStorage();

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  if (!text.trim()) return [];
  return text
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeJsonLines(file, records) {
  const lines = records.map(record => JSON.stringify(record));
  fs.writeFileSync(file, lines.length ? lines.join("\n") + "\n" : "");
}

function loadCards() {
  return readJsonLines(CARDS_FILE);
}

function saveCards(cards) {
  writeJsonLines(CARDS_FILE, cards);
}

function loadConcepts() {
  try {
    const raw = fs.readFileSync(CONCEPTS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {}
  return {};
}

function saveConcepts(concepts) {
  fs.writeFileSync(CONCEPTS_FILE, JSON.stringify(concepts, null, 2));
}

function loadLinks() {
  return readJsonLines(LINKS_FILE);
}

function appendLinks(relations) {
  if (!relations || !relations.length) return;
  const lines = relations.map(rel => JSON.stringify(rel));
  fs.appendFileSync(LINKS_FILE, lines.join("\n") + "\n");
}

export function appendLedgerEntry(entry) {
  if (!entry || typeof entry !== "object") return;
  const payload = { ...entry };
  if (!payload.ts) {
    payload.ts = new Date().toISOString();
  }
  fs.appendFileSync(LEDGER_FILE, JSON.stringify(payload) + "\n");
}

function titleFromTopicKey(topicKey) {
  if (!topicKey) return "";
  const tokens = String(topicKey)
    .split("/")
    .map(part => part.trim())
    .filter(Boolean);
  const overrides = new Map([
    ["us", "US"],
    ["usa", "USA"],
    ["uk", "UK"],
    ["eu", "EU"],
    ["ev", "EV"]
  ]);
  const parts = tokens.map(part => {
    const lower = part.toLowerCase();
    if (overrides.has(lower)) return overrides.get(lower);
    if (lower === lower.toUpperCase()) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });
  return parts.join(" ");
}

function normalizeFacet(value) {
  if (!value) return "";
  return String(value).trim().toLowerCase();
}

function mergeFacets(entry, facets = []) {
  if (!entry) return false;
  const list = Array.isArray(entry.facets) ? entry.facets.slice() : [];
  const seen = new Set(list.map(normalizeFacet).filter(Boolean));
  let changed = false;
  for (const facet of facets) {
    const clean = normalizeFacet(facet);
    if (!clean) continue;
    if (seen.has(clean)) continue;
    list.push(facet);
    seen.add(clean);
    changed = true;
    if (list.length >= 8) break;
  }
  if (changed) {
    entry.facets = list.slice(0, 8);
  }
  return changed;
}

function ensureConcept(concepts, topicKey) {
  const key = String(topicKey || "").trim();
  if (!key) return { entry: null, changed: false };
  if (!concepts[key]) {
    concepts[key] = { title: titleFromTopicKey(key), facets: [], related_keys: [] };
    return { entry: concepts[key], changed: true };
  }
  const entry = concepts[key];
  if (!Array.isArray(entry.facets)) entry.facets = [];
  if (!Array.isArray(entry.related_keys)) entry.related_keys = [];
  if (!entry.title) entry.title = titleFromTopicKey(key);
  return { entry, changed: false };
}

function addRelatedKey(entry, otherKey) {
  if (!entry || !otherKey) return false;
  const key = String(otherKey).trim();
  if (!key) return false;
  const list = Array.isArray(entry.related_keys) ? entry.related_keys.slice() : [];
  const idx = list.indexOf(key);
  if (idx === 0) return false;
  if (idx > 0) {
    list.splice(idx, 1);
  }
  list.unshift(key);
  const trimmed = list.slice(0, 5);
  const changed = JSON.stringify(trimmed) !== JSON.stringify(entry.related_keys || []);
  if (changed) entry.related_keys = trimmed;
  return changed;
}

function categorizeTopic(topicKey) {
  const tokens = String(topicKey || "")
    .split("/")
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);
  const categories = {
    actor: new Set(),
    location: new Set(),
    policy: new Set(),
    timeline: new Set()
  };
  const locationTokens = new Set(["us", "usa", "united-states", "china", "india", "europe", "uk", "taiwan", "canada"]);
  const actorTokens = new Set(["byd", "tesla", "megha", "ustr", "government", "industry"]);
  const policyTokens = new Set(["tariff", "tariffs", "ban", "recall", "factory", "plant", "plans", "policy", "review", "joint", "venture"]);
  for (const token of tokens) {
    if (!token) continue;
    const base = token.replace(/[^a-z0-9]+/g, "");
    if (!base) continue;
    if (/^\d{4}$/.test(base)) {
      categories.timeline.add(base);
      continue;
    }
    if (locationTokens.has(base)) {
      categories.location.add(base);
    }
    if (actorTokens.has(base)) {
      categories.actor.add(base);
    }
    if (policyTokens.has(base)) {
      categories.policy.add(base);
    }
  }
  return categories;
}

function computeOverlap(aCats, bCats) {
  const overlaps = [];
  const labels = ["actor", "location", "policy", "timeline"];
  for (const label of labels) {
    const aSet = aCats[label];
    const bSet = bCats[label];
    if (!aSet || !bSet) continue;
    const shared = [...aSet].filter(value => bSet.has(value));
    if (shared.length) overlaps.push(label);
  }
  return overlaps;
}

function relationKey(a, b) {
  const [left, right] = [a, b].sort();
  return `${left}||${right}`;
}

function dedupeTopicKeys(keys) {
  const seen = new Set();
  const out = [];
  for (const key of keys) {
    const clean = String(key || "").trim();
    if (!clean) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function prepareSources(fact, sources = []) {
  if (Array.isArray(fact.source) && fact.source.length) {
    return fact.source
      .map(source => ({ ...source }))
      .map(source => ({
        url: String(source.url || "").trim(),
        title: source.title ? String(source.title).trim() : undefined,
        date: source.date ? String(source.date).trim() : undefined
      }))
      .filter(source => source.url || source.title || source.date);
  }
  if (Array.isArray(fact.source_indices)) {
    return fact.source_indices
      .map(index => sources[index])
      .filter(Boolean)
      .map(source => ({
        url: String(source.url || "").trim(),
        title: source.title ? String(source.title).trim() : undefined,
        date: source.date ? String(source.date).trim() : undefined
      }))
      .filter(source => source.url || source.title || source.date);
  }
  return [];
}

export function getCardsByTopic(topicKey) {
  const key = String(topicKey || "").trim();
  if (!key) return [];
  const normalized = key.toLowerCase();
  return loadCards()
    .filter(card => String(card.topic_key || "").toLowerCase() === normalized)
    .sort((a, b) => {
      const aTs = new Date(a.last_seen || a.first_seen || 0).getTime();
      const bTs = new Date(b.last_seen || b.first_seen || 0).getTime();
      return bTs - aTs;
    });
}

export function formatTopicTitle(topicKey) {
  return titleFromTopicKey(topicKey);
}

export function runAutoCardPipeline({ facts = [], sources = [], intent = "generic", turnId = "", provenance = {} } = {}) {
  ensureStorage();
  const today = new Date().toISOString().slice(0, 10);
  const cards = loadCards();
  const concepts = loadConcepts();
  const existingLinks = loadLinks();
  const linkKeys = new Set(existingLinks.map(link => relationKey(link.a, link.b)));
  let cardsChanged = false;
  let conceptsChanged = false;
  const savedCards = [];
  const topicKeys = new Set();

  for (const fact of facts.slice(0, 3)) {
    if (!fact || typeof fact !== "object") continue;
    const topicKey = String(fact.topic_key || "").trim();
    const claim = String(fact.claim || "").trim();
    if (!topicKey || !claim) continue;
    const cardSources = prepareSources(fact, sources);
    const allowUserSource = Boolean(fact.from_user_text);
    if (!cardSources.length && !allowUserSource) {
      continue;
    }

    const { entry, changed: ensured } = ensureConcept(concepts, topicKey);
    if (ensured) conceptsChanged = true;
    if (entry && Array.isArray(fact.facets) && fact.facets.length) {
      if (mergeFacets(entry, fact.facets.slice(0, 2))) conceptsChanged = true;
    }

    const ttlDays = fact.ttl_days !== undefined && fact.ttl_days !== null
      ? fact.ttl_days
      : intent === "news_latest"
        ? 21
        : null;
    const cardTags = Array.isArray(fact.tags) ? fact.tags.filter(Boolean) : [];
    const confidence = Number.isFinite(fact.confidence) ? Number(fact.confidence) : 0.6;

    const existingIndex = cards.findIndex(card => String(card.topic_key || "").toLowerCase() === topicKey.toLowerCase() && String(card.claim || "").trim() === claim);
    let savedCard;

    if (existingIndex >= 0) {
      const existing = { ...cards[existingIndex] };
      existing.last_seen = today;
      existing.ver_seen = Number(existing.ver_seen || 1) + 1;
      existing.confidence = confidence;
      if (cardSources.length) {
        existing.source = cardSources;
      } else if (allowUserSource && (!existing.source || !existing.source.length)) {
        existing.source = [{ url: "user://chat", date: today }];
      }
      if (fact.evidence) existing.evidence = fact.evidence;
      if (ttlDays !== undefined) existing.ttl_days = ttlDays;
      if (cardTags.length) {
        const mergedTags = new Set([...(existing.tags || []), ...cardTags]);
        existing.tags = Array.from(mergedTags);
      }
      existing.provenance = { turn_id: turnId || existing.provenance?.turn_id || "", intent: provenance.intent || intent };
      cards[existingIndex] = existing;
      savedCard = existing;
    } else {
      const sourceList = cardSources.length ? cardSources : allowUserSource ? [{ url: "user://chat", date: today }] : [];
      const newCard = {
        id: randomUUID(),
        topic_key: topicKey,
        claim,
        source: sourceList,
        evidence: fact.evidence ? String(fact.evidence).trim() : "",
        confidence,
        first_seen: today,
        last_seen: today,
        ver_seen: 1,
        ttl_days: ttlDays,
        tags: cardTags,
        provenance: { turn_id: turnId, intent: provenance.intent || intent }
      };
      cards.push(newCard);
      savedCard = newCard;
    }

    if (savedCard) {
      cardsChanged = true;
      savedCards.push(savedCard);
      topicKeys.add(savedCard.topic_key);
      appendLedgerEntry({ action: "card.save", topic_key: savedCard.topic_key, id: savedCard.id });
    }
  }

  if (cardsChanged) {
    saveCards(cards);
  }

  const updatedConcepts = concepts;
  if (conceptsChanged) {
    saveConcepts(updatedConcepts);
  }

  let linksAdded = 0;
  if (savedCards.length) {
    const refreshedCards = cards;
    const newRelations = [];
    for (const card of savedCards) {
      if (!card || !card.topic_key || !Number.isFinite(Number(card.confidence)) || Number(card.confidence) < 0.6) continue;
      const cardCats = categorizeTopic(card.topic_key);
      for (const other of refreshedCards) {
        if (!other || other.id === card.id) continue;
        if (!other.topic_key || other.topic_key === card.topic_key) continue;
        if (!Number.isFinite(Number(other.confidence)) || Number(other.confidence) < 0.6) continue;
        const key = relationKey(card.topic_key, other.topic_key);
        if (linkKeys.has(key)) continue;
        const otherCats = categorizeTopic(other.topic_key);
        const overlap = computeOverlap(cardCats, otherCats);
        if (overlap.length >= 2) {
          linkKeys.add(key);
          linksAdded += 1;
          newRelations.push({
            a: card.topic_key,
            b: other.topic_key,
            overlap,
            ts: new Date().toISOString(),
            confidence: Number(((Number(card.confidence) + Number(other.confidence)) / 2).toFixed(2))
          });
          const { entry: entryA } = ensureConcept(updatedConcepts, card.topic_key);
          const { entry: entryB } = ensureConcept(updatedConcepts, other.topic_key);
          if (addRelatedKey(entryA, other.topic_key)) conceptsChanged = true;
          if (addRelatedKey(entryB, card.topic_key)) conceptsChanged = true;
        }
      }
    }
    if (newRelations.length) {
      appendLinks(newRelations);
    }
  }

  if (conceptsChanged) {
    saveConcepts(updatedConcepts);
  }

  return {
    count: savedCards.length,
    topicKeys: dedupeTopicKeys([...topicKeys]),
    linksCount: linksAdded
  };
}
