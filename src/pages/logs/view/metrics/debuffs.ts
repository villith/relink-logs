import { heldByRoster, narrowedByPins, slotsOf, statusRows } from "./buffs";
import type { MetricDescriptor } from "./types";

/** The same table as Buffs, over the actors no player index claims.
 *
 * It shares `statusRows` rather than restating it: the two differ only in which
 * actors they receive, and a second copy of the uptime maths would drift. */
export const debuffs: MetricDescriptor = {
  labelKey: "ui.logs.metric-debuffs",
  columnKeys: () => ["ui.logs.buff-uptime", "ui.logs.buff-count"],
  // A holder row here is an enemy SPAWN, named through the response's target
  // entries — the only thing that carries an enemy's name and its "#n".
  labelKind: (level) => (level === "players" ? "status" : "target"),
  rows: ({ statusIntervals, fightDurationMs, players, roster, pins, statusWindow }) =>
    statusRows({
      intervals: narrowedByPins(heldByRoster(statusIntervals ?? [], slotsOf(roster ?? players), false), pins, "debuff"),
      fightDurationMs: fightDurationMs ?? 0,
      pinnedKey: pins.ability,
      // Enemies have no party slot, so their bars take the neutral colour.
      slotOf: () => -1,
      // The SPAWN, never the actor index: the game reissues a dead boss's index
      // to the next one, so keying on it merged two dragons into one row. An
      // enemy the segmenter skipped (a phantom marker) has no spawn to name it
      // by and keeps the raw id.
      holderOf: (interval) => {
        const key =
          interval.targetSegment === null ? `actor:${interval.actorIndex}` : `target:${interval.targetSegment}`;
        return { key, label: key };
      },
      window: statusWindow,
    }),
};

