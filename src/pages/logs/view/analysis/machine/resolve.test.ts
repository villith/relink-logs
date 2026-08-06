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
    // A disabled tab still needs a visible name — the placeholder groupLabelKey
    // capabilities.ts declares for an unsupported dimension is never it.
    expect(target?.labelKey).toBe("ui.logs.groupby-generic-target");
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

  it("keeps a status pin out of the query", () => {
    const spec = resolveViewSpec(state({ metric: "damage", ability: "status:1:2" }), CAPABILITIES.damage);
    expect(spec.fetch?.ability).toBeNull();
  });

  it("picks the chart shape from what is drawn", () => {
    expect(resolveViewSpec(state({ metric: "sba" }), CAPABILITIES.sba).chart).toMatchObject({
      source: "base",
      format: "percent",
    });
    expect(resolveViewSpec(state({ metric: "buffs" }), CAPABILITIES.buffs).chart).toMatchObject({
      source: "stacks",
      format: "count",
    });
  });

  it("inverts the row label and regroup-tab vocabulary on the enemy side", () => {
    const spec = resolveViewSpec(state({ hostility: "enemy" }), CAPABILITIES.damage);
    expect(spec.table.rowsLabelKey).toBe("ui.logs.rows-by-enemy");
    expect(spec.regroupTabs.find((tab) => tab.dim === "source")?.labelKey).toBe("ui.logs.groupby-damage-source-enemy");
  });

  it("heads the interval metrics' ability rows as effects", () => {
    expect(resolveViewSpec(state({ metric: "buffs" }), CAPABILITIES.buffs).table.rowsLabelKey).toBe(
      "ui.logs.rows-by-effect"
    );
    // With the effect pinned the rows are its holders.
    expect(
      resolveViewSpec(state({ metric: "buffs", ability: "status:1:2" }), CAPABILITIES.buffs).table.rowsLabelKey
    ).toBe("ui.logs.rows-by-player");
    expect(
      resolveViewSpec(state({ metric: "debuffs", hostility: "enemy", ability: "status:1:2" }), CAPABILITIES.debuffs)
        .table.rowsLabelKey
    ).toBe("ui.logs.rows-by-enemy");
  });

  it("names the honest empty states and leaves the rest to the pins default", () => {
    expect(resolveViewSpec(state({ metric: "buffs" }), CAPABILITIES.buffs).table.emptyKey).toBe("ui.logs.buffs-empty");
    expect(resolveViewSpec(state({ metric: "sba", source: 1 }), CAPABILITIES.sba).table.emptyKey).toBe(
      "ui.logs.sba-no-breakdown"
    );
    expect(resolveViewSpec(state({ hostility: "enemy" }), CAPABILITIES.damage).table.emptyKey).toBe(
      "ui.logs.enemy-dealt-empty"
    );
    expect(resolveViewSpec(DEFAULT_STATE, CAPABILITIES.damage).table.emptyKey).toBeUndefined();
    expect(
      resolveViewSpec(state({ metric: "taken", hostility: "enemy" }), CAPABILITIES.taken).table.emptyKey
    ).toBeUndefined();
  });
});

describe("the aura filter", () => {
  it("never affects the grouping", () => {
    const base = state({ source: 1 });
    const withAura = state({ source: 1, aura: "src:status:4:1:unknown" });
    expect(resolveGroupBy(withAura, CAPABILITIES.damage)).toBe(resolveGroupBy(base, CAPABILITIES.damage));
    expect(resolveViewSpec(withAura, CAPABILITIES.damage).groupBy).toBe(
      resolveViewSpec(base, CAPABILITIES.damage).groupBy
    );
  });

  it("rides the fetch only when its anchoring pin is present", () => {
    expect(resolveViewSpec(state({ source: 1, aura: "src:status:4:1:unknown" }), CAPABILITIES.damage).fetch?.aura).toBe(
      "src:status:4:1:unknown"
    );
    expect(
      resolveViewSpec(state({ metric: "taken", target: 0, aura: "tgt:status:4:1:unknown" }), CAPABILITIES.taken).fetch
        ?.aura
    ).toBe("tgt:status:4:1:unknown");
    // Hand-edited URL: an aura whose anchor pin is absent filters nothing.
    expect(resolveViewSpec(state({ aura: "src:status:4:1:unknown" }), CAPABILITIES.damage).fetch?.aura).toBeNull();
    expect(
      resolveViewSpec(state({ source: 1, aura: "tgt:status:4:1:unknown" }), CAPABILITIES.damage).fetch?.aura
    ).toBeNull();
  });
});
