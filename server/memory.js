import fs from "fs";
import path from "path";

const base = path.resolve("data");
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

export function getUserProfile(userId) {
  const dir = path.join(base, "users", userId);
  ensureDir(dir);
  const file = path.join(dir, "profile.json");
  if (!fs.existsSync(file)) return { name: null, prefs: {}, assistant: {} };
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!obj.prefs) obj.prefs = {};
    if (!obj.assistant) obj.assistant = {};
    return obj;
  } catch { return { name: null, prefs: {}, assistant: {} }; }
}
export function updateUserProfile(userId, partial) {
  const dir = path.join(base, "users", userId);
  ensureDir(dir);
  const file = path.join(dir, "profile.json");
  const old = getUserProfile(userId);
  const next = deepMerge(old, partial);
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}
export function appendNote(userId, note) {
  const dir = path.join(base, "users", userId);
  ensureDir(dir);
  const file = path.join(dir, "notes.jsonl");
  const row = { ts: Date.now(), ...note };
  fs.appendFileSync(file, JSON.stringify(row) + "\n");
  return row;
}
export function appendMessage(sessionId, msg) {
  const dir = path.join(base, "sessions", sessionId);
  ensureDir(dir);
  const file = path.join(dir, "messages.jsonl");
  fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), ...msg }) + "\n");
}
export function getRecentMessages(sessionId, n = 8) {
  const dir = path.join(base, "sessions", sessionId);
  const file = path.join(dir, "messages.jsonl");
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-n).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean).map(({ role, content }) => ({ role, content }));
}
export function appendGap(userId, gap) {
  const dir = path.join(base, "users", userId);
  ensureDir(dir);
  const file = path.join(dir, "gaps.jsonl");
  fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), status:"open", ...gap })+"\n");
}
export function closeGap(userId, gap_id, evidenceRef) {
  const dir = path.join(base, "users", userId);
  const file = path.join(dir, "gaps.jsonl");
  if (!fs.existsSync(file)) return;
  const rows = fs.readFileSync(file,"utf8").trim().split("\n").filter(Boolean).map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean);
  const out = rows.map(r => r.gap_id===gap_id ? { ...r, status:"closed", evidence:evidenceRef, closed_ts: Date.now() } : r);
  fs.writeFileSync(file, out.map(JSON.stringify).join("\n")+"\n");
}
function deepMerge(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return b;
  if (isObj(a) && isObj(b)) {
    const out = { ...a };
    for (const k of Object.keys(b)) {
      out[k] = k in a ? deepMerge(a[k], b[k]) : b[k];
    }
    return out;
  }
  return b;
}
function isObj(x){ return x && typeof x === "object" && !Array.isArray(x); }
