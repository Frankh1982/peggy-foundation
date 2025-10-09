const chat = document.getElementById("chat");
const input = document.getElementById("input");
const btn = document.getElementById("send");
const statusEl = document.getElementById("status");

const kdnStateEl = document.getElementById("kdn_state");
const kdnReasonEl = document.getElementById("kdn_reason");
const tokEl = document.getElementById("tok");
const buildEl = document.getElementById("build");
const policyEl = document.getElementById("policy");
const learnEl = document.getElementById("learn");
const eventsEl = document.getElementById("events");

let callPolicy = "auto";
fetch("/version")
  .then(r=>r.json())
  .then(j=> {
    buildEl.textContent = j.build || "—";
    callPolicy = j.call_policy || "auto";
    policyEl.textContent = callPolicy;
  })
  .catch(()=>{});

const sessionId = "local";
const userId = "localuser";

let ws;
function connect() {
  const url = new URL("/chat", window.location);
  ws = new WebSocket(url);
  ws.onopen = () => { statusEl.textContent = "connected"; };
  ws.onclose = () => { statusEl.textContent = "disconnected"; };
  ws.onerror = () => { statusEl.textContent = "error"; };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "assistant_message") {
        addMsg("assistant", msg.content);
      } else if (msg.type === "call_proposed") {
        renderCall(msg.call);
      } else if (msg.type === "call_result") {
        const r = msg.run?.result_summary || {};
        if (msg.run?.tool === "web_search" || r.engine) {
          logEvent(`search_result: ${r.engine || msg.run.tool} • q="${msg.run.args?.q}" • k=${r.k} • ${r.latency_ms ?? "?"}ms`);
        } else {
          logEvent(`call_result: ${msg.call_id} → ${r.title || "(no title)"} (${r.url || ""}) • ${r.latency_ms ?? "?"}ms`);
        }
      } else if (msg.type === "learning_stats") {
        const s = msg.stats || {};
        learnEl.textContent = `episodes: ${s.sample ?? 0}\nsuccess_rate: ${Math.round((s.success_rate||0)*100)}%` + (s.avg_tokens? `\navg_tokens: ${s.avg_tokens}` : "");
      } else if (msg.type === "kdn") {
        const k = msg.kdn || {};
        kdnStateEl.textContent = (k.state || "—") + (k.ambiguous ? " (ambiguous)" : "");
        kdnReasonEl.textContent = k.reason || "—";
      } else if (msg.type === "telemetry") {
        const u = msg.usage || {};
        tokEl.textContent = `${u.prompt_tokens ?? "—"} / ${u.completion_tokens ?? "—"} / ${u.total_tokens ?? "—"}`;
      } else if (msg.type === "error") {
        addMsg("assistant", "Error: " + (msg.error || "unknown"));
      }
    } catch(_) {}
  };
}
connect();

btn.onclick = sendMsg;
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMsg();
  }
});

function sendMsg() {
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "user_message", session_id: sessionId, user_id: userId, content: text }));
  addMsg("user", text);
  input.value = "";
}

function addMsg(role, content) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.innerHTML = `<div class="role">${role}</div><div class="content">${escapeHtml(content)}</div>`;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

function renderCall(c) {
  const url = c?.spec?.args?.url || "";
  const q   = c?.spec?.args?.q || "";
  const tool = c?.spec?.tool || "";
  const host = url ? (()=>{ try { return new URL(url).host; } catch { return ""; } })() : "";
  const auto = true; // CALL_POLICY=auto

  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = `<div class="role">assistant</div>
    <div class="content">
      <div class="call-card">
        <b>Tool:</b> ${escapeHtml(tool)} ${auto? "(auto)" : ""}<br/>
        ${url ? `<i>URL:</i> ${escapeHtml(url)}<br/><i>Host:</i> ${escapeHtml(host)}<br/>` : ""}
        ${q ? `<i>Query:</i> ${escapeHtml(q)}<br/>` : ""}
      </div>
    </div>`;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

function logEvent(s) {
  const t = eventsEl.textContent.trim();
  eventsEl.textContent = (t === "—" ? "" : t + "\n") + s;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
