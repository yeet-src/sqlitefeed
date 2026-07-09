// sqlite — uprobe/uretprobe instrumentation of libsqlite3's public API, the
// point where an application drives the engine. It captures, tied together by
// the sqlite3_stmt* pointer (a per-statement id):
//
//   prepare_v2  — the SQL text of each compiled statement (+ its stmt ptr)
//   bind_*      — the concrete values substituted for '?' placeholders
//   step        — per-call latency and result code (ROW / DONE / error)
//   exec        — one-shot statements (SQL + total latency + result code)
//
// A generic SEC("uprobe")/SEC("uretprobe") carries no target; probes/sqlite.js
// binds each program to a concrete binary+symbol at attach() time.
//
// prepare/step/exec need entry↔return pairing: prepare's stmt pointer is an
// *out* param (*ppStmt), only known on return; step/exec latency needs both
// ends. We pair them through a single per-thread scratch slot keyed by
// pid_tgid: the entry stashes the args, the return reads and clears them.
//
// This is deliberately a single slot, not a nesting stack. SQLite does make
// nested calls on one thread (e.g. reparsing sqlite_master mid-DDL), and a
// slot gets clobbered by the inner call so the outer statement is missed —
// shown as «unknown» when later stepped. That is the accepted failure mode: it
// SELF-CORRECTS on the next top-level call. A depth-counting stack looks more
// correct but is worse in practice — uretprobes silently drop returns past the
// kernel's maxactive limit under rapid/nested calls, so pushes outnumber pops,
// the depth drifts, and every subsequent statement reads a stale frame. A
// missed pairing here costs one statement; there it corrupts all of them.
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

// Own loadable object → own license (covers any GPL-only helpers).
char LICENSE[] SEC("license") = "Dual BSD/GPL";

#define TASK_COMM_LEN 16
#define MAX_TEXT 512 // SQL text / bound text value, bounded & NUL-terminated
//                      (carried on every event — see the note on step volume)
#define MAX_ERR 256 // sqlite3_exec()'s error message, on failure

// Byte offset of Vdbe.zSql within a sqlite3_stmt, baked in from the target
// libsqlite3 at build time (build/find-zsql-offset.sh). Lets us recover the SQL
// of statements we never saw prepared — the common case for a long-running
// process that compiled and cached its statements before we attached. 0
// disables recovery (we fall back to showing «unknown»).
#ifndef ZSQL_OFFSET
#define ZSQL_OFFSET 0
#endif

enum ev_kind {
	EV_PREPARE = 1,
	EV_BIND = 2,
	EV_STEP = 3,
	EV_EXEC = 4, // sqlite3_exec() one-shot: SQL + total latency + result code
};

// Bound-value type. REAL is captured as a *type only*: doubles arrive in an
// SSE register (xmm0), which isn't part of pt_regs, so the value is unreadable
// from a uprobe — we record that a real was bound, not what it was.
enum bind_type {
	BT_NULL = 0,
	BT_INT = 1,
	BT_TEXT = 2,
	BT_REAL = 3,
};

struct sqlite_event {
	__u8 kind;
	__u8 btype; // EV_BIND: which bind_type
	__u32 pid;
	__u32 tid;
	__s32 param_idx; // EV_BIND: 1-based '?' index
	__s32 rc; // result code (STEP/PREPARE/EXEC)
	__u64 stmt; // sqlite3_stmt* — the id that ties prepare/bind/step together
	__u64 latency_ns; // STEP/EXEC: time spent inside the call
	__s64 ival; // EV_BIND (BT_INT): the integer value
	char comm[TASK_COMM_LEN];
	char text[MAX_TEXT]; // PREPARE/EXEC: SQL; EV_BIND (BT_TEXT): the string value
	char errmsg[MAX_ERR]; // EV_EXEC on failure: sqlite3_exec()'s out-param message
};

// Force BTF emission so the daemon resolves btf_struct: "sqlite_event".
struct sqlite_event *_unused_sqlite_event __attribute__((unused));

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 512 * 1024);
} sql_events SEC(".maps");

// Statements we've already emitted SQL for — either because we saw their
// prepare, or because we recovered it. Steps/binds on a stmt NOT in here are
// candidates for zSql recovery. LRU so it self-bounds over a long session.
struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 65536);
	__type(key, __u64); // sqlite3_stmt*
	__type(value, __u8);
} known SEC(".maps");

// prepare args stashed at entry, consumed at return (one slot per thread).
struct prepare_args {
	__u64 zSql; // const char*  — the SQL text
	__u64 ppStmt; // sqlite3_stmt** — out-param holding the new stmt on success
};
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 8192);
	__type(key, __u64); // pid_tgid
	__type(value, struct prepare_args);
} prepare_scratch SEC(".maps");

// step start timestamp + stmt, stashed at entry (one slot per thread).
struct step_args {
	__u64 ts;
	__u64 stmt;
};
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 8192);
	__type(key, __u64);
	__type(value, struct step_args);
} step_scratch SEC(".maps");

// sqlite3_exec: SQL text pointer, errmsg out-param, start timestamp (per thread).
struct exec_args {
	__u64 zSql;
	__u64 errmsg; // char** — *errmsg holds the allocated message on failure
	__u64 ts;
};
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 8192);
	__type(key, __u64);
	__type(value, struct exec_args);
} exec_scratch SEC(".maps");

static __always_inline void fill_ids(struct sqlite_event *e)
{
	__u64 id = bpf_get_current_pid_tgid();
	e->pid = id >> 32;
	e->tid = (__u32)id;
	bpf_get_current_comm(&e->comm, sizeof(e->comm));
}

// Reserve a zeroed event of the given kind. Returns NULL if the ring is full.
static __always_inline struct sqlite_event *new_event(__u8 kind)
{
	struct sqlite_event *e = bpf_ringbuf_reserve(&sql_events, sizeof(*e), 0);
	if (!e) {
		return NULL; // ring full — dropping is the backpressure
	}
	e->kind = kind;
	e->btype = 0;
	e->param_idx = 0;
	e->rc = 0;
	e->stmt = 0;
	e->latency_ns = 0;
	e->ival = 0;
	e->text[0] = '\0';
	e->errmsg[0] = '\0';
	fill_ids(e);
	return e;
}

// Recover the SQL of a statement we never saw prepared, by reading Vdbe.zSql
// (the field sqlite3_sql() returns) directly out of the stmt struct. Emits a
// synthetic PREPARE once per stmt, so downstream correlation is identical to a
// real prepare. No-op when recovery is disabled or the stmt is already known.
static __always_inline void maybe_recover(void *stmt)
{
#if ZSQL_OFFSET
	if (!stmt) {
		return;
	}
	__u64 key = (__u64)stmt;
	if (bpf_map_lookup_elem(&known, &key)) {
		return; // already prepared or recovered
	}
	__u8 one = 1;
	bpf_map_update_elem(&known, &key, &one, BPF_ANY); // mark first → recover once

	__u64 zsql = 0;
	bpf_probe_read_user(&zsql, sizeof(zsql), (void *)(key + ZSQL_OFFSET));
	if (!zsql) {
		return;
	}
	struct sqlite_event *e = new_event(EV_PREPARE);
	if (!e) {
		return;
	}
	e->stmt = key;
	e->rc = 0;
	long n = bpf_probe_read_user_str(&e->text, sizeof(e->text), (void *)zsql);
	if (n <= 1) {
		bpf_ringbuf_discard(e, 0); // unreadable/empty — don't emit a blank
		return;
	}
	bpf_ringbuf_submit(e, 0);
#endif
}

// ── prepare_v2(db, zSql, nByte, ppStmt, pzTail) ──────────────────────────────
SEC("uprobe")
int BPF_UPROBE(prepare_entry, void *db, const char *zSql, int nByte, void *ppStmt)
{
	__u64 id = bpf_get_current_pid_tgid();
	struct prepare_args a = { .zSql = (__u64)zSql, .ppStmt = (__u64)ppStmt };
	bpf_map_update_elem(&prepare_scratch, &id, &a, BPF_ANY);
	return 0;
}

SEC("uretprobe")
int BPF_URETPROBE(prepare_return, int rc)
{
	__u64 id = bpf_get_current_pid_tgid();
	struct prepare_args *a = bpf_map_lookup_elem(&prepare_scratch, &id);
	if (!a) {
		return 0;
	}
	__u64 zSql = a->zSql;
	__u64 ppStmt = a->ppStmt;
	bpf_map_delete_elem(&prepare_scratch, &id);

	// On success the new statement handle is written into *ppStmt.
	__u64 stmt = 0;
	if (rc == 0 /* SQLITE_OK */ && ppStmt) {
		bpf_probe_read_user(&stmt, sizeof(stmt), (void *)ppStmt);
	}
	if (stmt) {
		__u8 one = 1;
		bpf_map_update_elem(&known, &stmt, &one, BPF_ANY); // don't recover what we prepared
	}

	struct sqlite_event *e = new_event(EV_PREPARE);
	if (e) {
		e->rc = rc;
		e->stmt = stmt;
		if (zSql) {
			bpf_probe_read_user_str(&e->text, sizeof(e->text), (void *)zSql);
		}
		bpf_ringbuf_submit(e, 0);
	}
	return 0;
}

// ── step(stmt) ───────────────────────────────────────────────────────────────
SEC("uprobe")
int BPF_UPROBE(step_entry, void *stmt)
{
	maybe_recover(stmt); // pick up statements prepared before we attached
	__u64 id = bpf_get_current_pid_tgid();
	struct step_args a = { .ts = bpf_ktime_get_ns(), .stmt = (__u64)stmt };
	bpf_map_update_elem(&step_scratch, &id, &a, BPF_ANY);
	return 0;
}

SEC("uretprobe")
int BPF_URETPROBE(step_return, int rc)
{
	__u64 id = bpf_get_current_pid_tgid();
	struct step_args *a = bpf_map_lookup_elem(&step_scratch, &id);
	if (!a) {
		return 0;
	}
	__u64 dur = bpf_ktime_get_ns() - a->ts;
	__u64 stmt = a->stmt;
	bpf_map_delete_elem(&step_scratch, &id);

	struct sqlite_event *e = new_event(EV_STEP);
	if (e) {
		e->rc = rc;
		e->stmt = stmt;
		e->latency_ns = dur;
		bpf_ringbuf_submit(e, 0);
	}
	return 0;
}

// ── exec(db, sql, callback, arg, errmsg) ─────────────────────────────────────
// errmsg (5th arg) is an out-param: on failure sqlite3_exec writes an allocated
// error string's pointer into *errmsg. We stash the char** here and dereference
// it on return, once it's populated.
SEC("uprobe")
int BPF_UPROBE(exec_entry, void *db, const char *sql, void *cb, void *arg, char **errmsg)
{
	__u64 id = bpf_get_current_pid_tgid();
	struct exec_args a = { .zSql = (__u64)sql, .errmsg = (__u64)errmsg, .ts = bpf_ktime_get_ns() };
	bpf_map_update_elem(&exec_scratch, &id, &a, BPF_ANY);
	return 0;
}

SEC("uretprobe")
int BPF_URETPROBE(exec_return, int rc)
{
	__u64 id = bpf_get_current_pid_tgid();
	struct exec_args *a = bpf_map_lookup_elem(&exec_scratch, &id);
	if (!a) {
		return 0;
	}
	__u64 dur = bpf_ktime_get_ns() - a->ts;
	__u64 zSql = a->zSql;
	__u64 errmsg_pp = a->errmsg;
	bpf_map_delete_elem(&exec_scratch, &id);

	struct sqlite_event *e = new_event(EV_EXEC);
	if (e) {
		e->rc = rc;
		e->latency_ns = dur;
		if (zSql) {
			bpf_probe_read_user_str(&e->text, sizeof(e->text), (void *)zSql);
		}
		// On failure, dereference the char** out-param and copy the message.
		if (rc != 0 && errmsg_pp) {
			__u64 msg = 0;
			bpf_probe_read_user(&msg, sizeof(msg), (void *)errmsg_pp);
			if (msg) {
				bpf_probe_read_user_str(&e->errmsg, sizeof(e->errmsg), (void *)msg);
			}
		}
		bpf_ringbuf_submit(e, 0);
	}
	return 0;
}

// ── bind_*(stmt, idx, value, …) — entry-only, no pairing needed ───────────────
static __always_inline void emit_bind(void *stmt, int idx, enum bind_type bt,
				       __s64 ival, const char *text)
{
	maybe_recover(stmt); // a bind may be the first we see of a cached statement
	struct sqlite_event *e = new_event(EV_BIND);
	if (!e) {
		return;
	}
	e->btype = bt;
	e->param_idx = idx;
	e->stmt = (__u64)stmt;
	e->ival = ival;
	if (bt == BT_TEXT && text) {
		bpf_probe_read_user_str(&e->text, sizeof(e->text), text);
	}
	bpf_ringbuf_submit(e, 0);
}

SEC("uprobe")
int BPF_UPROBE(bind_int, void *stmt, int idx, int value)
{
	emit_bind(stmt, idx, BT_INT, value, NULL);
	return 0;
}

SEC("uprobe")
int BPF_UPROBE(bind_int64, void *stmt, int idx, long long value)
{
	emit_bind(stmt, idx, BT_INT, value, NULL);
	return 0;
}

SEC("uprobe")
int BPF_UPROBE(bind_text, void *stmt, int idx, const char *value)
{
	emit_bind(stmt, idx, BT_TEXT, 0, value);
	return 0;
}

SEC("uprobe")
int BPF_UPROBE(bind_null, void *stmt, int idx)
{
	emit_bind(stmt, idx, BT_NULL, 0, NULL);
	return 0;
}

// double value is in xmm0 (not in pt_regs) — record the type, not the value.
SEC("uprobe")
int BPF_UPROBE(bind_double, void *stmt, int idx)
{
	emit_bind(stmt, idx, BT_REAL, 0, NULL);
	return 0;
}
