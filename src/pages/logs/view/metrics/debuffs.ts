import { statusTabRows } from "./buffs";
import type { MetricDescriptor } from "./types";

/** The same table as Buffs over the HARMFUL effects, holders defaulting to the
 * enemy side. It shares `statusTabRows` rather than restating it: the two tabs
 * differ only in polarity, and a second copy of the maths would drift. */
export const debuffs: MetricDescriptor = {
  labelKey: "ui.logs.metric-debuffs",
  columnKeys: () => ["ui.logs.buff-uptime", "ui.logs.buff-count"],
  // See buffs.labelKind: the holder kind comes from the hostility at render
  // time; "target" here is only the status-blind fallback.
  labelKind: (level) => (level === "players" ? "status" : "target"),
  rows: (input) => statusTabRows(input, true, "enemy"),
};
