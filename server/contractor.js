import { NEWS_TOPICS, RECIPE_LIBRARY, formatDate, matchByAlias } from "./contract_data.js";
import { getCardsByTopic, formatTopicTitle } from "./autocard.js";

const ACTION_WORDS = /\b(announced|plans|threatens|files|launches)\b/i;
const LATEST_WORDS = /\b(latest|today|this\s*week)\b/i;
const TRIGGER_TERMS = /(tariff|ban|recall|acquisition|files|threatens|plans)/i;
const NOTES_CMD_RE = /^notes(\b|\s)/i;
const RECIPE_WORDS = /(recipe|bake|how\s+to\s+cook)/i;

function detectProperNounAction(text) {
  if (!text) return false;
  const actionMatch = ACTION_WORDS.test(text);
  if (!actionMatch) return false;
  const properNoun = /\b([A-Z][a-z]+\s+[A-Z][a-z]+|[A-Z]{2,})\b/.test(text);
  return properNoun;
}

export function routeContractIntent(text) {
  const raw = String(text || "");
  const lower = raw.toLowerCase();
  if (NOTES_CMD_RE.test(raw)) {
    return { intent: "notes_cmd", requiresBrowse: false };
  }
  if (RECIPE_WORDS.test(lower)) {
    return { intent: "how_to_recipe", requiresBrowse: false };
  }
  if (LATEST_WORDS.test(lower) || TRIGGER_TERMS.test(lower)) {
    return { intent: "news_latest", requiresBrowse: true };
  }
  if (detectProperNounAction(raw)) {
    return { intent: "news_latest", requiresBrowse: true };
  }
  return { intent: "generic", requiresBrowse: false };
}

function buildNewsResponse(entry, now = new Date()) {
  if (!entry) return null;
  const today = formatDate(now);
  const sources = entry.sources.slice(0, 5);
  if (sources.length < 2) return null;
  const updates = entry.updates.slice(0, 3);
  const updatesLine = updates.map(update => `• ${update.text}`).join(" ");
  const watchLine = `• ${entry.watch}`;
  const sourceRefs = sources.map((source, idx) => `[${idx + 1}] ${source.title} — ${source.date} (${source.url})`);
  const sourceLine = `Sources: ${sources.map((_s, idx) => `[${idx + 1}]`).join(" ")}`;
  const reply = [
    `As of ${today}, ${entry.summary}`,
    `Last 72h: ${updatesLine}`,
    `What’s next: ${watchLine}`,
    sourceLine,
    ...sourceRefs
  ].join("\n");
  const facts = entry.facts.map(fact => ({
    ...fact,
    topic_key: entry.topic_key,
    ttl_days: 21
  }));
  return {
    reply,
    sources,
    facts,
    hasDate: true,
    citationsOk: true,
    sectionsOk: true,
    topicKey: entry.topic_key,
    summary: entry.summary
  };
}

function buildRecipeResponse(entry) {
  if (!entry) return null;
  const sections = [];
  sections.push("Ingredients:\n" + entry.ingredients.map(item => `- ${item}`).join("\n"));
  sections.push("Steps:\n" + entry.steps.map((step, idx) => `${idx + 1}. ${step}`).join("\n"));
  sections.push("Variants:\n" + entry.variants.map(variant => `- ${variant}`).join("\n"));
  const reply = sections.join("\n\n");
  const fact = {
    topic_key: entry.topic_key,
    claim: entry.fact.claim,
    evidence: entry.fact.evidence,
    tags: entry.fact.tags,
    facets: entry.fact.facets,
    confidence: entry.fact.confidence,
    from_user_text: true,
    ttl_days: null
  };
  return {
    reply,
    sources: [],
    facts: [fact],
    hasDate: false,
    citationsOk: false,
    sectionsOk: true,
    topicKey: entry.topic_key
  };
}

function buildGenericResponse(text) {
  const cleaned = String(text || "").trim();
  const reply = cleaned
    ? `Thanks for the context. I heard you mention "${cleaned}"—let me know where you’d like to go next.`
    : "Let me know how I can help.";
  return {
    reply,
    sources: [],
    facts: [],
    hasDate: false,
    citationsOk: false,
    sectionsOk: true,
    topicKey: ""
  };
}

function parseNotesTopic(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const body = raw.replace(/^notes/i, "").trim();
  if (!body) return "";
  const parts = body.split(/\s+/);
  if (!parts.length) return "";
  if (parts[parts.length - 1].toLowerCase() === "list") {
    parts.pop();
  }
  return parts.join(" ").trim();
}

export function handleContractTurn({ text = "", now = new Date() } = {}) {
  const route = routeContractIntent(text);

  if (route.intent === "notes_cmd") {
    const topicRaw = parseNotesTopic(text);
    const topicKey = topicRaw ? topicRaw.toLowerCase() : "";
    if (!topicKey) {
      return {
        handled: true,
        intent: route.intent,
        requiresBrowse: false,
        reply: "No notes yet...",
        sources: [],
        facts: [],
        hasDate: false,
        citationsOk: false,
        sectionsOk: true,
        topicKey: "",
        searchLogs: []
      };
    }
    const cards = getCardsByTopic(topicKey);
    const title = formatTopicTitle(topicKey) || topicKey;
    if (!cards.length) {
      return {
        handled: true,
        intent: route.intent,
        requiresBrowse: false,
        reply: `No notes yet for ${topicKey}.`,
        sources: [],
        facts: [],
        hasDate: false,
        citationsOk: false,
        sectionsOk: true,
        topicKey,
        searchLogs: []
      };
    }
    const lines = cards.slice(0, 5).map((card, idx) => {
      const seen = card.last_seen || card.first_seen || "";
      return `${idx + 1}. ${card.claim} (last seen ${seen})`;
    });
    return {
      handled: true,
      intent: route.intent,
      requiresBrowse: false,
      reply: `Notes for ${title}:\n${lines.join("\n")}`,
      sources: [],
      facts: [],
      hasDate: false,
      citationsOk: false,
      sectionsOk: true,
      topicKey,
      searchLogs: []
    };
  }

  if (route.intent === "how_to_recipe") {
    const match = matchByAlias(RECIPE_LIBRARY, text);
    if (!match) return { handled: false };
    const response = buildRecipeResponse(match);
    return {
      handled: true,
      intent: route.intent,
      requiresBrowse: route.requiresBrowse,
      reply: response.reply,
      sources: response.sources,
      facts: response.facts,
      hasDate: response.hasDate,
      citationsOk: response.citationsOk,
      sectionsOk: response.sectionsOk,
      topicKey: response.topicKey,
      searchLogs: []
    };
  }

  if (route.intent === "news_latest") {
    const match = matchByAlias(NEWS_TOPICS, text);
    if (!match) return { handled: false };
    const response = buildNewsResponse(match, now);
    if (!response) return { handled: false };
    return {
      handled: true,
      intent: route.intent,
      requiresBrowse: true,
      reply: response.reply,
      sources: response.sources,
      facts: response.facts,
      hasDate: response.hasDate,
      citationsOk: response.citationsOk,
      sectionsOk: response.sectionsOk,
      topicKey: response.topicKey,
      searchLogs: [{ q: match.searchQuery, hits: match.sources.length }]
    };
  }

  if (route.intent === "generic") {
    const cleaned = String(text || "").trim();
    if (!cleaned) {
      const response = buildGenericResponse(text);
      return {
        handled: true,
        intent: route.intent,
        requiresBrowse: false,
        reply: response.reply,
        sources: response.sources,
        facts: response.facts,
        hasDate: response.hasDate,
        citationsOk: response.citationsOk,
        sectionsOk: response.sectionsOk,
        topicKey: response.topicKey,
        searchLogs: []
      };
    }
    return { handled: false };
  }

  return { handled: false };
}
