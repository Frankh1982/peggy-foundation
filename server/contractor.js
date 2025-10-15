import { NEWS_TOPICS, formatDate, matchByAlias } from "./contract_data.js";
import { getCardsByTopic, formatTopicTitle } from "./autocard.js";

const SMALLTALK_RE = /^(hi|hello|hey|thanks|thank you)\b|what'?s your name|who are you|^my name is\b|^my (favorite|favourite)\b/i;
const ACTION_RE = /\b(announced|files|threatens|plans|recalls?|acquires?|ban|tariff|tariffs)\b/i;
const ENTITY_RE = /\b(US|U\.S\.|United States|China|India|Tesla|BYD|OpenAI|AMD|Microsoft|Google|Apple|NVIDIA|Broadcom)\b/;

export function classifyIntent(text) {
  const t = (text || "").trim();
  if (!t || t === "." || t.length < 2) {
    return { intent: "generic", requiresBrowse: false, reason: "short" };
  }
  if (SMALLTALK_RE.test(t)) {
    return { intent: "smalltalk", requiresBrowse: false, reason: "smalltalk" };
  }

  const hasRecency = /\b(latest|today|this week|update|what happened|news)\b/i.test(t);
  if (hasRecency || /\b(find (more )?sites|sources?)\b/i.test(t)) {
    return { intent: "news_latest", requiresBrowse: true, reason: "recency/sites" };
  }

  if (/^(notes|save note)\b/i.test(t)) {
    return { intent: "notes_cmd", requiresBrowse: false, reason: "notes" };
  }

  const requiresBrowse = ACTION_RE.test(t) && ENTITY_RE.test(t);
  return { intent: "generic", requiresBrowse, reason: requiresBrowse ? "action+entity" : "default" };
}

export function routeContractIntent(text) {
  return classifyIntent(text);
}

function buildNewsResponse(entry, now = new Date()) {
  if (!entry) return null;
  const today = formatDate(now);
  const sources = entry.sources.slice(0, 5);
  if (sources.length < 1) return null;
  const summary = entry.summary.endsWith(".") ? entry.summary : `${entry.summary}.`;
  const sentences = summary.split(/(?<=\.)\s+/).filter(Boolean);
  const trimmedSummary = sentences.slice(0, 2).join(" ");
  const watchLine = `What’s next: • ${entry.watch}`;
  const sourceRefs = sources.map((_source, idx) => `[${idx + 1}]`).join(" ");
  const detailed = sources.map((source, idx) => `[${idx + 1}] ${source.title} — ${source.date} (${source.url})`);
  const sourceLine = sources.length === 1 ? "Sources: best single source [1]" : `Sources: ${sourceRefs}`;
  const replyParts = [`As of ${today}: ${trimmedSummary}`];
  replyParts.push(watchLine);
  replyParts.push(sourceLine);
  replyParts.push(...detailed);
  const reply = replyParts.join("\n");
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

function buildGenericResponse(text) {
  const cleaned = String(text || "").trim();
  const reply = cleaned
    ? `Thanks for sharing that. I can dig into "${cleaned}" with you and outline what’s happening if you’d like.`
      + " Let me know if you want the latest update, background, or notes."
    : "I’m ready when you are. Tell me what topic or question you want to explore.";
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

function buildSmalltalkResponse(text) {
  const raw = String(text || "").trim();
  const lower = raw.toLowerCase();
  if (!raw) {
    return "Hi there! What’s on your mind today?";
  }
  const nameMatch = raw.match(/^my name is\s+([A-Za-z][\w\-']*)/i);
  if (nameMatch) {
    return `Nice to meet you, ${nameMatch[1]}! What should we chat about?`;
  }
  const favMatch = raw.match(/^my (favorite|favourite)\s+(.+)/i);
  if (favMatch) {
    return `Good to know your ${favMatch[1]} ${favMatch[2].trim()}. Want to dig into it?`;
  }
  if (/thanks|thank you/i.test(lower)) {
    return "You’re welcome! Happy to help.";
  }
  if (/^(hi|hello|hey)\b/i.test(lower)) {
    return "Hi! How can I help today?";
  }
  if (/who are you|what'?s your name/i.test(lower)) {
    return "I’m Peggy, your research buddy. What would you like to know?";
  }
  return "Hi there! What should we tackle?";
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
        searchLogs: [],
        routerReason: route.reason || "notes"
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
        searchLogs: [],
        routerReason: route.reason || "notes"
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
      searchLogs: [],
      routerReason: route.reason || "notes"
    };
  }

  if (route.intent === "smalltalk") {
    const reply = buildSmalltalkResponse(text);
    return {
      handled: true,
      intent: route.intent,
      requiresBrowse: false,
      reply,
      sources: [],
      facts: [],
      hasDate: false,
      citationsOk: false,
      sectionsOk: true,
      topicKey: "",
      searchLogs: [],
      routerReason: route.reason || "smalltalk"
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
      requiresBrowse: Boolean(route.requiresBrowse),
      reply: response.reply,
      sources: response.sources,
      facts: response.facts,
      hasDate: response.hasDate,
      citationsOk: response.citationsOk,
      sectionsOk: response.sectionsOk,
      topicKey: response.topicKey,
      searchLogs: [{ q: match.searchQuery, hits: match.sources.length }],
      routerReason: route.reason || "news"
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
        searchLogs: [],
        routerReason: route.reason || "default"
      };
    }
    return { handled: false };
  }

  return { handled: false };
}
