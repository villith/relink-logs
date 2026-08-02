import type { ComputedPlayerState, StatusInterval } from "@/types";

import type { RowLevel } from "../deriveRows";
import { statusKey, uptimeMs } from "../statusUptime";

import type { MetricDescriptor, MetricRow } from "./types";

/** `statusKey` prefixed so a buff pin can never collide with an ability pin in
 * the same Ability selector — the two share one pin, and a damage ability and a
 * status effect have to stay tellable apart wherever that pin is read. */
export const buffPinKey = (interval: StatusInterval): string => `status:${statusKey(interval)}`;

/** Whether an Ability pin selects a status effect rather than a damage ability.
 *
 * Read outside the descriptors too: the scoped fetch turns an ability pin into
 * a backend filter, and a status pin means nothing there — sending it would
 * narrow the damage tables to no skill at all. */
export const isStatusPin = (pin: string | null): pin is string => pin !== null && pin.startsWith("status:");

const percent = (part: number, whole: number): string => (whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`);

const groupBy = <K, T>(items: T[], key: (item: T) => K): Map<K, T[]> => {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
};

/** Rows for a set of status intervals.
 *
 * Shared by the Buffs and Debuffs descriptors, which differ only in which
 * actors they look at — the row shape, uptime maths and pin behaviour are
 * identical, and duplicating them would let the two drift.
 *
 * `slotOf` resolves a holder's party slot for its bar colour, and answers -1 for
 * an actor that has none (an enemy).
 */
export const statusRows = (
  intervals: StatusInterval[],
  fightDurationMs: number,
  level: RowLevel,
  pinnedKey: string | null,
  slotOf: (actorIndex: number) => number
): MetricRow[] => {
  // The effect rows: one per (effect, cause), unioned across everyone holding
  // it. A pin that is not a status key selects no effect — pins are shared with
  // the damage tabs, and arriving from one must widen this table rather than
  // empty it.
  if (level === "players" || !isStatusPin(pinnedKey)) {
    return [...groupBy(intervals, buffPinKey).entries()]
      .map(([key, group]) => {
        const uptime = uptimeMs(group);
        return {
          key,
          label: key,
          value: uptime,
          columns: [percent(uptime, fightDurationMs), String(Math.max(...group.map((i) => i.maxStacks)))],
          pinOnClick: { ability: key },
          // An effect row spans the party, so no one slot's colour is right.
          colorSlot: -1,
        };
      })
      .sort((a, b) => b.value - a.value);
  }

  // One level down: who held the pinned effect, and for how long. Leaves —
  // there is nothing below a holder to descend into.
  return [...groupBy(
    intervals.filter((interval) => buffPinKey(interval) === pinnedKey),
    (interval) => interval.actorIndex
  ).entries()]
    .map(([actorIndex, group]) => {
      const uptime = uptimeMs(group);
      return {
        key: `player:${actorIndex}`,
        label: String(actorIndex),
        value: uptime,
        columns: [percent(uptime, fightDurationMs), String(Math.max(...group.map((i) => i.maxStacks)))],
        pinOnClick: null,
        colorSlot: slotOf(actorIndex),
      };
    })
    .sort((a, b) => b.value - a.value);
};

/** Party slots by actor index, for colouring a holder row. */
export const slotsOf = (players: ComputedPlayerState[]): Map<number, number> =>
  new Map(players.map((player) => [player.index, player.partyIndex]));

/** Splits the fight's intervals into the ones players hold and the rest.
 *
 * The roster decides: an actor index no player carries is an enemy, which is
 * the whole difference between the two tables. */
export const heldByPlayers = (
  intervals: StatusInterval[],
  players: ComputedPlayerState[],
  held: boolean
): StatusInterval[] => {
  const slots = slotsOf(players);
  return intervals.filter((interval) => slots.has(interval.actorIndex) === held);
};

export const buffs: MetricDescriptor = {
  labelKey: "ui.logs.metric-buffs",
  columnKeys: () => ["ui.logs.buff-uptime", "ui.logs.buff-stacks"],
  labelKind: (level) => (level === "players" ? "status" : "player"),
  rows: ({ statusIntervals, fightDurationMs, players, level, pins }) => {
    const slots = slotsOf(players);
    return statusRows(
      heldByPlayers(statusIntervals ?? [], players, true),
      fightDurationMs ?? 0,
      level,
      pins.ability,
      (actorIndex) => slots.get(actorIndex) ?? -1
    );
  },
};
