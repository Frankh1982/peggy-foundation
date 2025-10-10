import fs from "fs";
import path from "path";

const runsDir = path.resolve("data", "runs");
fs.mkdirSync(runsDir, { recursive: true });

export async function tool_web_get(args, env={}) {
  const url = String(args?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("Invalid url");
  const t0 = Date.now();
  const res = await fetch(url, { redirect: "follow", headers: {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9"
  }});
  const html = await res.text();
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [,""])[1].replace(/\s+/g," ").trim();
  const text = capText(htmlToText(html), Number(env.MAX_PAGE_CHARS || 16000));
  const latency_ms = Date.now() - t0;
  return { status: res.status, url: res.url || url, title, text, chars: text.length, latency_ms };
}

export async function tool_web_search(args, env={}) {
  const q = String(args?.q || "").trim();
  const qlist = Array.isArray(args?.qlist) ? args.qlist.filter(Boolean) : [];
  if (!q && !qlist.length) throw new Error("Empty query");
  const K = Math.min(Math.max(Number(args?.k || 5), 1), 8);
  const offset = Math.max(0, Math.floor(Number(args?.offset) || 0));

  const queries = (qlist.length ? qlist : [q]).filter(Boolean);
  const braveKey = (env.BRAVE_API_KEY || process.env.BRAVE_API_KEY || "").trim();
  const seen = new Set();
  const out = [];
  const t0 = Date.now();
  let skipped = 0;

  for (const query of queries) {
    let batch = [];
    let remoteOffsetApplied = false;
    if (braveKey) {
      try {
        const u = new URL("https://api.search.brave.com/res/v1/web/search");
        u.searchParams.set("q", query);
        u.searchParams.set("count", String(K));
        if (offset) {
          u.searchParams.set("offset", String(offset));
        }
        const res = await fetch(u, { headers: { "X-Subscription-Token": braveKey, "User-Agent": "Mozilla/5.0" } });
        if (res.ok) {
          remoteOffsetApplied = offset > 0;
          const json = await res.json();
          batch = (json?.web?.results || []).map(r => ({
            title: r.title || "",
            url: r.url || r.open_url || "",
            snippet: r.description || r.snippet || ""
          }));
        }
      } catch {}
    }
    if (!batch.length) {
      try {
        const u2 = new URL("https://html.duckduckgo.com/html/");
        u2.searchParams.set("q", query);
        u2.searchParams.set("kl", "us-en");
        const res2 = await fetch(u2, { headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "text/html",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://duckduckgo.com/"
        }});
        const html = await res2.text();
        const blocks = html.split('<div class="result__body">').slice(1, K+5);
        for (const b of blocks) {
          const a = b.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
          if (!a) continue;
          let href = a[1];
          let title = a[2].replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
          try { const m = href.match(/uddg=([^&]+)/); href = m ? decodeURIComponent(m[1]) : href; } catch {}
          const snip = (b.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i) || [,""])[1]
                        .replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
          batch.push({ title, url: href, snippet: snip });
          if (batch.length >= K) break;
        }
      } catch {}
    }
    if (!batch.length) {
      try {
        const u3 = new URL("https://www.bing.com/search");
        u3.searchParams.set("q", query);
        u3.searchParams.set("count", String(K+2));
        const res3 = await fetch(u3, { headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "text/html",
          "Accept-Language": "en-US,en;q=0.9"
        }});
        const html3 = await res3.text();
        const blocks = html3.split('<li class="b_algo"').slice(1, K+5);
        for (const b of blocks) {
          const m = b.match(/<h2>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i);
          if (!m) continue;
          const href = m[1];
          const title = m[2].replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
          const snip = (b.match(/<p>([\s\S]*?)<\/p>/i) || [,""])[1].replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
          batch.push({ title, url: href, snippet: snip });
          if (batch.length >= K) break;
        }
      } catch {}
    }
    const applyLocalOffset = offset > 0 && !remoteOffsetApplied;
    for (const r of batch) {
      if (applyLocalOffset && skipped < offset) {
        skipped++;
        continue;
      }
      const key = (r.title||"").toLowerCase().slice(0,140) + "||" + (r.url||"").split("#")[0];
      if (!seen.has(key)) {
        seen.add(key);
        out.push(r);
      }
      if (out.length >= K) break;
    }
    if (out.length >= K) break;
  }

  const latency_ms = Date.now() - t0;
  return { engine: braveKey ? "brave+fallbacks" : "ddg+bing", q, qlist: queries, k: out.length, results: out, latency_ms };
}

export function saveRunRecord(tool, args, result) {
  const id = "run_" + Date.now();
  const record = { id, ts: Date.now(), tool, args, result_summary: summarize(tool, result) };
  const file = path.join(runsDir, id + ".json");
  fs.writeFileSync(file, JSON.stringify({ ...record, result }, null, 2));
  return { ...record, result };
}

function summarize(tool, result) {
  if (tool === "web_get") return { url: result?.url, title: result?.title, chars: result?.chars, latency_ms: result?.latency_ms };
  if (tool === "web_search") return { q: result?.q, k: result?.k, engine: result?.engine, latency_ms: result?.latency_ms };
  return {};
}

function htmlToText(html) {
  let s = String(html || "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--([\s\S]*?)-->/g, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeBasicEntities(s);
  s = s.replace(/[\u00A0\s]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return s;
}
function decodeBasicEntities(s) {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}
function capText(s, max) { s = String(s || ""); return s.length <= max ? s : s.slice(0, max); }
