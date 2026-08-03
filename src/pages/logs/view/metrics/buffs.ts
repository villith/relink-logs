import type { ComputedPlayerState, StatusInterval } from "@/types";

import type { SelectorPins } from "../selectorOptions";
import { toBands } from "../statusBands";
import { isStatusPin, statusPinKey, uptimeMs } from "../statusUptime";

import { isHarmful } from "./statusPolarity";
import type { Hostility, MetricDescriptor, MetricRow } from "./types";

/** Uptime as a share of the fight.
 *
 * Clamped: the backend closes a still-open interval at the exact millisecond the
 * log ends, while the denominator is the chart's whole-second bucket count, so a
 * buff held for the entire pull is up to 999 ms longer than its own denominator
 * and would otherwise print "101%". */
const percent = (part: number, whole: number): string =>
  whole === 0 ? "0%" : `${Math.min(100, Math.round((part / whole) * 100))}%`;

/** How many times an effect landed across a group of windows.
 *
 * Summed, not maxed: Warcraft Logs' Count column on an effect row is the sum of
 * its holders' counts, and a refresh already folded into an interval's own
 * `applications` rather than opening a second window. */
const applications = (group: StatusInterval[]): number =>
  group.reduce((total, interval) => total + interval.applications, 0);

const groupBy = <K, T>(items: T[], key: (item: T) => K): Map<K, T[]> => {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    // Computed once: `key` builds a template string per interval, and calling it
    // twice per item doubled that on every render.
    const itemKey = key(item);
    const group = groups.get(itemKey);
    if (group) group.push(item);
    else groups.set(itemKey, [item]);
  }
  return groups;
};

/** Rows for a set of status intervals.
 *
 * Shared by the Buffs and Debuffs descriptors, which differ only in polarity
 * (which effects they filter to before calling this) — the row shape, uptime
 * maths and pin behaviour are identical, and duplicating them would let the
 * two drift.
 *
 * `slotOf` resolves a holder's party slot for its bar colour, and answers -1 for
 * an actor that has none (an enemy).
 *
 * `holderOf` says what a holder row IS. The friendly side groups by player, so
 * the actor index is the whole identity. The enemy side groups by SPAWN,
 * because the actor index is a handle the game reissues to the next boss —
 * see `StatusInterval.targetSegment`.
 *
 * `window` is the span the table measures. Given one, every row also carries the
 * windows it was up (`MetricRow.timeline`) and the table draws a positional bar
 * instead of a magnitude one.
 *
 * An options object rather than positionals: with six inputs, three of them
 * optional functions, a call site reads as a row of anonymous arrows.
 */
export const statusRows = ({
  intervals,
  fightDurationMs,
  pinnedKey,
  slotOf,
  holderOf = (interval) => ({ key: `player:${interval.actorIndex}`, label: String(interval.actorIndex) }),
  window,
}: {
  intervals: StatusInterval[];
  fightDurationMs: number;
  pinnedKey: string | null;
  slotOf: (actorIndex: number) => number;
  holderOf?: (interval: StatusInterval) => { key: string; label: string };
  /** The measured window, for the rows' timelines. Absent leaves them off and
   * the table falls back to its magnitude bar. */
  window?: { startMs: number; endMs: number };
}): MetricRow[] => {
  // The windows a group was up, rebased onto the measured window and merged.
  // `toBands` is the chart's own shaping — one rule, so a row's timeline and
  // the band it shades onto the plot can never disagree.
  const timelineOf = (group: StatusInterval[]) => (window ? toBands(group, window) : undefined);

  // The STATUS PIN decides the level here, not `RowLevel`. The level is derived
  // from a pin shared with the damage tabs, so it says "skills" for a pinned
  // damage ability too — and answering that with holder rows for an effect
  // nothing pinned produced an empty table, while answering it with effect rows
  // left `labelKind` claiming they were players and every row rendering "NaN".
  // The pin is the only thing that actually names an effect.
  if (!isStatusPin(pinnedKey)) {
    // The effect rows: one per (effect, cause), unioned across everyone holding
    // it. A pin that is not a status key selects no effect — pins are shared
    // with the damage tabs, and arriving from one must widen this table rather
    // than empty it.
    return [...groupBy(intervals, statusPinKey).entries()]
      .map(([key, group]) => {
        const uptime = uptimeMs(group);
        return {
          key,
          label: key,
          value: uptime,
          columns: [percent(uptime, fightDurationMs), String(applications(group))],
          pinOnClick: { ability: key },
          // An effect row spans the party, so no one slot's colour is right.
          colorSlot: -1,
          timeline: timelineOf(group),
        };
      })
      .sort((a, b) => b.value - a.value);
  }

  // One level down: who held the pinned effect, and for how long. Leaves —
  // there is nothing below a holder to descend into.
  return [
    ...groupBy(
      intervals.filter((interval) => statusPinKey(interval) === pinnedKey),
      (interval) => holderOf(interval).key
    ).entries(),
  ]
    .map(([key, group]) => {
      const uptime = uptimeMs(group);
      return {
        key,
        // From the group's own first interval, so the label is whatever
        // `holderOf` decided this holder is named by — a player index for
        // Buffs, a spawn for Debuffs.
        label: holderOf(group[0]).label,
        value: uptime,
        columns: [percent(uptime, fightDurationMs), String(applications(group))],
        pinOnClick: null,
        colorSlot: slotOf(group[0].actorIndex),
        timeline: timelineOf(group),
      };
    })
    .sort((a, b) => b.value - a.value);
};

/** Party slots by actor index: the roster that decides a holder's SIDE
 * (friendly vs enemy), and the colour of a holder row. `isHarmful` is what
 * decides buff from debuff; this only says who is on whose team.
 *
 * Built from the IDENTITY party, never the scoped one — a pinned source narrows
 * `players` to that one player, and a roster missing three of the party files
 * their effects as enemy-held. Same rule the chart and the labels already
 * follow (`identityPlayers`, not `players`). */
export const slotsOf = (players: ComputedPlayerState[]): Map<number, number> =>
  new Map(players.map((player) => [player.index, player.partyIndex]));

/** The intervals a roster's players hold, or the ones nobody in it does — the
 * hostility split (`statusTabRows` picks the boolean per tab, defaulted by
 * `hostility`). Takes the prebuilt roster so a descriptor does not construct
 * it twice per render. */
export const heldByRoster = (
  intervals: StatusInterval[],
  roster: Map<number, number>,
  held: boolean
): StatusInterval[] => intervals.filter((interval) => roster.has(interval.actorIndex) === held);

/** How a non-player holder row is keyed: the SPAWN, never the actor index —
 * the game reissues a dead boss's index to the next one, so keying on it
 * merged two dragons into one row. An enemy the segmenter skipped (a phantom
 * marker) has no spawn to name it by and keeps the raw id. */
export const enemyHolderOf = (interval: StatusInterval): { key: string; label: string } => {
  const key = interval.targetSegment === null ? `actor:${interval.actorIndex}` : `target:${interval.targetSegment}`;
  return { key, label: key };
};

/** The intervals the Source and Enemy pins admit.
 *
 * These two selectors used to do NOTHING on the status tabs — the descriptors
 * read `statusIntervals` and `pins.ability` only, so the Buffs table with a
 * friendly pinned was byte-identical to the unpinned one. Warcraft Logs narrows
 * its buff tables by actor, and a live selector that changes nothing is worse
 * than one that is not offered.
 *
 * The two sides read the pins DIFFERENTLY, because we have one Source selector
 * where Warcraft Logs has two actor dimensions (who gained it, who cast it):
 *
 * * On the friendly side the holders are players, so Source is the HOLDER. An
 *   enemy pin cannot narrow it at all — no player-held interval carries an
 *   enemy spawn — so applying it would empty the table rather than narrow it.
 * * On the enemy side the holders are enemy spawns, so the Enemy pin is the
 *   HOLDER and Source is the CASTER: "which of Vira's effects are on this
 *   boss" is the question the two together ask.
 *
 * `pins.ability` is deliberately not read here: on these tabs it names an
 * EFFECT, and `statusRows` already uses it to choose between effect rows and
 * holder rows. */
export const narrowedByPins = (
  intervals: StatusInterval[],
  pins: SelectorPins,
  hostility: Hostility
): StatusInterval[] =>
  intervals.filter((interval) => {
    const actor = hostility === "friendly" ? interval.actorIndex : interval.casterIndex;
    if (pins.source !== null && actor !== pins.source) return false;
    // A player-held effect has no enemy spawn to match, so an enemy pin
    // leaves the friendly side alone.
    if (hostility === "enemy" && pins.targets.length > 0) {
      if (interval.targetSegment === null || !pins.targets.includes(interval.targetSegment)) return false;
    }
    return true;
  });

/** Rows for one status tab: the tab fixes the POLARITY (Buffs shows
 * beneficial effects, Debuffs harmful ones — the game's own
 * `PositiveStatusOrNegativeStatus` flag via `isHarmful`), the hostility
 * switch picks the HOLDERS. Split by holder alone, the Debuffs tab filed an
 * enemy's own Bloodthirst as a "debuff", which is not what a debuff is. */
export const statusTabRows = (
  input: Parameters<MetricDescriptor["rows"]>[0],
  harmful: boolean,
  fallbackHostility: Hostility
): MetricRow[] => {
  const { statusIntervals, fightDurationMs, players, roster, pins, statusWindow } = input;
  const hostility = input.hostility ?? fallbackHostility;
  const slots = slotsOf(roster ?? players);
  const held = heldByRoster(statusIntervals ?? [], slots, hostility === "friendly");
  return statusRows({
    intervals: narrowedByPins(
      held.filter((interval) => isHarmful(interval.statusId) === harmful),
      pins,
      hostility
    ),
    fightDurationMs: fightDurationMs ?? 0,
    pinnedKey: pins.ability,
    // Enemies have no party slot, so their holder rows take the neutral slot.
    slotOf: hostility === "friendly" ? (actorIndex) => slots.get(actorIndex) ?? -1 : () => -1,
    holderOf: hostility === "friendly" ? undefined : enemyHolderOf,
    window: statusWindow,
  });
};

export const buffs: MetricDescriptor = {
  labelKey: "ui.logs.metric-buffs",
  columnKeys: () => ["ui.logs.buff-uptime", "ui.logs.buff-count"],
  // Holder-row kinds are decided by the HOSTILITY at render time
  // (`statusRowKindFor`); this only marks the tab as a status table.
  labelKind: (level) => (level === "players" ? "status" : "player"),
  rows: (input) => statusTabRows(input, false, "friendly"),
};
