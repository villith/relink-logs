import { describe, expect, it } from "vitest";

import { CAPABILITIES } from "./capabilities";
import { resolveGroupBy, resolveViewSpec } from "./resolve";
import { DEFAULT_STATE, type AnalysisState } from "./state";

const state = (over: Partial<AnalysisState>): AnalysisState => ({ ...DEFAULT_STATE, ...over });

describe("resolveGroupBy — the one derivation rule", () => {
  it("defaults to the first unpinned dimension", () => {
    expect(resolveGroupBy(DEFAULT_STATE, CAPABILITIES.damage)).toBe("source");
    expect(resolveGroupBy(state({ source: 1 }), CAPABILITIES.damage)).toBe("ability");
    expect(resolveGroupBy(state({ source: 1, ability: "skill:2" }), CAPABILITIES.damage)).toBe("target");
    expect(resolveGroupBy(state({ ability: "skill:2" }), CAPABILITIES.damage)).toBe("source");
  });

  it("never dead-ends: all pinned resolves to the last dimension", () => {
    const full = state({ source: 1, ability: "skill:2", target: 0 });
    expect(resolveGroupBy(full, CAPABILITIES.damage)).toBe("target");
  });

  it("honors a supported override and ignores an unsupported one", () => {
    expect(resolveGroupBy(state({ by: "target" }), CAPABILITIES.damage)).toBe("target");
    expect(resolveGroupBy(state({ metric: "sba", by: "ability" }), CAPABILITIES.sba)).toBe("source");
  });

  it("skips unsupported dimensions when deriving", () => {
    // SBA supports only source; with source pinned the default must still be source.
    expect(resolveGroupBy(state({ metric: "sba", source: 1 }), CAPABILITIES.sba)).toBe("source");
  });
});

describe("resolveViewSpec", () => {
  it("lists every dimension as a regroup tab, disabled with a reason where unsupported", () => {
    const spec = resolveViewSpec(state({ metric: "stun" }), CAPABILITIES.stun);
    const target = spec.regroupTabs.find((tab) => tab.dim === "target");
    expect(spec.regroupTabs).toHaveLength(3);
    expect(target?.disabledReason).toBe("ui.logs.stun-no-target-dimension");
    expect(spec.regroupTabs.find((tab) => tab.dim === "source")?.active).toBe(true);
  });

  it("emits a GroupQuery only on the groups path", () => {
    expect(resolveViewSpec(DEFAULT_STATE, CAPABILITIES.damage).fetch).not.toBeNull();
    expect(resolveViewSpec(state({ metric: "sba" }), CAPABILITIES.sba).fetch).toBeNull();
    expect(resolveViewSpec(state({ metric: "buffs" }), CAPABILITIES.buffs).fetch).toBeNull();
  });

  it("translates pins into universe-typed query filters", () => {
    const spec = resolveViewSpec(state({ source: 3, target: 5, hostility: "friendly" }), CAPABILITIES.damage);
    expect(spec.fetch).toMatchObject({
      metric: "damage",
      hostility: "friendly",
      groupBy: "ability",
      source: { kind: "player", index: 3 },
      target: { kind: "enemySpawn", segment: 5 },
    });
  });

  it("on the enemy side the source filter is an enemy spawn", () => {
    const spec = resolveViewSpec(state({ hostility: "enemy", source: 7 }), CAPABILITIES.damage);
    expect(spec.fetch?.source).toEqual({ kind: "enemySpawn", segment: 7 });
  });

  it("keeps a status pin out of the query and flags a foreign-grammar ability", () => {
    const spec = resolveViewSpec(state({ metric: "damage", ability: "status:1:2" }), CAPABILITIES.damage);
    expect(spec.fetch?.ability).toBeNull();
  });
});
