import { heldByPlayers, statusRows } from "./buffs";
import type { MetricDescriptor } from "./types";

/** The same table as Buffs, over the actors no player index claims.
 *
 * It shares `statusRows` rather than restating it: the two differ only in which
 * actors they receive, and a second copy of the uptime maths would drift. */
export const debuffs: MetricDescriptor = {
  labelKey: "ui.logs.metric-debuffs",
  columnKeys: () => ["ui.logs.buff-uptime", "ui.logs.buff-stacks"],
  // A holder row here is an enemy, which the player-name lookup cannot name, so
  // it stays raw rather than resolving to the wrong thing.
  labelKind: (level) => (level === "players" ? "status" : "raw"),
  rows: ({ statusIntervals, fightDurationMs, players, level, pins }) =>
    statusRows(
      heldByPlayers(statusIntervals ?? [], players, false),
      fightDurationMs ?? 0,
      level,
      pins.ability,
      // Enemies have no party slot, so their bars take the neutral colour.
      () => -1
    ),
};
