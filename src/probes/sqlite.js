// BPF data layer for sqlitefeed — the only BPF-aware module.
//
// It loads bin/sqlite.bpf.o, attaches the prepare/step/bind/exec uprobes to the
// system libsqlite3, and folds the raw event stream into an append-only log of
// completed executions. The UI reads two plain signals:
//   statements — array of finished executions { sql, params, rows, maxNs, rc, … },
//                newest first, each frozen once it lands (never mutates)
//   stats      — rolling totals + per-second rates for the title bar
//
// Run standalone to eyeball the raw events (needs the daemon; BPF load is
// privileged and handled by yeetd):
//   yeet run src/probes/sqlite.js
// then generate SQL, e.g.:  sqlite3 :memory: 'select 1+1'   /   python3 …
import { BpfObject, RingBuf } from "yeet:bpf";
import { from, signal } from "yeet:tui";

// ── constants shared with sqlite.bpf.c ──────────────────────────────────────
const EV = { PREPARE: 1, BIND: 2, STEP: 3, EXEC: 4, FINALIZE: 5 };
const BT = { NULL: 0, INT: 1, TEXT: 2, REAL: 3 };
// sqlite result codes we distinguish (see lib/format.js for names/colors).
const SQLITE_ROW = 100;
const SQLITE_DONE = 101;

const CAP = 2000; // most-recent statements retained (scrollback depth)
const WINDOW_MS = 250; // snapshot cadence — one re-render per window, not per event
const SQLITE_LIB = "libsqlite3.so.0"; // resolved via ld.so.cache by bare name

// exe path is relative to the *running module's* dir. Bundled (the default
// `yeet run`, entry src/index.jsx) that's src/ → ../bin. Standalone
// (`yeet run src/probes/sqlite.js`, import.meta.main true) it's src/probes/ →
// ../../bin. esbuild rewrites import.meta.main to false in the bundle, so this
// picks the right depth in both cases.
const OBJ = {
  exe: import.meta.main ? "../../bin/sqlite.bpf.o" : "../bin/sqlite.bpf.o",
  base: import.meta.dirname,
};

// Every (program name → attach spec) pair. prepare/step are entry+return
// pairs; the binds are entry-only. All target the same shared library.
// kind is always "uprobe"; entry vs. return is decided by the program's
// SEC() name ("uprobe" vs "uretprobe"), not the spec — so `up` and `ret`
// differ only in which program they target, not in the spec.
const up = (symbol) => ({ kind: "uprobe", binary: SQLITE_LIB, symbol });
const ret = up;
const ATTACH = [
  ["prepare_entry", up("sqlite3_prepare_v2")],
  ["prepare_return", ret("sqlite3_prepare_v2")],
  ["exec_entry", up("sqlite3_exec")],
  ["exec_return", ret("sqlite3_exec")],
  ["step_entry", up("sqlite3_step")],
  ["step_return", ret("sqlite3_step")],
  ["bind_int", up("sqlite3_bind_int")],
  ["bind_int64", up("sqlite3_bind_int64")],
  ["bind_text", up("sqlite3_bind_text")],
  ["bind_null", up("sqlite3_bind_null")],
  ["bind_double", up("sqlite3_bind_double")],
  ["finalize_entry", up("sqlite3_finalize")],
];

const load = () => {
  let o = new BpfObject(OBJ).bind("sql_events", { kind: "ringbuf", btf_struct: "sqlite_event" });
  for (const [prog, spec] of ATTACH) o = o.attach(prog, spec);
  return o.start();
};

// Decode a NUL-terminated char[] (or already-a-string) to JS text. No
// TextDecoder in bare V8 — hand-roll it, stopping at the first NUL.
const cstr = (v) => {
  if (typeof v === "string") return v.replace(/\0.*$/s, "");
  if (!v) return "";
  let s = "";
  for (const b of v) {
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
};

const unwrap = (w) => w?.sqlite_event ?? w; // ring-buffer events wrap the struct

// A bound value as a plain, display-ready object.
const bindValue = (e) => {
  switch (e.btype) {
    case BT.INT: return { type: "int", text: `${e.ival}` };
    case BT.TEXT: return { type: "text", text: cstr(e.text) };
    case BT.REAL: return { type: "real", text: "?real" }; // value in xmm0, uncapturable
    default: return { type: "null", text: "NULL" };
  }
};

export const stats = signal({ tracked: 0, prepareRate: 0, stepRate: 0, rowRate: 0 });

// Surfaced in the title bar so a failed attach (no daemon, missing lib) shows
// as a status line instead of an exception painted over the UI (CLAUDE.md
// crash-handling boundary 1).
export const status = signal("starting…");

// The reactive model is an append-only LOG of completed executions, not a
// mutable per-statement aggregate. A statement is one row per EXECUTION: it's
// assembled in-flight (prepare → bind* → step*), then FROZEN into the log the
// moment it finishes and never touched again — so a row already on screen never
// changes or jumps. New executions unshift at the top.
export const statements = from((state) => {
  const log = []; // completed executions, newest first — immutable once pushed
  let logId = 0; // monotonic row id
  let total = 0; // cumulative executions seen (title-bar counter)
  const cur = new Map(); // stmtId → the execution currently being assembled
  const sqlByStmt = new Map(); // stmtId → last known SQL (survives cached reuse)
  let dirty = false; // did the log change since the last publish?
  const win = { prepares: 0, steps: 0, rows: 0 }; // reset each window

  const newExec = (sql, comm, pid, tid) => ({
    sql: sql ?? "",
    comm,
    pid,
    tid,
    errmsg: "", // EXEC on failure: sqlite3_exec's error string
    isExec: false,
    params: new Map(), // idx → value
    rows: 0, // steps that returned a row
    steps: 0, // sqlite3_step() calls
    lastRc: 0,
    totalNs: 0,
    maxNs: 0,
  });

  // Freeze an in-flight execution into an immutable log row.
  const finalize = (e) => {
    // If it stepped but we never saw a terminal code (it was superseded by a
    // reset+rerun of a cached statement), it did complete — infer DONE rather
    // than showing the initial OK.
    const rc = e.lastRc === 0 && e.steps > 0 ? SQLITE_DONE : e.lastRc;
    log.unshift({
      id: ++logId,
      isExec: e.isExec,
      sql: e.sql,
      comm: e.comm,
      pid: e.pid,
      tid: e.tid,
      errmsg: e.errmsg,
      params: [...e.params.entries()].sort((a, b) => a[0] - b[0]).map(([idx, v]) => ({ idx, ...v })),
      rows: e.rows,
      steps: e.steps,
      lastRc: rc,
      maxNs: e.maxNs,
      totalNs: e.totalNs,
      avgNs: e.steps ? e.totalNs / e.steps : 0,
    });
    if (log.length > CAP) log.length = CAP; // bound scrollback
    total++;
    dirty = true;
  };

  // Begin a new execution for a stmt, flushing any lingering one first (e.g. a
  // SELECT reset mid-fetch and re-run). Reuses the last known SQL for cached
  // statements that don't re-prepare.
  const startExec = (stmtId, comm, pid, tid) => {
    const prev = cur.get(stmtId);
    if (prev && (prev.steps > 0 || prev.params.size > 0)) finalize(prev);
    const e = newExec(sqlByStmt.get(stmtId), comm, pid, tid);
    cur.set(stmtId, e);
    return e;
  };

  const ctl = load();
  const sub = ctl
    .then((c) => {
      status.set("tracing");
      return new RingBuf(c, "sql_events").subscribe((w) => {
        const ev = unwrap(w);
        const stmtId = `${ev.stmt}`; // BigInt → string key
        const comm = cstr(ev.comm);
        const pid = ev.pid;
        const tid = ev.tid;

        // sqlite3_exec: one self-contained execution, complete on arrival.
        if (ev.kind === EV.EXEC) {
          const e = newExec(cstr(ev.text), comm, pid, tid);
          e.isExec = true;
          e.lastRc = ev.rc;
          e.maxNs = Number(ev.latency_ns);
          e.errmsg = cstr(ev.errmsg);
          finalize(e);
          win.prepares++;
          return;
        }

        // prepare (real or recovered): remember the SQL for this pointer and
        // start a fresh execution. A failed compile never steps → emit it now.
        if (ev.kind === EV.PREPARE) {
          const sql = cstr(ev.text);
          sqlByStmt.set(stmtId, sql);
          const prev = cur.get(stmtId);
          if (prev && (prev.steps > 0 || prev.params.size > 0)) finalize(prev);
          if (ev.rc !== 0) {
            const e = newExec(sql, comm, pid, tid);
            e.lastRc = ev.rc;
            finalize(e);
            cur.delete(stmtId);
          } else {
            cur.set(stmtId, newExec(sql, comm, pid, tid));
          }
          win.prepares++;
          return;
        }

        // The stmt pointer is dead — the allocator will hand it to a future
        // statement, so forget everything tied to it. A lingering execution
        // that did real work is complete by definition (nothing can step a
        // finalized stmt); flush it rather than drop it.
        if (ev.kind === EV.FINALIZE) {
          const e = cur.get(stmtId);
          if (e && (e.steps > 0 || e.params.size > 0)) finalize(e);
          cur.delete(stmtId);
          sqlByStmt.delete(stmtId);
          return;
        }

        if (ev.kind === EV.BIND) {
          // A bind after the previous execution already stepped is a
          // reset+rebind — a new execution of a cached statement.
          let e = cur.get(stmtId);
          if (!e || e.steps > 0) e = startExec(stmtId, comm, pid, tid);
          e.comm = comm;
          e.pid = pid;
          e.tid = tid;
          e.params.set(ev.param_idx, bindValue(ev));
          return;
        }

        if (ev.kind === EV.STEP) {
          let e = cur.get(stmtId);
          if (!e) e = startExec(stmtId, comm, pid, tid);
          e.comm = comm;
          e.pid = pid;
          e.tid = tid;
          const ns = Number(ev.latency_ns);
          e.steps++;
          e.totalNs += ns;
          if (ns > e.maxNs) e.maxNs = ns;
          win.steps++;
          if (ev.rc === SQLITE_ROW) {
            e.rows++;
            win.rows++;
          } else {
            // DONE or error → the execution is complete; freeze it.
            e.lastRc = ev.rc;
            finalize(e);
            cur.delete(stmtId);
          }
          return;
        }
      });
    })
    .catch((e) => status.set(`probe failed: ${e?.message ?? e}`));

  const secs = WINDOW_MS / 1000;
  const publish = () => {
    if (dirty) {
      state.set(log.slice(0, CAP)); // immutable rows, newest first
      dirty = false;
    }
    stats.set({
      tracked: total,
      prepareRate: win.prepares / secs,
      stepRate: win.steps / secs,
      rowRate: win.rows / secs,
    });
    win.prepares = win.steps = win.rows = 0;
  };
  const h = setInterval(publish, WINDOW_MS);

  return () => {
    clearInterval(h);
    sub.then((s) => s.unsubscribe());
  };
}, []);

// Standalone correctness probe: dump raw events so field names/types are
// verifiable before any UI exists (CLAUDE.md "get the data right first").
if (import.meta.main) {
  const ctl = await load();
  const rb = new RingBuf(ctl, "sql_events");
  const kindName = { 1: "PREPARE", 2: "BIND", 3: "STEP", 4: "EXEC", 5: "FINALIZE" };
  console.log(`[sqlite] attached ${ATTACH.length} probes on ${SQLITE_LIB} — waiting…`);
  rb.subscribe((w) => {
    const e = unwrap(w);
    const head = `[${kindName[e.kind]}] ${cstr(e.comm)}/${e.pid} stmt=0x${e.stmt.toString(16)}`;
    if (e.kind === EV.PREPARE) console.log(`${head} rc=${e.rc} sql=${JSON.stringify(cstr(e.text))}`);
    else if (e.kind === EV.EXEC) console.log(`${head} rc=${e.rc} latency=${Number(e.latency_ns)}ns sql=${JSON.stringify(cstr(e.text))}${e.rc ? ` err=${JSON.stringify(cstr(e.errmsg))}` : ""}`);
    else if (e.kind === EV.BIND) console.log(`${head} bind #${e.param_idx} = ${JSON.stringify(bindValue(e).text)}`);
    else if (e.kind === EV.FINALIZE) console.log(head);
    else console.log(`${head} rc=${e.rc} latency=${Number(e.latency_ns)}ns`);
  });
  await new Promise(() => {});
}
