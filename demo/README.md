# demo — traffic for the sqlitefeed TUI

Generators that drive `libsqlite3` so the dashboard has something to show.

```sh
# terminal 1 — the dashboard
yeet run .

# terminal 2 — spawn traffic
demo/run.sh                     # python workload + a trickle of sqlite3-CLI queries
# or just the python workload:
python3 demo/traffic.py         # loop; Ctrl-C to stop
python3 demo/traffic.py --once  # a single round
python3 demo/traffic.py --interval 0.3 --db /tmp/mydemo.db
```

## What it exercises

| Traffic | Lights up |
|---|---|
| `executescript(SCHEMA)` (DDL) | the `sqlite3_exec` path — shown as `exec` |
| `INSERT … VALUES (?,?,?,?)` | `prepare` + `bind` (int / text / NULL / **REAL** → `«real»`) + `step` |
| multi-line `SELECT …` | multi-line statement rendering |
| a slow self-join | a slow query → latency heat |
| six distinct failing queries | red result rows — missing table, syntax error, unknown column (`ERROR`); duplicate `UNIQUE` and missing `NOT NULL` (`CONSTRAINT`); text into an INTEGER PK (`MISMATCH`) |
| `demo/run.sh` CLI reader | a second process (`sqlite3`) alongside `python3` |

Both drivers use the system `libsqlite3.so.0`, which is what the probe attaches
to. The database is a temp file (`/tmp/sqlitefeed_demo.db` by default) in
WAL mode; delete it anytime to start fresh.
