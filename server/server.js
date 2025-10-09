import "dotenv/config";
import fs from "fs";
import path from "path";
import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import { buildSystemPrompt } from "./prompt.js";
import { getUserProfile, updateUserProfile, appendMessage, getRecentMessages, appendGap, closeGap, appendNote } from "./memory.js";
import { tool_web_get, tool_web_search, saveRunRecord } from "./tools.js";
import { bucketTopic, recordSearch, recordFetch, recordEpisode, recentStats, buildQueryList, playbookFor, updateBandit } from "./learn.js";

const PORT = process.env.PORT || 8787;
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const RECENT_N = Number(process.env.RECENT_N || 4);
const MAX_PAGE_CHARS = Number(process.env.MAX_PAGE_CHARS || 16000);
const CALL_POLICY = (process.env.CALL_POLICY || "auto").trim().toLowerCase();
const PEG_BUILD = "2025-10-04-v3j-learn";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in .env");
  process.exit(1);
}

const app = express();
app.use(express.static(path.resolve("public")));
app.get("/version", (_req, res) => res.json({ build: PEG_BUILD, call_policy: CALL_POLICY }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/chat" });

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

    // Search intents
    if (wantsListOnly(content) || /^\s*(search|look up)\b/i.test(content)) {
      const topic = bucketTopic(content);
      const base = content.replace(/^\s*(search|look up)\b/i, "").trim() || content;
      const { qlist, keysUsed } = buildQueryList(base, { max: 8 });
      const spec = { tool: "web_search", args: { q: base, qlist, k: 5 } };
      await executeTool(ws, { userId, sessionId, spec, requestText: content, topic, banditKeys: keysUsed });
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

      await callModelWithGetResult(ws, meta, run);
    } else if (meta.spec.tool === "web_search") {
      const t0 = Date.now();
      const result = await tool_web_search(meta.spec.args, { MAX_PAGE_CHARS, BRAVE_API_KEY: process.env.BRAVE_API_KEY });
      const run = saveRunRecord("web_search", meta.spec.args, result);
      ws.send(JSON.stringify({ type:"call_result", call_id, run }));

      // Learning: search ledger + bandit reward + episode
      const topic = meta.topic || bucketTopic(meta.requestText || meta.spec.args.q);
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
      const items = (result?.results || []).slice(0,5);
      if (items.length) {
        const lines = items.map((r,i) => `#${i+1} — ${r.title || "(no title)"} — ${r.url}`).join("\n");
        const msg = `Here are ${items.length} sources:\n${lines}`;
        appendMessage(meta.sessionId, { role:"assistant", content: msg });
        ws.send(JSON.stringify({ type:"assistant_message", content: msg }));
      } else {
        const pb = playbookFor(topic);
        const hint = (pb?.if_k0 && pb.if_k0.length) ? `Tried variants. Consider: ${pb.if_k0.slice(0,3).join(", ")}` : "Try adding org names or dates.";
        const msg = `I couldn't find credible sources for that query. ${hint}`;
        appendMessage(meta.sessionId, { role:"assistant", content: msg });
        ws.send(JSON.stringify({ type:"assistant_message", content: msg }));
      }

      // If not list-only, continue to model to pick best URL
      if (!/\b(find|show|list)\b.+\b(more|sites|sources|articles|links)\b/i.test(meta.requestText || "") && items.length) {
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
  handleAssistantResponse(ws, { completion, usage, userId, sessionId });
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
    // Try to attribute tokens to last episode (best-effort): write tokens_total on last row
    try {
      const epFile = path.resolve("data","learn","episodes.jsonl");
      const lines = fs.existsSync(epFile) ? fs.readFileSync(epFile,"utf8").trim().split("\n").filter(Boolean) : [];
      if (lines.length) {
        const last = JSON.parse(lines[lines.length-1]);
        if (!last.tokens_total && usage.total_tokens) {
          last.tokens_total = usage.total_tokens;
          lines[lines.length-1] = JSON.stringify(last);
          fs.writeFileSync(epFile, lines.join("\n")+"\n");
          ws.send(JSON.stringify({ type:"learning_stats", stats: recentStats(20) }));
        }
      }
    } catch {}
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
