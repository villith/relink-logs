import { describe, expect, it } from "vitest";

import { buildCoverage, groupNeedsOf } from "./gen-attack-group-coverage.mjs";

/** A nodes map in the exact shape skillboard-cap-sources.json ships. */
const nodes = {
  // Two group-scoped cap effects in the same group, one in another.
  pl2700_0015: { effects: [{ stat: "cap", scope: "attack-group", targetAttackGroup: 15, percent: 30, abilityIds: [] }] },
  pl2700_0083: { effects: [{ stat: "cap", scope: "attack-group", targetAttackGroup: 15, percent: 30, abilityIds: [] }] },
  pl2700_00de: { effects: [{ stat: "cap", scope: "attack-group", targetAttackGroup: 20, percent: 25, abilityIds: [] }] },
  // Ability-scoped (group 10 with hashes): resolved by the skill-name bridge,
  // NOT a derivation need.
  pl2700_0097: { effects: [{ stat: "cap", scope: "attack-group", targetAttackGroup: 10, percent: 45, abilityIds: ["aea6d151"] }] },
  // A different character with only always/gated nodes: nothing to derive.
  pl0000_000c: { effects: [{ stat: "cap", scope: "always", percent: 20 }] },
  pl0000_001b: { effects: [{ stat: "cap", scope: "gated", percent: 100, gateStatusId: 1000 }] },
  // A non-cap effect never creates a need.
  pl0300_0001: { effects: [{ stat: "atk", scope: "attack-group", targetAttackGroup: 3, percent: 10, abilityIds: [] }] },
};

describe("groupNeedsOf", () => {
  it("collects group-scoped cap effects with no ability ids, per character", () => {
    const needs = groupNeedsOf(nodes);
    expect(needs.pl2700).toEqual({
      15: { percents: [30, 30], nodeKeys: ["pl2700_0015", "pl2700_0083"] },
      20: { percents: [25], nodeKeys: ["pl2700_00de"] },
    });
  });

  it("does not create a need for ability-scoped, non-group or non-cap effects", () => {
    const needs = groupNeedsOf(nodes);
    expect(needs.pl0000).toEqual({});
    expect(needs.pl0300).toEqual({});
    expect(Object.keys(needs.pl2700)).not.toContain("10");
  });
});

describe("buildCoverage", () => {
  it("gives every character an entry with a computed status", () => {
    const coverage = buildCoverage(groupNeedsOf(nodes), {});
    expect(coverage.pl0000.status).toBe("not-needed");
    expect(coverage.pl0300.status).toBe("not-needed");
    expect(coverage.pl2700.status).toBe("underived");
    expect(coverage.pl2700.neededGroups).toEqual([15, 20]);
    expect(coverage.pl2700.groups).toEqual({});
  });

  it("preserves derived groups from the existing asset and recomputes status", () => {
    const existing = {
      pl2700: {
        status: "stale-status-is-ignored",
        groups: { 20: { actionIds: [110, 111, 112, 115, 140], evidence: "oracle-2026-08-10" } },
      },
    };
    const coverage = buildCoverage(groupNeedsOf(nodes), existing);
    expect(coverage.pl2700.status).toBe("partial");
    expect(coverage.pl2700.groups[20].actionIds).toEqual([110, 111, 112, 115, 140]);
    expect(coverage.pl2700.neededGroups).toEqual([15]);
  });

  it("reports derived when every needed group has a membership", () => {
    const existing = {
      pl2700: {
        groups: {
          15: { actionIds: [1], evidence: "e" },
          20: { actionIds: [2], evidence: "e" },
        },
      },
    };
    expect(buildCoverage(groupNeedsOf(nodes), existing).pl2700.status).toBe("derived");
  });

  it("drops a stored membership whose group no longer exists in the tables", () => {
    // A patch that removes or renumbers a group must not leave a ghost
    // membership claiming coverage for it.
    const existing = { pl2700: { groups: { 99: { actionIds: [5], evidence: "e" } } } };
    const coverage = buildCoverage(groupNeedsOf(nodes), existing);
    expect(coverage.pl2700.groups[99]).toBeUndefined();
    expect(coverage.pl2700.status).toBe("underived");
  });
});
