import { statusTabRows } from "./buffs";
import type { MetricDescriptor } from "./types";

/** The same table as Buffs over the HARMFUL effects. It shares `statusTabRows`
 * rather than restating it: the two tabs differ ONLY in polarity — the holder
 * side is the hostility switch's business, not the tab's — and a second copy of
 * the maths would drift. */
export const debuffs: MetricDescriptor = {
  labelKey: "ui.logs.metric-debuffs",
  supportsHostility: true,
  columnKeys: () => ["ui.logs.buff-uptime", "ui.logs.buff-count"],
  // See buffs.labelKind: the holder kind comes from the hostility at render
  // time, and both tabs default to the friendly holders, so the status-blind
  // fallback is the same "player" here as it is there.
  labelKind: (level) => (level === "players" ? "status" : "player"),
  rows: (input) => statusTabRows(input, true),
};
