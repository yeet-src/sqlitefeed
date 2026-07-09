#!/bin/sh
# Print the byte offset of Vdbe.zSql within a sqlite3_stmt, for a given
# libsqlite3, by reading it out of the machine code of sqlite3_sql() — which is
# just `return p ? ((Vdbe*)p)->zSql : 0` and compiles to a single
# `mov OFFSET(%rdi),%rax`. This lets the probe recover the SQL of statements it
# never saw prepared (compiled before it attached, e.g. a cached statement in a
# long-running process) without needing DWARF or a version table.
#
# Prints a decimal offset, or 0 if it can't be determined (recovery disabled).
# x86-64 only for now; other arches print 0 and fall back to prepare-only.
set -eu

SO="${1:-}"
if [ -z "$SO" ]; then
  SO=$(ldconfig -p 2>/dev/null | awk '/libsqlite3\.so/{print $NF; exit}' || true)
fi
if [ -z "${SO:-}" ] || [ ! -r "${SO:-}" ]; then
  for c in /lib/x86_64-linux-gnu/libsqlite3.so.0 /usr/lib/x86_64-linux-gnu/libsqlite3.so.0 \
           /usr/lib/libsqlite3.so.0 /lib/libsqlite3.so.0 /usr/lib64/libsqlite3.so.0; do
    [ -r "$c" ] && { SO="$c"; break; }
  done
fi
[ -n "${SO:-}" ] && [ -r "$SO" ] || { echo 0; exit 0; }
command -v objdump >/dev/null 2>&1 || { echo 0; exit 0; }
command -v nm >/dev/null 2>&1 || { echo 0; exit 0; }
[ "$(uname -m)" = "x86_64" ] || { echo 0; exit 0; }

addr=$(nm -D "$SO" 2>/dev/null | awk '$3=="sqlite3_sql"{print $1; exit}' || true)
[ -n "${addr:-}" ] || { echo 0; exit 0; }

start="0x$addr"
stop=$(printf '0x%x' $(( 0x$addr + 0x40 )))   # the function is tiny
off=$(objdump -d --start-address="$start" --stop-address="$stop" "$SO" 2>/dev/null \
      | grep -oE 'mov[[:space:]]+0x[0-9a-f]+\(%rdi\),%rax' \
      | head -1 | grep -oE '0x[0-9a-f]+' | head -1 || true)
[ -n "${off:-}" ] || { echo 0; exit 0; }

printf '%d\n' "$off"
