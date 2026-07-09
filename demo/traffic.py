#!/usr/bin/env python3
"""Traffic generator for the sqlitefeed TUI — one query at a time.

Each tick runs a SINGLE statement, cycling through a mix so every part of the
dashboard shows up as its own immutable row:

  • parameterized INSERT / SELECT / UPDATE / DELETE  (prepare + bind + step)
  • a multi-line SELECT                              (multi-line rendering)
  • a slow self-join                                 (latency heat)
  • six distinct failing queries                     (ERROR / CONSTRAINT / MISMATCH):
      missing table · syntax error · unknown column · UNIQUE · NOT NULL · datatype mismatch

Autocommit is on (isolation_level=None) so there's no implicit BEGIN/COMMIT
wrapping — what you type is what runs, one statement per tick.

    python3 demo/traffic.py                 # one statement every 0.8s
    python3 demo/traffic.py --interval 0.3
    python3 demo/traffic.py --once          # a single statement, then exit
"""
import argparse
import os
import random
import sqlite3
import string
import tempfile
import time

SCHEMA = """
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL UNIQUE,
    email      TEXT NOT NULL UNIQUE,
    age        INTEGER,
    score      REAL,
    is_active  BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    kind    TEXT,
    payload TEXT
);
"""

NAMES = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi", "ivan", "judy"]
KINDS = ["login", "click", "logout", "purchase", "view"]

rand_name = lambda: random.choice(NAMES) + str(random.randint(1, 9999))
rand_payload = lambda: "".join(random.choices(string.ascii_letters + string.digits, k=12))


def _fail(cur, sql, params=()):
    """Run a statement that is MEANT to fail — the error is the point; it shows
    in the feed as a red result-code row. Swallow the exception so the demo
    keeps ticking."""
    try:
        cur.execute(sql, params)
    except sqlite3.Error:
        pass


# ── normal statements: exercise prepare/bind/step and the metrics columns ──
def _insert_user(cur):
    name = rand_name()
    cur.execute(
        "INSERT OR IGNORE INTO users (username, email, age, score) VALUES (?, ?, ?, ?)",
        (name, f"{name}@example.com", random.choice([None, random.randint(18, 80)]), round(random.uniform(0, 10), 2)),
    )

def _insert_event(cur):
    cur.execute(
        "INSERT INTO events (user_id, kind, payload) VALUES (?, ?, ?)",
        (random.randint(1, 50), random.choice(KINDS), rand_payload()),
    )

def _select_top(cur):  # multi-line SELECT → multi-line rendering
    cur.execute(
        "SELECT id, username, score\n"
        "  FROM users\n"
        " WHERE score > ?\n"
        " ORDER BY score DESC\n"
        " LIMIT ?",
        (random.uniform(0, 8), 5),
    ).fetchall()

def _select_by_name(cur):
    cur.execute("SELECT * FROM users WHERE username = ?", (rand_name(),)).fetchall()

def _update(cur):
    cur.execute("UPDATE users SET score = score + ? WHERE id = ?", (round(random.uniform(-1, 1), 2), random.randint(1, 60)))

def _self_join(cur):  # slow query → latency heat
    cur.execute("SELECT count(*) FROM users a, users b WHERE a.score < b.score").fetchone()

def _delete(cur):
    cur.execute("DELETE FROM events WHERE id = ?", (random.randint(1, 500),))

# ── failing statements: each a DISTINCT SQLite error, for variety in the feed ──
def _err_missing_table(cur):  # no such table                 → ERROR
    _fail(cur, "SELECT * FROM no_such_table WHERE oops = ?", (1,))

def _err_syntax(cur):  # malformed SQL                         → ERROR (syntax)
    _fail(cur, "SELCT * FRM users WHER id = 1")

def _err_no_column(cur):  # unknown column                     → ERROR
    _fail(cur, "SELECT id, bogus_col FROM users ORDER BY bogus_col")

def _err_unique(cur):  # duplicate UNIQUE key (dupe_me seeded) → CONSTRAINT / UNIQUE
    _fail(cur, "INSERT INTO users (username, email) VALUES ('dupe_me', 'dupe_me@example.com')")

def _err_not_null(cur):  # omit a NOT NULL column              → CONSTRAINT / NOTNULL
    _fail(cur, "INSERT INTO users (email) VALUES ('nameless@example.com')")

def _err_mismatch(cur):  # text into INTEGER PRIMARY KEY       → MISMATCH
    _fail(cur, "INSERT INTO users (id, username, email) VALUES ('not-an-int', ?, ?)", (rand_name(), "x@example.com"))

# Round-robin order, failures interleaved so the feed reads like real traffic
# with occasional errors rather than a wall of red.
ACTIONS = [
    _insert_user, _insert_event, _err_missing_table,
    _select_top, _select_by_name, _err_syntax,
    _update, _self_join, _err_unique,
    _insert_event, _delete, _err_no_column,
    _insert_user, _select_by_name, _err_not_null,
    _update, _self_join, _err_mismatch,
]


def run_one(conn, i):
    """Run exactly one statement, chosen round-robin by the tick counter."""
    ACTIONS[i % len(ACTIONS)](conn.cursor())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=None, help="database path (default: a temp file)")
    ap.add_argument("--interval", type=float, default=0.8, help="seconds between statements")
    ap.add_argument("--once", action="store_true", help="run a single statement, then exit")
    args = ap.parse_args()

    path = args.db or os.path.join(tempfile.gettempdir(), "sqlitefeed_demo.db")
    print(f"[demo] one statement every {args.interval}s at {path}  (Ctrl-C to stop)")

    conn = sqlite3.connect(path, isolation_level=None)  # autocommit: no implicit BEGIN/COMMIT
    conn.executescript(SCHEMA)
    # seed a few rows so SELECTs return something, plus the row we re-insert to
    # trigger the UNIQUE-constraint error.
    for _ in range(8):
        n = rand_name()
        conn.execute("INSERT OR IGNORE INTO users (username, email, age, score) VALUES (?, ?, ?, ?)",
                     (n, f"{n}@example.com", random.randint(18, 80), round(random.uniform(0, 10), 2)))
    conn.execute("INSERT OR IGNORE INTO users (username, email) VALUES ('dupe_me', 'dupe_me@example.com')")

    i = 0
    try:
        while True:
            run_one(conn, i)
            i += 1
            if args.once:
                break
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n[demo] done")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
