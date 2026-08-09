import type { PlayerStats, SourceStatus } from "@/types";

import type { CapConditions } from "./types";

/**
 * What a hit knows about the moment it landed, in the shape the cap factors ask
 * for.
 *
 * The hook captures the attacker's own HP and status list PRE-CALL — before the
 * game's damage function runs — because that is when the DamageInstance builder
 * computed the hit's cap. Several of these traits grant a stack ON hitting, so
 * a post-call snapshot would judge the hit against a stack it earned by landing.
 */

/** The attacker-state fields a damage event carries. Narrower than the wire
 * type on purpose: this derivation cannot depend on anything it does not use. */
export type AttackerState = {
  source_current_hp: number | null;
  source_max_hp: number | null;
  source_statuses: SourceStatus[] | null;
};

/**
 * Every condition this hit can answer for, and no key for the ones it cannot.
 *
 * An ABSENT key is not the same as a zero. A factor handed no `buffs` reports
 * itself unresolved; one handed `[]` reports itself inactive. That distinction
 * survives all the way from the wire — `source_statuses` is `null` for an old
 * log and `[]` for an attacker who genuinely held nothing — and collapsing it
 * here would make every gated cap source read as definitively inactive on every
 * log recorded before the capture existed.
 */
export const conditionsForHit = (attacker: AttackerState, stats: PlayerStats | null): CapConditions => {
  const conditions: CapConditions = {};

  const current = attacker.source_current_hp;
  const max = attacker.source_max_hp;
  if (current !== null) {
    conditions.hp = current;
    // Guarded rather than assumed: a missing or zero max would yield NaN or
    // Infinity, and a gate compared against NaN silently reads as "not met" —
    // which is a claim, not an absence.
    if (max !== null && max > 0) conditions.hpRatio = current / max;
  }

  // The live pair beats the stored block where both exist: it was read at the
  // moment of the hit, while the stat block is a load-time snapshot.
  if (max !== null && max > 0) conditions.maxHp = max;
  else if (stats !== null) conditions.maxHp = stats.totalHp;

  if (stats !== null) conditions.critRate = stats.criticalRate;

  const statuses = attacker.source_statuses;
  if (statuses !== null) {
    conditions.buffs = statuses.map((status) => status.status_id);
    // Keyed by STATUS id, because that is the id the hook emits and the id the
    // board's own gate columns carry. Nothing here is keyed by name.
    conditions.stacks = Object.fromEntries(statuses.map((status) => [String(status.status_id), status.stacks]));
  }

  return conditions;
};
