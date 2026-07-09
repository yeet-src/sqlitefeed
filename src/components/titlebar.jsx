// Status rail: brand, live totals (statements tracked, step + row rates), and
// the probe status (green when tracing, red on a failed attach). A one-row Box
// tinted as the rail via its own bg — full width, no fragile space-fill.
import { Box, Text, idx } from "yeet:tui";
import { fmtRate } from "@/lib/format.js";

const RAIL = idx(235);
const sep = () => <Text fg={idx(240)}>{"  ▏  "}</Text>;
const label = (s) => <Text fg={idx(245)}>{s}</Text>;

export default function TitleBar({ stats, status, frozen, pinned }) {
  return (
    <Box height="1" direction="row" bg={RAIL}>
      <Text break="none">
        {() => {
          const s = stats.get();
          const st = status.get();
          const out = [
            <Text bold fg={idx(45)}>{" ● sqlitefeed "}</Text>, sep(),
            <Text bold>{`${s.tracked}`}</Text>, label(" queries"), sep(),
            <Text bold>{fmtRate(s.stepRate)}</Text>, label(" steps/s"), sep(),
            <Text bold>{fmtRate(s.rowRate)}</Text>, label(" rows/s"), sep(),
            <Text fg={st === "tracing" ? idx(78) : idx(203)}>{st}</Text>,
          ];
          // View is frozen (paused or scrolled into history) — data keeps
          // flowing (stats above still tick), only the list is held.
          if (frozen.get()) {
            out.push(sep(), <Text bold reverse fg={idx(214)}>{pinned.get() ? " ⏸ PAUSED " : " ⏸ HOLD "}</Text>);
          }
          return out;
        }}
      </Text>
    </Box>
  );
}
