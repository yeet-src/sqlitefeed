# `sqlitefeed`

> **`tail -f` for SQLite.** Every statement any process on the box runs against `libsqlite3` — the SQL (syntax-highlighted), the values bound to its `?` placeholders, the per-step latency and result code — decoded and streamed live to your terminal. No cooperation from the traced apps, no recompile, no `PRAGMA`.

<p align="center">
  <img src="https://img.shields.io/badge/platform-Linux-1793D1" alt="Linux">
  <img src="https://img.shields.io/badge/built%20with-yeet%20%2B%20eBPF-8A2BE2" alt="yeet + eBPF">
  <img src="https://img.shields.io/badge/license-Dual%20BSD%2FGPL-3DA639" alt="Dual BSD/GPL">
  <a href="https://discord.gg/dYZu9PjKB"><img src="https://img.shields.io/badge/chat-Discord-5865F2" alt="Discord"></a>
</p>

<p align="center">
  <img src="assets/sqlitefeed.gif" alt="sqlitefeed streaming live SQLite statements in the terminal">
</p>

**`sqlitefeed` uprobes the public `libsqlite3` API — `prepare` / `bind` / `step` / `exec` — and turns it into a live, newest-first feed of prepared statements: the SQL, the concrete bound values, rows returned, worst step latency (heat-colored), and the result code — for every process using the shared library at once.**

Because it attaches to the *library*, not to any one app, a single run watches every SQLite-backed process on the host — your app, a background job, and a `sqlite3` shell — with none of them aware they're being traced.

> [!TIP]
> **You can't just add logging.** Query logging lives inside one application, compiled in or configured per-process; it can't see the job that starts tomorrow, and it certainly can't see a `sqlite3` one-liner. `sqlitefeed` hooks the shared library **in the kernel**, so it sees every caller uniformly — and it even recovers the SQL of statements that were prepared and cached *before* it attached, by reading `Vdbe.zSql` straight out of the statement struct (see [Recovering SQL it never saw prepared](#recovering-sql-it-never-saw-prepared)).

## Quick start

```sh
curl -fsSL https://yeet.cx | sh     # install the yeet daemon (one time)
make                                # build the BPF object + JS bundle
yeet run .                          # run the dashboard (the daemon does the privileged BPF load)
```
[Manual install guide](https://yeet.cx/docs/manual-installation) | Linux only

Nothing to configure — as soon as any process prepares or executes a statement, rows start landing at the top. No traffic handy? The bundled generators drive `libsqlite3` for you:

```sh
demo/run.sh              # a python workload + a trickle of sqlite3-CLI queries
python3 demo/traffic.py  # just the python workload (Ctrl-C to stop)
```

## Controls

The feed follows the newest statement by default; scroll or pause and it holds still while data keeps flowing underneath.

| key            | action                                                            |
| -------------- | ----------------------------------------------------------------- |
| `↑`/`↓`, `j`/`k` | scroll (auto-holds position when you leave the top)             |
| `PgUp`/`PgDn`  | scroll a page; mouse wheel also scrolls                           |
| `g`            | jump back to newest and resume following                         |
| `/`            | fuzzy filter — matches process, SQL, and bound values            |
| `p`            | pause / resume the feed                                           |
| `q` / `Esc`    | quit                                                              |

## JSON output (headless)

Pipe the feed into anything: when no terminal is allocated (output piped, or
forced with `yeet run -T`), sqlitefeed emits **one JSON object per completed
execution** on stdout instead of rendering the dashboard — the same
correlated records the TUI shows (SQL + bound values + rows + latency + rc),
machine-readable. Status lines go to stderr.

```sh
yeet run -T . | jq 'select(.rc != 101)'          # only the non-DONE outcomes
yeet run -T . | your-checker --stdin              # e.g. semantic linting of live SQL
```

```json
{"process":"python3","pid":34412,"tid":34412,"sql":"INSERT OR IGNORE INTO users (username, email, age, score) VALUES (?, ?, ?, ?)","params":[{"idx":1,"type":"text","value":"alice5866"},{"idx":2,"type":"text","value":"alice5866@example.com"},{"idx":3,"type":"int","value":"27"},{"idx":4,"type":"real","value":"?real"}],"rows":0,"steps":1,"rc":101,"total_ns":3100000,"max_ns":3100000}
```

## What you're looking at

```
 ● sqlite   ▏  1487 queries  ▏  12 steps/s  ▏  9 rows/s  ▏  tracing
python3/34412   SELECT id, username, score FROM users WHERE score > ? ORDER BY score DESC        3r    231µs      DONE
python3/34412   INSERT OR IGNORE INTO users (username, email, age, score) VALUES (?, ?, ?, ?)    0r    3.1ms      DONE
   ↳ ?1='alice5866'  ?2='alice5866@example.com'  ?3=27  ?4=«real»
sqlite3/34530   SELECT count(*) FROM users a, users b WHERE a.score < b.score                    0r     36ms      DONE
python3/34412   SELECT * FROM no_such_table WHERE oops = ?                                       0r        0     ERROR
```

Each statement is one block: the left gutter carries the **process/pid**, the SQL flexes in the middle (ellipsized if it's wide, one terminal row per source line if it's multi-line), and three right-pinned columns give **rows returned**, **worst step latency** (heat-colored, cool → hot), and the **result code**. A dim `↳` line lists the bound parameters when the statement has any.

Each row is frozen the moment its execution completes and never mutates again — so a burst scrolls past as a stable log, not a flickering aggregate.

**The SQL is syntax-highlighted** by a small tokenizer (`lib/sqlhl.js`), on the same 256-color palette as the rest of the UI:

| token | color |
|---|---|
| keyword | cornflower blue |
| identifier | near-white |
| string literal | green |
| number | gold |
| comment | dim grey |
| `?` / `:name` param | amber |
| punctuation | mid grey |

The result code is color-keyed: `OK` / `ROW` / `DONE` are the normal path (green); anything else — `ERROR`, `BUSY`, `CONSTRAINT`, `CORRUPT`, … — is an error, and the whole row goes red.

## Recovering SQL it never saw prepared

A long-running process prepares its statements once and reuses the cached handles for hours. Attach after that, and every `step` you see is for a statement whose `prepare` already happened — you'd have only the `sqlite3_stmt*` pointer and no SQL.

`sqlitefeed` recovers it. `sqlite3_sql(stmt)` is essentially `return ((Vdbe*)stmt)->zSql`, which compiles to a single `mov OFFSET(%rdi),%rax`. At build time, `build/find-zsql-offset.sh` disassembles that one function in the target `libsqlite3` and reads the offset out of the instruction, baking it in as `-DZSQL_OFFSET=…`. On the first `step` or `bind` of an unknown statement, the probe reads `Vdbe.zSql` at that offset and emits a synthetic `PREPARE` — so a cached statement lights up with its real SQL, correlated identically to one we watched compile.

The `known` LRU map gates this to once per statement. Recovery is x86-64 only; elsewhere (or if the library can't be found) the offset is `0`, recovery is disabled, and unseen statements show as `«unknown»` until they're re-prepared.

## How it works

The core is [`src/bpf/sqlite.bpf.c`](src/bpf/sqlite.bpf.c) (kernel) and [`src/probes/sqlite.js`](src/probes/sqlite.js) (userspace).

### The BPF side

A generic `SEC("uprobe")`/`SEC("uretprobe")` program carries no target; `probes/sqlite.js` binds each to a concrete `libsqlite3` symbol at `attach()` time. Everything is tied together by the `sqlite3_stmt*` pointer.

| Program | Attached to | What it captures |
|---|---|---|
| `prepare_entry`/`_return` | `sqlite3_prepare_v2` | the SQL text + the new `stmt` pointer (an out-param, known only on return) + compile `rc` |
| `step_entry`/`_return`    | `sqlite3_step`       | per-call latency and result code (`ROW`/`DONE`/error); entry also triggers `zSql` recovery |
| `exec_entry`/`_return`    | `sqlite3_exec`       | one-shot statements — SQL + total latency + `rc` |
| `bind_{int,int64,text,null,double}` | `sqlite3_bind_*` | the concrete value bound to each `?` (entry-only, no pairing) |

Five maps connect kernel to userspace:

- `sql_events` — `RINGBUF`, one decoded `sqlite_event` per prepare/bind/step/exec.
- `known` — `LRU_HASH` of statement pointers already emitted; gates `zSql` recovery to once each.
- `prepare_scratch` / `step_scratch` / `exec_scratch` — `HASH` keyed by `pid_tgid`, a single per-thread slot that pairs each entry probe with its return (stashes args/timestamp at entry, reads and clears at return).

### The JS side

| file | responsibility |
|---|---|
| `probes/sqlite.js`      | the only BPF-aware module: load the object, attach the probes, fold the event stream into an append-only log — exposes the `statements`, `stats`, and `status` signals |
| `main.jsx`              | composition root: view state (scroll / fuzzy filter / pause / freeze), all keyboard + wheel input, `mount` |
| `components/titlebar.jsx` | status rail — queries tracked, steps/s, rows/s, and tracing/paused state |
| `components/statements.jsx` | the statement list: syntax-highlighted, height-budgeted rows |
| `components/footer.jsx` | key hints and the live filter prompt |
| `lib/sqlhl.js`          | SQL tokenizer → colored `<Text>` spans |
| `lib/format.js`         | pure formatters — rate, duration, latency-heat color, result-code names |
| `lib/fuzzy.js`          | subsequence fuzzy match over process + SQL + bound values |

The model is an append-only **log of completed executions**, not a mutable per-statement aggregate. A statement is assembled in-flight (`prepare` → `bind*` → `step*`), then frozen into the log the instant it finishes — so a row already on screen never changes or jumps. A 250 ms window timer publishes one snapshot per frame, so a busy ring buffer costs one re-render, not thousands.

### Why uprobes on `libsqlite3`, not a query log

The public API is the seam where an application hands SQL to the engine, for *every* application, with no per-app setup. Uprobes hook it in the kernel: one attach covers every current and future process linked against the shared library, and pairing entry↔return probes is what yields per-call latency and the out-param `stmt` pointer that ties a statement's whole life together.

## Testing across kernels

`make veristat` loads `bin/sqlite.bpf.o` with veristat on **your** kernel — a quick check that every program passes the verifier, plus per-program complexity (insns/states). Loading BPF needs privileges, so use `sudo`.

A program that loads on your laptop can be rejected by an older kernel's verifier. [`.github/workflows/kernel-matrix.yml`](.github/workflows/kernel-matrix.yml) guards against that: for each kernel in its matrix it builds the object, boots that kernel in a VM ([cilium's little-vm-helper](https://github.com/cilium/little-vm-helper), images from `quay.io/lvh-images`), and runs the vendored static **veristat** against it — failing the job if the verifier rejects any program. The in-VM gate is `build/verify-kernel.sh`.

Run the same matrix locally (Linux + KVM) with `make veristat-matrix` — it boots the kernel images with `lvh` + QEMU and prints an `ok`/`FAIL` grid. Pick kernels with `make veristat-matrix KERNELS="6.6-main bpf-next-main"`.

## Requirements

> [!IMPORTANT]
> - **A Linux kernel with BTF** (`CONFIG_DEBUG_INFO_BTF`) — `bpftool` generates `src/bpf/include/vmlinux.h` from it. Default on current Arch, Fedora, Ubuntu, and Debian.
> - **The yeet daemon**, which performs the privileged BPF load. The BPF capabilities are delegated to a daemonized process, so `sqlitefeed` itself runs unprivileged. `curl -fsSL https://yeet.cx | sh` installs it.
> - **`libsqlite3.so.0`** on the host — the uprobe target, resolved by bare name via the linker cache.
>
> To build from source you also need `clang` and `bpftool`. No node/npm: esbuild is vendored by the toolchain and the project has no third-party deps.

## Honest caveats

> [!NOTE]
> `sqlitefeed` is observability, not enforcement. It shows you what ran; it does not block or alter anything.

- **`REAL` bind values are captured as a type, not a value.** A bound double arrives in an SSE register (`xmm0`) that isn't part of `pt_regs`, so a uprobe can't read it — the row shows `«real»`.
- **Recovery is x86-64 only.** On other architectures, unseen cached statements show `«unknown»` until they re-prepare (see above).
- **One per-thread scratch slot, not a nesting stack.** SQLite occasionally makes nested calls on one thread (e.g. reparsing `sqlite_master` mid-DDL); the inner call clobbers the slot and the outer statement is missed — shown as `«unknown»`. This is deliberate: it self-corrects on the next top-level call, whereas a depth-counting stack drifts permanently once a uretprobe is dropped past the kernel's `maxactive` limit.
- **`exec`/`step` events carry the SQL text on every record** (bounded to 512 bytes); very high statement rates lean on the ring buffer, which drops under backpressure rather than blocking the traced app.

## Community questions

**Does it slow the traced application down?**
No meaningful overhead. The probes are passive; the cost is a bounded ring-buffer write per call, and the buffer drops rather than blocks if userspace falls behind.

**Will it show statements from a process that was already running when I start it?**
Yes — that's exactly what the `zSql` recovery is for. Statements prepared and cached before you attached are recovered from the statement struct on their next `step` or `bind`.

**Does it work for any process, or just one app?**
Any process linked against `libsqlite3.so.0`, all at once — the process/pid gutter tells them apart. Statically-linked SQLite (some CLIs bundle their own copy) isn't covered, since there's no shared library to hook.

**Can I export the feed?**
Not built in. The `RingBuf.subscribe` callback in `probes/sqlite.js` holds every decoded record, so a JSON/HTTP/Kafka sink is a branch there. To set up a managed pipeline, [contact us](https://yeet.cx/).

## Building from source

```sh
make          # clang + bpftool → bin/sqlite.bpf.o ; esbuild → src/index.jsx
make bpf      # just the BPF object
make bundle   # just the JS bundle
make clean    # remove build artifacts
```

`make` runs two independent compilers: **clang + bpftool** compile `src/bpf/*.bpf.c` into the loadable object `bin/sqlite.bpf.o`; **esbuild** bundles `src/main.jsx` into `src/index.jsx`, resolving the `@/` (source root) and `#/` (project root) **bundle-time aliases** via tsconfig `paths` and leaving `yeet:*` builtins external. Both compilers come from a vendored static toolchain, so the build needs no system C/BPF toolchain and no node/npm. The generated `vmlinux.h`, `src/index.jsx`, and `bin/*.bpf.o` are build artifacts.

Because the aliases are bundle-time only, the runtime locates the BPF object with `import.meta.dirname` rather than an alias.

## License

Dual BSD/GPL. The BPF program declares `char LICENSE[] SEC("license") = "Dual BSD/GPL"` in [`src/bpf/sqlite.bpf.c`](src/bpf/sqlite.bpf.c), which the kernel requires for the helpers it uses.

---

Built with [yeet](https://yeet.cx/docs/), a JS runtime for writing eBPF programs on Linux. Join us on [Discord](https://discord.gg/dYZu9PjKB).
