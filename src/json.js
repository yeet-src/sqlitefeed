/* Headless mode: every completed, correlated execution as one JSON line on
 * stdout — the same records the dashboard renders, machine-readable.
 *
 *   yeet run -T . | jq 'select(.rc != 101)'
 *
 * Status and attach errors go to stderr so stdout stays pure JSON lines.
 */
import { attachStatements } from "./probes/sqlite.js";

export function startJson() {
  attachStatements({
    onStatus: (t) => console.error(`[sqlitefeed] ${t}`),
    onStatement: (s) => {
      const rec = {
        process: s.comm,
        pid: s.pid,
        tid: s.tid,
        sql: s.sql,
        params: s.params.map((p) => ({ idx: p.idx, type: p.type, value: p.text })),
        rows: s.rows,
        steps: s.steps,
        rc: s.lastRc,
        total_ns: Number(s.totalNs),
        max_ns: Number(s.maxNs),
      };
      if (s.errmsg) rec.error = s.errmsg;
      console.log(JSON.stringify(rec));
    },
  });
}
