import type { EnemyType, SkillRow } from "@/types";

import { abilityKey } from "../abilityKey";
import { actionsForPins, type RowKeying } from "../abilitySkills";
import type { ActorSpace, EventRow } from "../events/eventRows";
import { takenAttackRowParts } from "../metrics/damageTaken";
import type { MetricRow } from "../metrics/types";
import { playerRowIndex, spawnRowSegment } from "../rowKey";

/** What the matcher needs from the view to place an event on a lane. */
export type LaneMatchContext = {
  /** Every action anyone used in the whole fight — the view's own
   * `everySkill`. Needed to expand a folded skill-group row back onto the raw
   * action ids its hits actually carry. */
  everySkill: SkillRow[];
  /** Which END of an event the lanes are keyed by. Damage dealt keys player
   * lanes by the attacker; damage taken keys them by the victim. The two are
   * the same `DamageEvent` read from opposite ends, exactly as
   * `filterByScope`'s direction test reads it. */
  end: "source" | "target";
  /** Spawn segment for an actor index at a moment, in the row's index space —
   * the view's `spawnSegmentAt` bound to its spawn table. `-1` for no spawn. */
  segmentAt: (index: number, atMs: number, space: ActorSpace) => number;
  /** The enemy TYPE at that index and moment, or null when it names no spawn. */
  enemyTypeAt: (index: number, atMs: number) => EnemyType | null;
  /** The view's row keying. Passed rather than rebuilt: the lane join and the
   * table must agree about which row an echo is on, and deriving it twice is
   * how they would come to differ. */
  keying?: RowKeying;
};

/** How a lane claims an event. */
export type LaneMatcher = {
  /** The `MetricRow.key` of the lane this event belongs on, or null when no
   * lane claims it. Null is common and is not an error: a metric's stream
   * carries events its current grouping cannot key (see the stun note below). */
  laneOf: (event: EventRow) => string | null;
};

const NO_LANE: LaneMatcher = { laneOf: () => null };

/** The `enemyType`+`action` token a `taken:` lane and a hit both reduce to. */
const attackToken = (enemyType: EnemyType, action: string): string => `${JSON.stringify(enemyType)}|${action}`;

/** Which lane claims each event, for the CURRENT rows.
 *
 * Dispatches on `MetricRow.kind`, which every row of one table shares — the
 * same assumption `declaredKind` in the view already makes.
 *
 * Rows whose kind cannot be keyed from an event claim nothing, and that is a
 * real answer rather than a gap to paper over. Stun grouped by ability is the
 * live case: `OnPlayerStun` and `OnStunEffect` carry an `actor_index` but no
 * action id (see `toEventRow`'s fallback branch), so no ability lane can hold
 * them. An empty lane says "this row has nothing placeable"; a guessed
 * placement would say something false. */
export const laneMatcherFor = (rows: MetricRow[], ctx: LaneMatchContext): LaneMatcher => {
  const kind = rows[0]?.kind;
  if (kind === undefined) return NO_LANE;

  switch (kind) {
    case "ability": {
      // The pin expansion, reused verbatim: a folded group row claims every
      // raw action behind it. Spelling this join a second way is how a lane
      // and the pin made by clicking it would come to disagree.
      //
      // No echo logic of its own is needed here: `actionsForPin` selects
      // through the collapse-aware `abilityRowKey`, so with the toggle on a
      // cause row's expansion already carries its echoes' raw actions.
      const byAction = new Map<string, string>();
      const expansions = actionsForPins(
        rows.map((row) => row.label),
        ctx.everySkill,
        ctx.keying
      );
      for (const row of rows) {
        for (const action of expansions.get(row.label) ?? []) {
          byAction.set(abilityKey(action), row.key);
        }
      }
      return { laneOf: (event) => (event.abilityKey === null ? null : byAction.get(event.abilityKey) ?? null) };
    }

    case "player": {
      const byIndex = new Map<number, string>();
      for (const row of rows) {
        const index = playerRowIndex(row.key);
        if (index !== null) byIndex.set(index, row.key);
      }
      return {
        laneOf: (event) => {
          const index = ctx.end === "source" ? event.sourceIndex : event.targetIndex;
          return index === null ? null : byIndex.get(index) ?? null;
        },
      };
    }

    case "target": {
      const bySegment = new Map<number, string>();
      for (const row of rows) {
        const segment = spawnRowSegment(row.key);
        if (segment !== null) bySegment.set(segment, row.key);
      }
      return {
        laneOf: (event) => {
          const index = ctx.end === "source" ? event.sourceIndex : event.targetIndex;
          if (index === null) return null;
          // The space the row DECLARES, not a guess: a damage row's target is
          // the folded instance pointer while every other kind reports the
          // game's actor index (see `ActorSpace`). The source end is always
          // the actor space.
          const space: ActorSpace = ctx.end === "source" ? "actor" : event.targetSpace;
          const segment = ctx.segmentAt(index, event.timeMs, space);
          return segment === -1 ? null : bySegment.get(segment) ?? null;
        },
      };
    }

    case "takenAttack": {
      const byAttack = new Map<string, string>();
      for (const row of rows) {
        const parts = takenAttackRowParts(row.label);
        if (parts !== null) byAttack.set(attackToken(parts.enemyType, abilityKey(parts.actionId)), row.key);
      }
      return {
        laneOf: (event) => {
          const index = ctx.end === "source" ? event.sourceIndex : event.targetIndex;
          if (index === null || event.abilityKey === null) return null;
          const enemyType = ctx.enemyTypeAt(index, event.timeMs);
          return enemyType === null ? null : byAttack.get(attackToken(enemyType, event.abilityKey)) ?? null;
        },
      };
    }

    // An enemy TYPE row merges same-type spawns and a status row is served by
    // its own `timeline` spans, so neither takes events from this join.
    default:
      return NO_LANE;
  }
};
