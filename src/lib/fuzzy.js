// Pure fuzzy-filter helpers — no signals, no BPF.

// Subsequence match: every char of `q` appears in `text`, in order,
// case-insensitive. Empty query matches everything. This is the classic
// fuzzy-finder test ("stusr" matches "SELECT * FROM users").
export const fuzzyMatch = (q, text) => {
  if (!q) return true;
  const query = q.toLowerCase();
  const t = text.toLowerCase();
  let i = 0;
  for (let j = 0; j < t.length && i < query.length; j++) {
    if (t[j] === query[i]) i++;
  }
  return i === query.length;
};

// The character indices of `text` that a greedy subsequence match of `q`
// consumes, or null if `text` doesn't contain the whole query. Same algorithm
// as fuzzyMatch, but it records where each query char landed — so the UI can
// highlight exactly the matched characters. Empty query → no positions.
export const fuzzyPositions = (q, text) => {
  if (!q) return null;
  const query = q.toLowerCase();
  const t = text.toLowerCase();
  const pos = [];
  let i = 0;
  for (let j = 0; j < t.length && i < query.length; j++) {
    if (t[j] === query[i]) {
      pos.push(j);
      i++;
    }
  }
  return i === query.length ? pos : null;
};

// The text a statement is matched against: process, SQL, and bound values —
// so you can filter by table, by comm, or by a parameter value.
export const haystack = (s) =>
  `${s.comm} ${s.sql} ${s.params.map((p) => p.text).join(" ")}`;
