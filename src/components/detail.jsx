// Detail overlay for one statement, opened with Enter on the selected row and
// dismissed with Esc. Three blocks: the full SQL (syntax-highlighted, wrapped,
// no ellipsis), every bound parameter in full (the list clips these), and two
// metric panels — this execution's step timing, and cross-run stats aggregated
// over every logged run of the identical SQL.
//
// Pure UI. The statement `s` is a frozen snapshot passed in, so it never
// changes; the cross-run panel reads the live `statements` log, so it keeps
// updating while the overlay is open (e.g. a hot query's percentiles move).
import { Box, Text, idx } from "yeet:tui";
import { highlightLine } from "@/lib/sqlhl.js";
import { fmtDuration, heat, latFrac, rcName, rcIsError, pctl } from "@/lib/format.js";

const LABEL = idx(244); // metric labels
const VALUE = idx(252); // metric values
const HEAD = idx(45); // section headers / brand
const SUB = idx(109); // process label
const ERR = idx(203);
const OK = idx(108);
const PARAM = idx(179);
const RULE = idx(240);
const BARS = "▁▂▃▄▅▆▇█";

// A "label   value" line. `value` may be a string or a pre-faced node.
const kv = (label, value, fg = VALUE) => (
  <Text height="1" break="none">
    <Text fg={LABEL}>{`${label}`.padEnd(13)}</Text>
    {typeof value === "string" ? <Text fg={fg}>{value}</Text> : value}
  </Text>
);

const section = (title) => (
  <Text height="1" break="none" bold fg={HEAD}>{title}</Text>
);
const blank = () => <Text height="1">{" "}</Text>;

// A bound parameter in full (no 24-char clip, unlike the list's ↳ line).
const paramText = (p) =>
  p.type === "text" ? `'${p.text}'` : p.type === "null" ? "NULL" : p.type === "real" ? "«real»" : p.text;

export default function Detail({ s, statements }) {
  return (
    <Box height="1fr" direction="column" overflow="hidden" padding={1}>
      {() => {
        const err = rcIsError(s.lastRc);
        const steps = s.steps ?? 0;
        const sel = steps ? (s.rows / steps) : 0; // fraction of steps that returned a row

        // Cross-run: every logged execution of this exact SQL.
        const runs = statements.get().filter((r) => r.sql === s.sql);
        const lats = runs.map((r) => r.maxNs).filter((n) => n > 0);
        const errs = runs.filter((r) => rcIsError(r.lastRc)).length;
        const procs = [...new Set(runs.map((r) => r.comm))];
        // Oldest→newest of the most recent runs, as a heat-less bar sparkline.
        const recent = runs.slice(0, 48).reverse();
        const peak = Math.max(1, ...lats);
        const spark = recent
          .map((r) => BARS[Math.min(7, Math.floor((r.maxNs / peak) * 7.99))])
          .join("");

        const out = [];
        out.push(
          <Text height="1" break="none">
            <Text bold fg={SUB}>{`${s.comm}/${s.pid}`}</Text>
            <Text fg={LABEL}>{s.tid && s.tid !== s.pid ? `  tid ${s.tid}` : ""}</Text>
            <Text fg={LABEL}>{"   ·   "}</Text>
            <Text bold fg={err ? ERR : OK}>{rcName(s.lastRc)}</Text>
            <Text fg={LABEL}>{s.isExec ? "   ·   sqlite3_exec" : ""}</Text>
          </Text>,
          blank(),
        );

        // ── error message (sqlite3_exec failures carry the real text) ──
        if (s.errmsg) {
          out.push(
            section("error"),
            <Text break="word" fg={ERR}>{s.errmsg}</Text>,
            blank(),
          );
        }

        // ── SQL, highlighted + wrapped, no ellipsis ──
        out.push(section("SQL"));
        for (const ln of (s.sql || "«unknown»").split("\n")) {
          out.push(
            <Text break="word" fg={VALUE}>
              {ln.length ? highlightLine(ln).map((t) => <Text fg={t.fg}>{t.text}</Text>) : " "}
            </Text>,
          );
        }
        out.push(blank());

        // ── bound parameters, in full ──
        if (s.params.length) {
          out.push(section(`parameters (${s.params.length})`));
          for (const p of s.params) {
            out.push(
              <Text height="1" break="none">
                <Text fg={PARAM}>{`?${p.idx}`.padEnd(6)}</Text>
                <Text fg={LABEL}>{`${p.type}`.padEnd(6)}</Text>
                <Text fg={VALUE}>{paramText(p)}</Text>
              </Text>,
            );
          }
          out.push(blank());
        }

        // ── this execution ──
        out.push(section("this execution"));
        if (s.isExec) {
          out.push(kv("latency", fmtDuration(s.maxNs), heat(latFrac(s.maxNs))));
        } else {
          out.push(
            kv("rows", `${s.rows}`),
            kv("steps", `${steps}`),
            kv("selectivity", steps ? `${s.rows}/${steps}  (${Math.round(sel * 100)}% of steps returned a row)` : "—"),
            kv("worst step", fmtDuration(s.maxNs), heat(latFrac(s.maxNs))),
            kv("avg step", fmtDuration(s.avgNs ?? 0)),
            kv("total", fmtDuration(s.totalNs ?? 0)),
          );
        }
        out.push(blank());

        // ── across every run of this SQL ──
        out.push(section(`across ${runs.length} run${runs.length === 1 ? "" : "s"} of this SQL`));
        out.push(
          kv("processes", procs.length ? procs.join(", ") : "—", SUB),
          kv("errors", `${errs}`, errs ? ERR : VALUE),
        );
        if (lats.length) {
          out.push(
            kv("p50 step", fmtDuration(pctl(lats, 0.5))),
            kv("p95 step", fmtDuration(pctl(lats, 0.95))),
            kv("p99 step", fmtDuration(pctl(lats, 0.99))),
            kv("max step", fmtDuration(pctl(lats, 1)), heat(latFrac(pctl(lats, 1)))),
            kv("recent", <Text fg={HEAD}>{spark || "—"}</Text>),
          );
        }

        out.push(blank(), <Text height="1" fg={RULE}>{"  esc  back"}</Text>);
        return out;
      }}
    </Box>
  );
}
