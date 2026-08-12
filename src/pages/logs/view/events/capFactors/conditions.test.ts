import { describe, expect, it } from "vitest";

import { conditionsForHit } from "./conditions";

const attacker = (over = {}) => ({
  source_current_hp: null,
  source_max_hp: null,
  source_statuses: null,
  ...over,
});

const stats = { level: 1, totalHp: 50000, totalAttack: 0, stunPower: 0, criticalRate: 150, totalPower: 0 };

describe("conditionsForHit", () => {
  it("supplies the attacker's flat HP and its fraction from one pair", () => {
    // Catastrophe gates on flat HP, Celestial Lumen on the fraction — the same
    // captured pair answers both.
    const conditions = conditionsForHit(attacker({ source_current_hp: 30000, source_max_hp: 60000 }), null);
    expect(conditions.hp).toBe(30000);
    expect(conditions.hpRatio).toBe(0.5);
  });

  it("omits the fraction when max HP is missing or zero", () => {
    // Dividing by a missing max would report a ratio of Infinity or NaN, and a
    // gate compared against NaN silently reads as "not met".
    expect(conditionsForHit(attacker({ source_current_hp: 30000, source_max_hp: 0 }), null).hpRatio).toBeUndefined();
    expect(conditionsForHit(attacker({ source_current_hp: 30000 }), null).hpRatio).toBeUndefined();
  });

  it("omits HP entirely when the hit never captured it", () => {
    const conditions = conditionsForHit(attacker(), null);
    expect(conditions.hp).toBeUndefined();
    expect(conditions.hpRatio).toBeUndefined();
  });

  it("distinguishes an attacker holding no statuses from a hit that captured none", () => {
    // The whole reason the wire type keeps null and [] apart. An old log must
    // leave gated sources UNRESOLVED; a captured-but-empty list is evidence
    // they were genuinely inactive.
    expect(conditionsForHit(attacker({ source_statuses: null }), null).buffs).toBeUndefined();
    expect(conditionsForHit(attacker({ source_statuses: [] }), null).buffs).toEqual([]);
  });

  it("supplies status ids and their stack counts", () => {
    const conditions = conditionsForHit(
      attacker({
        source_statuses: [
          { status_id: 1000, stacks: 1 },
          { status_id: 56, stacks: 3 },
        ],
      }),
      null
    );
    expect(conditions.buffs).toEqual([1000, 56]);
    // Keyed by status id, because that is the id the hook emits — not by trait.
    expect(conditions.stacks).toEqual({ "1000": 1, "56": 3 });
  });

  it("supplies the hit's own action id for move-scoped sources", () => {
    // The one condition that was always on the log and never passed: a skill
    // hit's action id, which is what settles ability-scoped board nodes.
    expect(conditionsForHit(attacker(), null, { Normal: 1700 }).actionId).toBe(1700);
  });

  it("omits the action id for hit kinds that carry none", () => {
    // A link attack or SBA has no per-character action id, and an echo's
    // payload names its CAUSE, not itself — passing either would match a
    // move-scoped node against an id that does not mean "this move".
    expect(conditionsForHit(attacker(), null, "LinkAttack").actionId).toBeUndefined();
    expect(conditionsForHit(attacker(), null, { SupplementaryDamage: 1700 }).actionId).toBeUndefined();
    expect(conditionsForHit(attacker(), null).actionId).toBeUndefined();
  });

  it("carries the stored per-player stats the banded traits ramp across", () => {
    const conditions = conditionsForHit(attacker(), stats);
    expect(conditions.critRate).toBe(150);
    expect(conditions.maxHp).toBe(50000);
  });

  it("prefers the hit's own max HP over the stored stat block", () => {
    // The pair was read at the moment of the hit; the stat block is a load-time
    // snapshot, so the live read wins where both exist.
    const conditions = conditionsForHit(attacker({ source_current_hp: 1, source_max_hp: 77000 }), stats);
    expect(conditions.maxHp).toBe(77000);
  });
});
