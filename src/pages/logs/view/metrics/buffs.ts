import type { ComputedPlayerState, StatusInterval } from "@/types";

import { groupBy } from "../groupBy";
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
  // Unpinned: the effect rows, one per (effect, cause), unioned across everyone
  // holding it. A pin that is not a status key selects no effect — pins are
  // shared with the damage tabs, and arriving from one must widen this table
  // rather than empty it.
  //
  // Pinned: one level down to who held that effect, and for how long. Those are
  // leaves; there is nothing below a holder to descend into.
  const holderLevel = isStatusPin(pinnedKey);
  const groups = holderLevel
    ? groupBy(
        intervals.filter((interval) => statusPinKey(interval) === pinnedKey),
        (interval) => holderOf(interval).key
      )
    : groupBy(intervals, statusPinKey);

  return [...groups.entries()]
    .map(([key, group]) => {
      const uptime = uptimeMs(group);
      return {
        key,
        // A holder's name comes from the group's own first interval, so it is
        // whatever `holderOf` decided this holder is named by — a player index
        // for Buffs, a spawn for Debuffs. An effect row is named by its key.
        label: holderLevel ? holderOf(group[0]).label : key,
        value: uptime,
        columns: [percent(uptime, fightDurationMs), String(applications(group))],
        pinOnClick: holderLevel ? null : { ability: key },
        // An effect row spans the party, so no one slot's colour is right.
        colorSlot: holderLevel ? slotOf(group[0].actorIndex) : -1,
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
 * hostility split (`statusTabRows` turns the chosen side into this boolean).
 * Takes the prebuilt roster so a descriptor does not construct it twice per
 * render. */
export const heldByRoster = (
  intervals: StatusInterval[],
  roster: Map<number, number>,
  held: boolean
): StatusInterval[] => intervals.filter((interval) => roster.has(interval.actorIndex) === held);

/** How a non-player holder row is keyed: the SPAWN, never the actor index —
 * the game reissues a dead boss's index to the next one, so keying on it
 * merged two dragons into one row. An enemy the segmenter skipped (a phantom
 * marker) has no spawn to name it by and keeps the raw id. */
export const enemyHolderKey = (interval: StatusInterval): string =>
  interval.targetSegment === null ? `actor:${interval.actorIndex}` : `target:${interval.targetSegment}`;

/** The holder row itself, keyed by `enemyHolderKey` and labelled with the raw
 * key — the table resolves it to a name (see `targetRowLabel`), which is also
 * what `TARGET_ROW` parses back out. Callers that CAN name the spawn (the
 * chart, which holds `labelForTarget`) pass their own label and reuse the key
 * function, so the grammar has exactly one author. */
export const enemyHolderOf = (interval: StatusInterval): { key: string; label: string } => {
  const key = enemyHolderKey(interval);
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

/** The intervals one status tab shows: held by the chosen SIDE, of the tab's
 * POLARITY, and admitted by the Source and Enemy pins — `heldByRoster`, then
 * `isHarmful`, then `narrowedByPins`, in that order.
 *
 * It exists so the aura CHART and the aura TABLE cannot drift. Both used to
 * spell the three steps out for themselves, which meant a change to
 * `narrowedByPins`' semantics, or to which roster a call site built its slots
 * from, would silently make the plot draw a different set of effects from the
 * rows underneath it — with no type error and no failing test to say so. One
 * composition, two callers, no way to change one without the other.
 *
 * Takes the prebuilt slots rather than the players, for the same reason
 * `heldByRoster` does: `statusTabRows` needs the same map afterwards to colour
 * its holder rows, and building it twice per render buys nothing.
 *
 * Not every status reader wants all three steps — `statusSeries` (the Stacks
 * plot) deliberately stops after the roster split, because a pinned effect key
 * already implies both the polarity and the pins. Routing it through here would
 * change what it draws; it is not a call site this function is missing. */
export const narrowedStatusIntervals = ({
  intervals,
  slots,
  hostility,
  harmful,
  pins,
}: {
  intervals: StatusInterval[];
  /** The roster map from `slotsOf`, built from the IDENTITY party. */
  slots: Map<number, number>;
  hostility: Hostility;
  /** Which polarity the tab shows: Buffs false, Debuffs true. */
  harmful: boolean;
  pins: SelectorPins;
}): StatusInterval[] =>
  narrowedByPins(
    heldByRoster(intervals, slots, hostility === "friendly").filter(
      (interval) => isHarmful(interval.statusId) === harmful
    ),
    pins,
    hostility
  );

/** Rows for one status tab: the tab fixes the POLARITY (Buffs shows
 * beneficial effects, Debuffs harmful ones — the game's own
 * `PositiveStatusOrNegativeStatus` flag via `isHarmful`), the hostility
 * switch picks the HOLDERS. Split by holder alone, the Debuffs tab filed an
 * enemy's own Bloodthirst as a "debuff", which is not what a debuff is.
 *
 * The two axes are INDEPENDENT, so there is no per-tab fallback side: a tab
 * that defaulted itself to one side made the switch read as a consequence of
 * the polarity, which it is not. Absent an explicit side both tabs answer for
 * the friendly holders, the same way Warcraft Logs opens both of its. */
export const statusTabRows = (input: Parameters<MetricDescriptor["rows"]>[0], harmful: boolean): MetricRow[] => {
  const { statusIntervals, fightDurationMs, players, roster, pins, statusWindow } = input;
  const hostility: Hostility = input.hostility ?? "friendly";
  const slots = slotsOf(roster ?? players);
  return statusRows({
    intervals: narrowedStatusIntervals({ intervals: statusIntervals ?? [], slots, hostility, harmful, pins }),
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
  supportsHostility: true,
  columnKeys: () => ["ui.logs.buff-uptime", "ui.logs.buff-count"],
  // Holder-row kinds are decided by the HOSTILITY at render time
  // (`statusRowKindFor`); this only marks the tab as a status table.
  labelKind: (level) => (level === "players" ? "status" : "player"),
  rows: (input) => statusTabRows(input, false),
};
