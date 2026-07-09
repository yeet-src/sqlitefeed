// The main panel: a live, newest-first list of prepared statements. Each is
// one row — process, SQL (flexes, ellipsized), then rows-returned, worst step
// latency (heat-colored), and the last result code — with a second dim row of
// bound parameters when the statement has any. Pure UI: it reads the
// `statements` and `size` signals and nothing else.
import { Box, Text, idx } from "yeet:tui";
import { lpad, fmtDuration, heat, latFrac, rcName, rcIsError, fmtParams, sqlLines, rowHeight } from "@/lib/format.js";
import { highlightLine } from "@/lib/sqlhl.js";
import { fuzzyPositions } from "@/lib/fuzzy.js";

const COMM = idx(109); // process label
const SQLFG = idx(252); // SQL text (near-white)
const DIM = idx(244); // metrics / hints
const OKRC = idx(108); // normal result code
const ERR = idx(203); // error result code / SQL
const PARAMS = idx(179); // bound-parameter line
const SELBG = idx(238); // selected-row highlight
const MATCHBG = idx(58); // fuzzy-match highlight background

// Per-line sets of column indices matched by the fuzzy query, or null when no
// query is active or the SQL doesn't contain it. Computed against the joined
// display text so indices map straight onto the rendered lines; a row visible
// only because `comm`/params matched simply yields no SQL highlight.
const matchHits = (q, lines) => {
  if (!q) return null;
  const text = lines.join("\n");
  const hits = fuzzyPositions(q, text);
  if (!hits) return null;
  const sets = lines.map(() => new Set());
  const hitSet = new Set(hits);
  let li = 0;
  let col = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      li++;
      col = 0;
      continue;
    }
    if (hitSet.has(i)) sets[li].add(col);
    col++;
  }
  return sets;
};

// Render one SQL line as <Text> spans: syntax-colored tokens (or a uniform
// `base` face when the row errored), with matched columns bolded on a highlight
// bg. Matched runs split their token, so the highlight face merges over the
// token's own fg — its color survives under the highlight.
const sqlSpans = (text, base, err, hits) => {
  const tokens = err ? [{ text, fg: base }] : highlightLine(text);
  if (!hits || !hits.size) return tokens.map((t) => <Text fg={t.fg}>{t.text}</Text>);
  const out = [];
  let col = 0;
  for (const tok of tokens) {
    let run = "";
    let runHit = null;
    const flush = () => {
      if (!run) return;
      out.push(runHit ? <Text fg={tok.fg} bold bg={MATCHBG}>{run}</Text> : <Text fg={tok.fg}>{run}</Text>);
      run = "";
    };
    for (let k = 0; k < tok.text.length; k++) {
      const hit = hits.has(col);
      if (runHit !== null && hit !== runHit) flush();
      run += tok.text[k];
      runHit = hit;
      col++;
    }
    flush();
  }
  return out;
};

// The SQL is rendered one terminal row per source line, preserving the
// statement's own whitespace/indentation. The process label sits in the left
// gutter of the first line and the metrics (rows / worst latency / result
// code) pin to the right of it; continuation lines keep the gutter blank so
// the SQL block reads as a unit.
function StmtRow({ s, sel, q }) {
  const err = rcIsError(s.lastRc);
  const latColor = err ? ERR : heat(latFrac(s.maxNs));
  const lines = sqlLines(s.sql);
  const hits = matchHits(q, lines); // fuzzy-match columns per line, or null

  const line = (text, i, first) => {
    const kids = [
      <Box width="20" overflow="hidden">
        <Text break="none" overflow="ellipsis" fg={COMM}>{first ? `${s.comm}/${s.pid}` : ""}</Text>
      </Box>,
      <Box width="1fr" overflow="hidden">
        <Text break="none" overflow="ellipsis" fg={err ? ERR : SQLFG}>
          {/* per-token syntax spans, with fuzzy-match columns highlighted (the
              outer fg is only a fallback for the gaps between spans). */}
          {text.length ? sqlSpans(text, err ? ERR : SQLFG, err, hits?.[i]) : " "}
        </Text>
      </Box>,
    ];
    if (first) {
      kids.push(
        <Text width="9" break="none" fg={DIM}>{lpad(s.isExec ? "exec" : `${s.rows}r`, 9)}</Text>,
        <Text width="9" break="none" fg={latColor}>{lpad(fmtDuration(s.maxNs), 9)}</Text>,
        <Text width="10" break="none" bold fg={err ? ERR : OKRC}>{lpad(rcName(s.lastRc), 10)}</Text>,
      );
    }
    return <Box direction="row" height="1">{kids}</Box>;
  };

  return (
    <Box direction="column" bg={sel ? SELBG : undefined}>
      {lines.map((ln, i) => line(ln, i, i === 0))}
      {s.params.length ? (
        <Text height="1" break="none" overflow="ellipsis" fg={PARAMS}>{`   ↳ ${fmtParams(s.params)}`}</Text>
      ) : null}
      {s.errmsg ? (
        <Text height="1" break="none" overflow="ellipsis" fg={ERR}>{`   ✗ ${s.errmsg}`}</Text>
      ) : null}
    </Box>
  );
}

export default function Statements({ visible, size, scroll, selected, filter, errorsOnly }) {
  return (
    <Box height="1fr" overflow="hidden">
      {() => {
        const list = visible.get();
        if (!list.length) {
          const q = filter.get();
          const eo = errorsOnly.get();
          const msg = q
            ? `   no ${eo ? "errors" : "statements"} match “${q}”`
            : eo
              ? "   no errors yet  —  press e to show all statements"
              : "   waiting for SQL…  try:  sqlite3 :memory: 'select 1+1'   or  demo/run.sh";
          return <Text height="1" fg={DIM}>{msg}</Text>;
        }
        // Start at the scroll offset (0 = newest) and emit statements while any
        // row of body height remains. The last statement may not fully fit — a
        // tall multi-line one landing at the bottom is still emitted and the
        // panel's overflow:hidden clips its trailing lines. (Height-budgeting a
        // multi-line statement as an indivisible unit would drop it whole and
        // leave a blank gap above the footer.)
        const budget = Math.max(1, size.get().rows - 2); // minus title + footer
        const offset = Math.min(scroll.get(), Math.max(0, list.length - 1));
        const cur = selected.get();
        const q = filter.get();
        const out = [];
        let used = 0;
        for (let i = offset; i < list.length && used < budget; i++) {
          const s = list[i];
          out.push(<StmtRow s={s} sel={i === cur} q={q} />);
          used += rowHeight(s); // one row per SQL line, plus the params line
        }
        return out;
      }}
    </Box>
  );
}
