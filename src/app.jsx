/* sqlitefeed — a live trace of SQLite traffic on this host.
 *
 * It uprobes the public libsqlite3 API and shows, per prepared statement, the
 * SQL, the concrete values bound to its '?' placeholders, and the per-step
 * latency + result code — across every process using the shared library, with
 * no cooperation from the traced apps.
 *
 *   kernel → user : probes/sqlite.js attaches prepare/step/bind/exec (u)probes
 *                   and folds the event stream into a stmt-keyed model, exposed
 *                   as the `statements` and `stats` signals.
 *
 * Layout: probes/ (BPF-aware) → components/ (pure UI) → lib/ (pure helpers),
 * imported through the `@/` source alias and composed here. This file also owns
 * the view state (scroll offset + fuzzy filter) and all keyboard input.
 */
import { Box, computed, signal } from "yeet:tui";
import { statements, stats, status } from "@/probes/sqlite.js";
import { fuzzyMatch, haystack } from "@/lib/fuzzy.js";
import { rowHeight, rcIsError } from "@/lib/format.js";
import TitleBar from "@/components/titlebar.jsx";
import Statements from "@/components/statements.jsx";
import Detail from "@/components/detail.jsx";
import Footer from "@/components/footer.jsx";

// ── view state ───────────────────────────────────────────────────────────────
const scroll = signal(0); // index of the first visible statement (0 = newest)
const selected = signal(0); // index of the highlighted statement (the cursor)
const detail = signal(null); // a statement snapshot when the detail overlay is open
const filter = signal(""); // fuzzy query; "" = show everything
const errorsOnly = signal(false); // show only statements whose result code is an error
const mode = signal("normal"); // "normal" | "filter" (capturing the query)
const pinned = signal(false); // explicit pause via `p`
// While "frozen" the view reads this snapshot of the full list instead of the
// live one, so scrolling into history holds still as new statements arrive
// underneath. null = live/following. We freeze on scroll-away and on pause.
const frozenList = signal(null);
const frozen = computed(() => frozenList.get() !== null);

const enterFrozen = () => {
  if (!frozenList.get()) frozenList.set(statements.get());
};
const exitFrozen = () => frozenList.set(null);

// The list actually shown: the frozen snapshot (if any) else the live list,
// then the errors-only toggle, then the fuzzy filter. Both the panel and the
// footer (count) read this.
const visible = computed(() => {
  const q = filter.get();
  let base = frozenList.get() ?? statements.get();
  if (errorsOnly.get()) base = base.filter((s) => rcIsError(s.lastRc));
  return q ? base.filter((s) => fuzzyMatch(q, haystack(s))) : base;
});

// Scroll the viewport so the selected (cursor) row is fully visible. Body
// height is the terminal rows minus title + footer; rows are variable-height
// (multi-line SQL + params), so we sum real heights — matching how the panel
// itself budgets rows — and raise the top until the cursor fits.
const keepVisible = () => {
  const list = visible.get();
  const sel = selected.get();
  if (!list.length) return;
  const body = Math.max(1, tty.size().rows - 2);
  let top = Math.min(scroll.get(), sel); // cursor above viewport → reveal it
  let used = 0;
  for (let i = top; i <= sel; i++) used += rowHeight(list[i]);
  while (used > body && top < sel) used -= rowHeight(list[top++]);
  scroll.set(top);
};

// Move the cursor by d rows; freeze the view once it leaves the newest row so
// history holds still as new statements arrive, resume live back at the top.
const move = (d) => {
  const list = visible.get();
  if (!list.length) return;
  const next = Math.max(0, Math.min(list.length - 1, selected.get() + d));
  selected.set(next);
  if (next > 0) enterFrozen();
  else if (!pinned.get()) exitFrozen();
  keepVisible();
};

// Jump back to the newest statement and resume following.
const toNewest = () => {
  selected.set(0);
  scroll.set(0);
  if (!pinned.get()) exitFrozen();
};

// A filter edit changes the visible set, so reset the cursor to the top.
const resetCursor = () => {
  selected.set(0);
  scroll.set(0);
};

// Toggle the errors-only view; the visible set changes, so reset the cursor.
const toggleErrors = () => {
  errorsOnly.update((v) => !v);
  resetCursor();
};

const togglePause = () => {
  pinned.update((v) => !v);
  if (pinned.get()) enterFrozen();
  else if (selected.get() === 0) exitFrozen(); // unpinned at the top → resume live
};

// ── input ────────────────────────────────────────────────────────────────────
// Registered only when a terminal is allocated: this module is also imported
// by the headless JSON path (src/main.js), where the `tty` global is absent.
if (typeof tty !== "undefined") tty.on("keydown", (e) => {
  const code = e.code;
  const key = e.key ?? "";

  // Detail overlay is modal: Esc/Enter return to the list; q still quits.
  if (detail.get()) {
    if (code === "Escape" || code === "Enter") return detail.set(null);
    if (key.toLowerCase() === "q") return yeet.exit();
    return;
  }

  // Filter mode: keystrokes build the query; arrows still move the cursor.
  if (mode.get() === "filter") {
    if (code === "Escape") return (filter.set(""), mode.set("normal"), resetCursor());
    if (code === "Enter") return mode.set("normal"); // accept: keep filter, stop typing
    if (code === "Backspace") return (filter.set(filter.get().slice(0, -1)), resetCursor());
    if (code === "ArrowDown") return move(1);
    if (code === "ArrowUp") return move(-1);
    if (key.length === 1 && !e.ctrlKey && !e.altKey) {
      filter.set(filter.get() + key); // printable → append
      resetCursor();
    }
    return;
  }

  // Normal mode: navigation, drill-in, entering filter.
  const k = key.toLowerCase();
  if (code === "Escape" || k === "q") return yeet.exit();
  if (code === "Enter") {
    const s = visible.get()[selected.get()];
    if (s) detail.set(s); // open the detail overlay for the cursor row
    return;
  }
  if (k === "/") return mode.set("filter");
  if (k === "e") return toggleErrors();
  if (k === "p") return togglePause();
  if (code === "ArrowDown" || k === "j") return move(1);
  if (code === "ArrowUp" || k === "k") return move(-1);
  if (code === "PageDown") return move(10);
  if (code === "PageUp") return move(-10);
  if (k === "g") return toNewest();
});

if (typeof tty !== "undefined") tty.on("wheel", (e) => move(e.deltaY > 0 ? 3 : -3));

// `size` is the terminal's reactive size signal; the body reads it to reflow
// (and to budget how many statement rows fit above the footer).
export const Root = (size) => (
  <Box>
    <TitleBar stats={stats} status={status} frozen={frozen} pinned={pinned} />
    <Box height="1fr" overflow="hidden">
      {() =>
        detail.get() ? (
          <Detail s={detail.get()} statements={statements} />
        ) : (
          <Statements visible={visible} size={size} scroll={scroll} selected={selected} filter={filter} errorsOnly={errorsOnly} />
        )
      }
    </Box>
    <Footer
      mode={mode}
      filter={filter}
      errorsOnly={errorsOnly}
      visible={visible}
      statements={statements}
      selected={selected}
      pinned={pinned}
      frozen={frozen}
      detail={detail}
    />
  </Box>
);

// Mounted by src/main.js when a tty is allocated; the headless path
// (no tty / `yeet run -T`) streams JSON instead — see src/json.js.
