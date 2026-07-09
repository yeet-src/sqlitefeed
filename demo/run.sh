#!/usr/bin/env bash
# Spawn varied SQLite traffic for the sqlitefeed TUI.
#
#   terminal 1:  yeet run .        # the dashboard
#   terminal 2:  demo/run.sh       # this — generates traffic
#
# Runs the Python workload in the foreground and, in the background, a trickle
# of sqlite3-CLI queries against the same database — so the dashboard's process
# column shows both "python3" and "sqlite3".
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
DB="${1:-/tmp/sqlitefeed_demo.db}"

echo "[demo] traffic → $DB   (Ctrl-C to stop)"

# Background CLI reader for process-name variety. Errors (e.g. before the
# schema exists, or a brief lock) are hidden here but still show in the TUI.
(
  while true; do
    sqlite3 "$DB" "SELECT count(*) AS users FROM users;" >/dev/null 2>&1
    sqlite3 "$DB" "SELECT username, score FROM users ORDER BY score DESC LIMIT 3;" >/dev/null 2>&1
    sleep 1.3
  done
) &
CLI_PID=$!
trap 'kill "$CLI_PID" 2>/dev/null' EXIT INT TERM

exec python3 "$DIR/traffic.py" --db "$DB"
