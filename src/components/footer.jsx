// Key-hint / filter rail. A one-row Box tinted as the rail (its own bg —
// reliable full width, unlike a fill of plain spaces which the text engine
// strips). States:
//   • filter mode  → live "/query▏" prompt + match count
//   • filter set   → the active query + count + how to clear
//   • normal       → position + pause state + navigation hints
import { Box, Text, idx } from "yeet:tui";

const RAIL = idx(235);
const CAP = idx(238); // key-cap tile, a shade lighter than the rail
const GLYPH = idx(222); // bright gold key text
const LABEL = idx(247); // dimmed description
const QUERY = idx(45); // the filter query text
const HOLD = idx(214); // frozen/paused marker
const ERRC = idx(203); // errors-only marker

const hint = (keys, label) => [
  <Text bg={CAP} bold fg={GLYPH}>{` ${keys} `}</Text>,
  <Text fg={LABEL}>{` ${label}   `}</Text>,
];

export default function Footer({ mode, filter, errorsOnly, visible, statements, selected, pinned, frozen, detail }) {
  return (
    <Box height="1" direction="row" bg={RAIL}>
      <Text break="none">
        {() => {
          // Detail overlay open: just the way back out.
          if (detail.get()) return ["  ", ...hint("esc", "back"), ...hint("q", "quit")];

          const m = mode.get();
          const q = filter.get();
          const shown = visible.get().length;
          const total = statements.get().length;

          if (m === "filter") {
            return [
              <Text bg={CAP} bold fg={GLYPH}>{" / "}</Text>,
              <Text fg={QUERY}>{` ${q}`}</Text>,
              <Text fg={GLYPH}>{"▏"}</Text>, // cursor
              <Text fg={LABEL}>{`   ${shown}/${total} match${shown === 1 ? "" : "es"}   ·  ⏎ accept  ·  esc clear`}</Text>,
            ];
          }

          const out = ["  "];
          // Frozen marker + where the cursor is in the buffer.
          if (frozen.get()) {
            const pos = shown ? Math.min(selected.get(), shown - 1) + 1 : 0;
            out.push(
              <Text bold fg={HOLD}>{pinned.get() ? "⏸ PAUSED" : "⏸ HOLD"}</Text>,
              <Text fg={LABEL}>{`  ${pos}/${shown}   `}</Text>,
            );
          }
          if (errorsOnly.get()) out.push(<Text bold fg={ERRC}>{"✗ errors-only   "}</Text>);
          if (q) {
            out.push(<Text fg={LABEL}>{"filter "}</Text>, <Text fg={QUERY}>{`“${q}” `}</Text>, ...hint("/", "edit"), ...hint("esc", "clear"));
          } else {
            out.push(...hint("↑/↓", "move"), ...hint("/", "filter"));
          }
          out.push(...hint("e", errorsOnly.get() ? "all" : "errors"), ...hint("⏎", "details"), ...hint("p", pinned.get() ? "resume" : "pause"), ...hint("g", "newest"), ...hint("q", "quit"));
          return out;
        }}
      </Text>
    </Box>
  );
}
