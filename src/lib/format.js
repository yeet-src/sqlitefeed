// Pure presentation helpers — strings and color, no signals or BPF.
// Imported by the components through the `@/` alias (resolved at bundle time).
import { idx } from "yeet:tui";

export const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
export const lpad = (s, n) => (" ".repeat(n) + s).slice(-n);

// A statement's SQL as display lines, dropping leading/trailing blank lines
// (some SQL arrives with a leading newline) so no row is wasted. Shared by the
// list (rendering + height budgeting) and main.jsx's scroll math, so all three
// agree on how many rows a statement occupies.
export const sqlLines = (sql) => {
  const lines = (sql || "«unknown»").split("\n");
  while (lines.length > 1 && lines[0].trim() === "") lines.shift();
  while (lines.length > 1 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
};

// Terminal rows a statement occupies in the list: one per SQL line, plus one
// for the bound-parameter line and one for the error line when present.
export const rowHeight = (s) =>
  sqlLines(s.sql).length + (s.params.length ? 1 : 0) + (s.errmsg ? 1 : 0);

// Nearest-rank percentile (p in 0..1) of a numeric array. Empty → 0.
export const pctl = (arr, p) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))];
};

// A per-second rate as a short human string: 12, 4.2K, 1.1M.
export const fmtRate = (perSec) => {
  if (perSec < 1000) return `${Math.round(perSec)}`;
  if (perSec < 1e6) return `${(perSec / 1e3).toFixed(1)}K`;
  return `${(perSec / 1e6).toFixed(1)}M`;
};

// A nanosecond duration as ns / µs / ms / s.
export const fmtDuration = (ns) => {
  if (ns <= 0) return "0";
  if (ns < 1e3) return `${Math.round(ns)}ns`;
  if (ns < 1e6) return `${(ns / 1e3).toFixed(0)}µs`;
  if (ns < 1e9) return `${(ns / 1e6).toFixed(1)}ms`;
  return `${(ns / 1e9).toFixed(2)}s`;
};

// Map a step latency to a 0..1 fraction on a log scale (~10µs → cool,
// ~100ms → hot), for coloring via the heat ramp below.
export const latFrac = (ns) => {
  if (ns <= 0) return 0;
  const f = (Math.log10(ns) - 4) / 4; // 10^4ns=10µs → 0, 10^8ns=100ms → 1
  return Math.max(0, Math.min(1, f));
};

// Cold → hot "inferno" ramp for a 0..1 fraction: charcoal floor rising through
// deep purple and magenta into orange, gold, and white-hot. Index 0 is a
// visible charcoal so quiet values still register.
const RAMP = [
  234, 17, 54, 55, 91, 127, 163, 199, 205, 203, 209, 215, 221, 227, 229, 231,
].map(idx);
export const heat = (frac) =>
  RAMP[Math.min(RAMP.length - 1, Math.max(0, Math.floor(frac * RAMP.length)))];

// sqlite result codes → short names. 0/100/101 are the normal path; anything
// else is an error worth flagging.
const RC = {
  0: "OK", 100: "ROW", 101: "DONE",
  1: "ERROR", 5: "BUSY", 6: "LOCKED", 8: "READONLY",
  11: "CORRUPT", 14: "CANTOPEN", 19: "CONSTRAINT", 20: "MISMATCH",
  // Extended constraint codes (rc = primary | subcode<<8), surfaced when the
  // connection has extended result codes enabled. The low byte is the primary
  // code, so anything not named here still resolves via the `rc & 0xff` fallback.
  275: "CHECK", 787: "FOREIGNKEY", 1299: "NOTNULL", 1555: "PRIMARYKEY", 2067: "UNIQUE",
};
export const rcName = (rc) => RC[rc] ?? RC[rc & 0xff] ?? `rc ${rc}`;
// Normal path is OK/ROW/DONE (0/100/101); everything else — primary or
// extended — is an error worth flagging.
export const rcIsError = (rc) => !(rc === 0 || rc === 100 || rc === 101);

// A single bound parameter as `?idx=value`. Text is quoted and truncated;
// reals show a placeholder (the double is passed in a register BPF can't read).
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
export const fmtParam = (p) => {
  const label = `?${p.idx}`;
  switch (p.type) {
    case "text": return `${label}='${clip(p.text, 24)}'`;
    case "null": return `${label}=NULL`;
    case "real": return `${label}=«real»`;
    default: return `${label}=${p.text}`; // int
  }
};
export const fmtParams = (list) => list.map(fmtParam).join("  ");
