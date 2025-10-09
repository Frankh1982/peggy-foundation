/**
 * Simple preference detectors for autogaps.
 * Each detector: { path, patterns[], ask, norm?: (s)=>any }
 */
export const PREF_DETECTORS = [
  {
    path: "prefs.favorite_apple",
    patterns: [
      /what('?s| is)\s+my\s+(favorite|favourite)\s+apple\b/i,
      /my\s+(favorite|favourite)\s+apple\b/i,
      /what\s+apple\s+do\s+i\s+prefer\b/i
    ],
    ask: "Which apple variety do you prefer? (e.g., Honeycrisp, Fuji, Granny Smith)",
    norm: (s) => String(s).trim()
  },
  {
    path: "prefs.save_dir",
    patterns: [
      /(what|where)('?s| is)?\s+my\s+default\s+save\s+(folder|directory|dir)\b/i
    ],
    ask: "Where should I save files by default? (e.g., /sandbox)",
    norm: (s) => String(s).trim()
  },
  {
    path: "prefs.units",
    patterns: [
      /do\s+i\s+use\s+(metric|imperial)\s+units/i,
      /what\s+units\s+do\s+i\s+prefer/i
    ],
    ask: "Do you prefer metric or imperial units?",
    norm: (s) => /metric/i.test(s) ? "metric" : /imperial/i.test(s) ? "imperial" : String(s).trim()
  }
];

export function tryMatchPreferenceQuery(text) {
  const t = String(text || "");
  for (const d of PREF_DETECTORS) {
    if (d.patterns.some(rx => rx.test(t))) {
      return d; // {path, ask, norm}
    }
  }
  return null;
}

// Get value at dotted path
export function getAtPath(obj, path) {
  const parts = String(path).split(".");
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

// Set value at dotted path, returns updated object
export function setAtPath(obj, path, value) {
  const parts = String(path).split(".");
  let cur = obj;
  for (let i=0;i<parts.length-1;i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length-1]] = value;
  return obj;
}
