// SQL syntax highlighting — pure, no signals or BPF. Turns one line of SQL into
// faced runs [{ text, fg }] that statements.jsx renders as nested <Text> spans
// (CLAUDE.md "per-span → nest"). Colors ride the same idx() palette as the rest
// of the UI. Line-based on purpose: the traced statements are single- or
// tidily-wrapped lines, and the panel already renders one terminal row per SQL
// line, so a string/comment is highlighted per line rather than across lines.
import { idx } from "yeet:tui";

const KW = idx(111); // keywords — cornflower blue
const STR = idx(150); // string literals — soft green
const NUM = idx(215); // numbers — gold
const CMT = idx(244); // comments — dim (matches DIM)
const PUNCT = idx(246); // operators / punctuation — mid grey
const IDENT = idx(252); // identifiers / plain text (matches SQLFG)
const PARAM = idx(179); // bound-parameter placeholders (matches the params line)

export const sqlColors = { KW, STR, NUM, CMT, PUNCT, IDENT, PARAM };

// SQLite keyword set (uppercased). Generous but not exhaustive — unknown words
// fall through to IDENT, which is the same near-white the panel used before, so
// a missing keyword just isn't tinted rather than looking wrong.
// prettier-ignore
const KEYWORDS = new Set(`
  ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH AUTOINCREMENT
  BEFORE BEGIN BETWEEN BY CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT
  CONSTRAINT CREATE CROSS CURRENT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP
  DATABASE DEFAULT DEFERRABLE DEFERRED DELETE DESC DETACH DISTINCT DO DROP EACH
  ELSE END ESCAPE EXCEPT EXCLUSIVE EXISTS EXPLAIN FAIL FILTER FIRST FOLLOWING FOR
  FOREIGN FROM FULL GENERATED GLOB GROUP GROUPS HAVING IF IGNORE IMMEDIATE IN INDEX
  INDEXED INITIALLY INNER INSERT INSTEAD INTERSECT INTO IS ISNULL JOIN KEY LAST LEFT
  LIKE LIMIT MATCH MATERIALIZED NATURAL NO NOT NOTHING NOTNULL NULL NULLS OF OFFSET
  ON OR ORDER OTHERS OUTER OVER PARTITION PLAN PRAGMA PRECEDING PRIMARY QUERY RAISE
  RANGE RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE RESTRICT RETURNING
  RIGHT ROLLBACK ROW ROWS SAVEPOINT SELECT SET TABLE TEMP TEMPORARY THEN TIES TO
  TRANSACTION TRIGGER UNBOUNDED UNION UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL
  WHEN WHERE WINDOW WITH WITHOUT
`.trim().split(/\s+/));

const isDigit = (c) => c >= "0" && c <= "9";
const isIdentStart = (c) => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
const isIdentPart = (c) => isIdentStart(c) || isDigit(c) || c === "$";
const isNumPart = (c) => isDigit(c) || "._eExXaAbBcCdDfF".includes(c);

// Tokenize one line into faced runs, coalescing adjacent same-color runs so a
// line becomes a handful of spans, not one per character.
export function highlightLine(line) {
  const toks = [];
  const push = (text, fg) => {
    if (!text) return;
    const last = toks[toks.length - 1];
    if (last && last.fg === fg) last.text += text; // coalesce
    else toks.push({ text, fg });
  };

  const n = line.length;
  let i = 0;
  while (i < n) {
    const c = line[i];

    // line comment: -- to end of line
    if (c === "-" && line[i + 1] === "-") { push(line.slice(i), CMT); break; }

    // block comment: /* … */  (only the portion on this line)
    if (c === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      const to = end === -1 ? n : end + 2;
      push(line.slice(i, to), CMT);
      i = to;
      continue;
    }

    // string literal 'like this' — '' escapes a quote. Double-quoted and
    // backtick-quoted names are identifiers in SQL, so tint those as IDENT.
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (line[j] === c) {
          if (line[j + 1] === c) { j += 2; continue; } // escaped quote
          j++;
          break;
        }
        j++;
      }
      push(line.slice(i, j), c === "'" ? STR : IDENT);
      i = j;
      continue;
    }

    // bound-parameter placeholder: ?, ?NNN, :name, @name, $name
    if (c === "?" || c === ":" || c === "@" || c === "$") {
      let j = i + 1;
      while (j < n && isIdentPart(line[j])) j++;
      push(line.slice(i, j), PARAM);
      i = j;
      continue;
    }

    // number (incl. leading-dot floats like .5, and hex/float chars)
    if (isDigit(c) || (c === "." && isDigit(line[i + 1]))) {
      let j = i + 1;
      while (j < n && isNumPart(line[j])) j++;
      push(line.slice(i, j), NUM);
      i = j;
      continue;
    }

    // identifier or keyword
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(line[j])) j++;
      const word = line.slice(i, j);
      push(word, KEYWORDS.has(word.toUpperCase()) ? KW : IDENT);
      i = j;
      continue;
    }

    // a run of everything else: whitespace + operators/punctuation. Colored
    // PUNCT — whitespace has no glyph, so the color only shows on operators.
    let j = i + 1;
    while (
      j < n &&
      !isIdentStart(line[j]) &&
      !isDigit(line[j]) &&
      line[j] !== "'" && line[j] !== '"' && line[j] !== "`" &&
      line[j] !== "?" && line[j] !== ":" && line[j] !== "@" && line[j] !== "$" &&
      !(line[j] === "." && isDigit(line[j + 1])) &&
      !(line[j] === "-" && line[j + 1] === "-") &&
      !(line[j] === "/" && line[j + 1] === "*")
    ) j++;
    push(line.slice(i, j), PUNCT);
    i = j;
  }
  return toks;
}

// Standalone check: dump faced runs for sample SQL so the tokenizer is
// verifiable before any UI reads it (CLAUDE.md "get the data right first").
//   yeet run src/lib/sqlhl.js
if (import.meta.main) {
  const samples = [
    "SELECT id, name FROM users WHERE age >= 18 AND name LIKE 'a%' LIMIT 10;",
    "insert into t(x) values (1, 2.5, .5, 0xFF); -- trailing comment",
    "update accounts set bal = bal - 100 /* fee */ where id = ?1",
    "  \tCREATE TABLE \"my tbl\" (a INTEGER PRIMARY KEY, b TEXT DEFAULT 'x''y')",
  ];
  for (const s of samples) {
    console.log(`\nSQL: ${s}`);
    for (const t of highlightLine(s)) {
      console.log(`  ${JSON.stringify(t.text)}  fg=${JSON.stringify(t.fg)}`);
    }
  }
  yeet.exit();
}
