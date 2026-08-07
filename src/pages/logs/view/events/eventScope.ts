import type { MetricKey } from "../analysis/machine/state";
import type { Hostility } from "../metrics/types";

import type { EventKind, EventRow } from "./eventRows";

/** Which raw events one metric's stream is made of.
 *
 * The Events view is a DISPLAY MODE, not a view of its own: the side toggle,
 * the metric tabs, the pins and the chart are all still live, and the metric
 * tab is what says which events the stream shows — Warcraft Logs' model, where
 * Buffs → Events lists Apply/Remove Buff and Damage Taken → Events lists
 * incoming hits. This is that mapping.
 *
 * `direction` and `harmful` are the two axes the kinds alone cannot express:
 * dealt and taken damage are the same `DamageEvent` read from opposite ends,
 * and a buff and a debuff are the same `StatusApply` told apart by the game's
 * own polarity flag. */
export type EventScope = {
  kinds: ReadonlySet<EventKind>;
  /** Damage only: which end of the hit the party is on. */
  direction?: "dealt" | "taken";
  /** Statuses only: the polarity the tab shows, exactly as `statusTabRows`
   * fixes it — Buffs false, Debuffs true. */
  harmful?: boolean;
};

/** The gauge kinds, split out because they are the one scope worth defaulting
 * OFF: `OnUpdateSBA` alone is 29% of a stored log and `SbaGain` is one event
 * per damaging hit, so unfiltered they bury the SBA events anyone opened the
 * tab to read. In scope, since they ARE SBA events — just behind a toggle. */
const SBA_TICK_KINDS: EventKind[] = ["sbaTick"];

const SCOPES: Record<MetricKey, EventScope> = {
  damage: { kinds: new Set<EventKind>(["damage"]), direction: "dealt" },
  taken: { kinds: new Set<EventKind>(["damage"]), direction: "taken" },
  // Every way the parser records stun, including the two guard variants — the
  // Stun table counts all of them, so its stream must list all of them.
  stun: { kinds: new Set<EventKind>(["stun", "perfectGuard"]) },
  sba: { kinds: new Set<EventKind>(["sba", ...SBA_TICK_KINDS]) },
  buffs: { kinds: new Set<EventKind>(["status"]), harmful: false },
  debuffs: { kinds: new Set<EventKind>(["status"]), harmful: true },
};

export const scopeFor = (metric: MetricKey): EventScope => SCOPES[metric];

/** The kinds a metric's own toggle strip offers, and which of them start on.
 *
 * A strip of one is no choice at all, so a scope with a single kind offers
 * nothing — the metric tab above already made that selection. */
export const scopeKinds = (scope: EventScope): EventKind[] => [...scope.kinds];

export const defaultScopeKinds = (scope: EventScope): ReadonlySet<EventKind> =>
  new Set([...scope.kinds].filter((kind) => !SBA_TICK_KINDS.includes(kind)));

/** How a row's actors are classified. Supplied by the view, which owns the
 * party roster and the status tables — a second copy of either here would let
 * the stream disagree with the table above it about who is in the party or
 * what counts as a debuff. */
export type ScopeProbes = {
  isPartyMember: (index: number) => boolean;
  /** The game's own `PositiveStatusOrNegativeStatus` flag (`isHarmful`). */
  isHarmful: (statusId: number) => boolean;
};

/** The rows inside one metric's scope.
 *
 * The direction test is on the PARTY, not on the enemy: "dealt" is a hit whose
 * source is a party member and "taken" is one whose target is, which is the
 * same rule the parser's two damage streams use. Neither is the hostility
 * switch's business — that picks which side the TABLE groups by, and both
 * sides read the same hits from opposite ends. */
export const filterByScope = (rows: EventRow[], scope: EventScope, probes: ScopeProbes): EventRow[] =>
  rows.filter((row) => {
    if (!scope.kinds.has(row.kind)) return false;

    if (scope.direction !== undefined && row.kind === "damage") {
      const dealt = row.sourceIndex !== null && probes.isPartyMember(row.sourceIndex);
      const taken = row.targetIndex !== null && probes.isPartyMember(row.targetIndex);
      // Friendly fire answers true to both and belongs in either stream; a hit
      // between two enemies answers neither and belongs in no damage tab.
      if (scope.direction === "dealt" ? !dealt : !taken) return false;
    }

    if (scope.harmful !== undefined && row.kind === "status") {
      // A status row with no effect id cannot be classed. Excluded rather than
      // shown on both tabs: a row that appears under Buffs AND Debuffs says the
      // polarity split does not mean anything.
      if (row.statusId === null || probes.isHarmful(row.statusId) !== scope.harmful) return false;
    }

    return true;
  });

/** Whether the side toggle changes this stream at all.
 *
 * It does for the statuses, where it picks the HOLDER side (a player's own
 * Rage vs an enemy's Bloodthirst). It does not for damage: both sides read the
 * same hits, and the switch only re-pivots the table's grouping. Exported so
 * the stream filters on the holder only where that is true, rather than
 * silently narrowing a damage tab by a control that does not apply to it. */
export const scopeUsesHostility = (scope: EventScope): boolean => scope.harmful !== undefined;

/** The status rows whose HOLDER is on the chosen side — the same split
 * `heldByRoster` makes for the tables. A status row's target IS its holder
 * (see `toEventRow`). */
export const filterByHolderSide = (rows: EventRow[], hostility: Hostility, probes: ScopeProbes): EventRow[] =>
  rows.filter((row) => {
    if (row.kind !== "status" || row.targetIndex === null) return true;
    return probes.isPartyMember(row.targetIndex) === (hostility === "friendly");
  });
