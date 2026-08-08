import { describe, expect, it } from "vitest";

import type { EventRow } from "./eventRows";
import {
  defaultScopeKinds,
  filterByHolderSide,
  filterByScope,
  scopeFor,
  scopeUsesHostility,
  type ScopeProbes,
} from "./eventScope";

const PARTY = new Set([0, 1]);
const HARMFUL = new Set([500]);
const PROBES: ScopeProbes = {
  isPartyMember: (index) => PARTY.has(index),
  isHarmful: (statusId) => HARMFUL.has(statusId),
};

const row = (over: Partial<EventRow>): EventRow => ({
  timeMs: 0,
  kind: "damage",
  sourceIndex: null,
  targetIndex: null,
  targetSpace: "actor",
  abilityKey: null,
  statusKey: null,
  statusId: null,
  detailKey: null,
  amount: null,
  capHit: null,
  ...over,
});

const dealt = row({ kind: "damage", sourceIndex: 0, targetIndex: 900, targetSpace: "spawn" });
const taken = row({ kind: "damage", sourceIndex: 900, targetIndex: 1, targetSpace: "spawn" });
const enemyOnEnemy = row({ kind: "damage", sourceIndex: 900, targetIndex: 901, targetSpace: "spawn" });
const buff = row({ kind: "status", sourceIndex: 0, targetIndex: 1, statusId: 100 });
const debuff = row({ kind: "status", sourceIndex: 0, targetIndex: 900, statusId: 500 });
const stun = row({ kind: "stun", sourceIndex: 0 });
const guard = row({ kind: "perfectGuard", sourceIndex: 0 });

describe("filterByScope", () => {
  // Dealt and taken are the SAME DamageEvent read from opposite ends, so the
  // kind alone cannot tell the two tabs apart.
  it("splits the one damage stream by which end the party is on", () => {
    const all = [dealt, taken, enemyOnEnemy];
    expect(filterByScope(all, scopeFor("damage"), PROBES)).toEqual([dealt]);
    expect(filterByScope(all, scopeFor("taken"), PROBES)).toEqual([taken]);
  });

  // A hit between two enemies is in neither stream. Shown on both, the Damage
  // Done tab would list damage the party never dealt.
  it("files a hit between two enemies under neither damage tab", () => {
    expect(filterByScope([enemyOnEnemy], scopeFor("damage"), PROBES)).toEqual([]);
    expect(filterByScope([enemyOnEnemy], scopeFor("taken"), PROBES)).toEqual([]);
  });

  // The same split the tables make: the game's own polarity flag, not the
  // holder — an enemy's own Bloodthirst is a buff it holds, not a debuff.
  it("splits the one status stream by the game's polarity flag", () => {
    const all = [buff, debuff];
    expect(filterByScope(all, scopeFor("buffs"), PROBES)).toEqual([buff]);
    expect(filterByScope(all, scopeFor("debuffs"), PROBES)).toEqual([debuff]);
  });

  it("excludes a status row with no effect id from both polarities", () => {
    const unclassed = row({ kind: "status", statusId: null });
    expect(filterByScope([unclassed], scopeFor("buffs"), PROBES)).toEqual([]);
    expect(filterByScope([unclassed], scopeFor("debuffs"), PROBES)).toEqual([]);
  });

  // The Stun table counts the guard variants too, so its stream must list them.
  it("keeps every way the parser records stun under the stun metric", () => {
    expect(filterByScope([stun, guard, dealt], scopeFor("stun"), PROBES)).toEqual([stun, guard]);
  });

  it("keeps a metric's own kinds and nothing else", () => {
    expect(filterByScope([dealt, buff, stun], scopeFor("buffs"), PROBES)).toEqual([buff]);
  });
});

describe("scope kinds", () => {
  // OnUpdateSBA alone is 29% of a stored log and SbaGain is one per hit — in
  // scope, because they ARE SBA events, but not buried under by default.
  it("leaves the gauge ticks in the SBA scope but off by default", () => {
    const scope = scopeFor("sba");
    expect(scope.kinds.has("sbaTick")).toBe(true);
    expect(defaultScopeKinds(scope).has("sbaTick")).toBe(false);
    expect(defaultScopeKinds(scope).has("sba")).toBe(true);
  });

  it("defaults every other scope to all of its kinds", () => {
    expect([...defaultScopeKinds(scopeFor("stun"))].sort()).toEqual(["perfectGuard", "stun"]);
    expect([...defaultScopeKinds(scopeFor("damage"))]).toEqual(["damage"]);
  });
});

describe("hostility", () => {
  // It picks the HOLDER side for statuses, and means nothing on damage: both
  // sides read the same hits, and the switch only re-pivots the table above.
  it("applies to the status streams only", () => {
    expect(scopeUsesHostility(scopeFor("buffs"))).toBe(true);
    expect(scopeUsesHostility(scopeFor("debuffs"))).toBe(true);
    expect(scopeUsesHostility(scopeFor("damage"))).toBe(false);
    expect(scopeUsesHostility(scopeFor("taken"))).toBe(false);
  });

  it("splits status rows by whose side the holder is on", () => {
    // buff is held by party member 1; debuff is held by enemy 900.
    expect(filterByHolderSide([buff, debuff], "friendly", PROBES)).toEqual([buff]);
    expect(filterByHolderSide([buff, debuff], "enemy", PROBES)).toEqual([debuff]);
  });

  it("leaves non-status rows alone whichever side is chosen", () => {
    expect(filterByHolderSide([stun], "enemy", PROBES)).toEqual([stun]);
  });
});
