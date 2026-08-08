import { describe, expect, it } from "vitest";

import { CAPABILITIES } from "./capabilities";
import { resolveGroupBy } from "./resolve";
import { DEFAULT_STATE, type AnalysisState } from "./state";
import {
  clearAuras,
  clearPin,
  clearWindowFilters,
  pinRow,
  regroup,
  setHostility,
  setMetric,
  setWindow,
  toggleAura,
  toggleWindowFilter,
  toggleWindowKind,
} from "./transitions";

const state = (over: Partial<AnalysisState>): AnalysisState => ({ ...DEFAULT_STATE, ...over });

describe("pinRow", () => {
  it("pins the row's dimension and clears the by override so the default advances", () => {
    const after = pinRow(state({ by: "source" }), { dim: "source", value: 2 });
    expect(after.source).toBe(2);
    expect(after.by).toBeNull();
    expect(resolveGroupBy(after, CAPABILITIES.damage)).toBe("ability");
  });

  it("walks WCL's drill: source → ability → target → one-row terminal", () => {
    let s = pinRow(DEFAULT_STATE, { dim: "source", value: 1 });
    s = pinRow(s, { dim: "ability", value: "skill:9" });
    expect(resolveGroupBy(s, CAPABILITIES.damage)).toBe("target");
    s = pinRow(s, { dim: "target", value: 0 });
    expect(resolveGroupBy(s, CAPABILITIES.damage)).toBe("target"); // terminal, never dead
  });

  it("walks the holder×effect drill on the aura tabs to the one-row terminal", () => {
    let s = state({ metric: "buffs" });
    expect(resolveGroupBy(s, CAPABILITIES.buffs)).toBe("ability"); // effect rows
    s = pinRow(s, { dim: "ability", value: "status:10:500" });
    expect(resolveGroupBy(s, CAPABILITIES.buffs)).toBe("source"); // holder rows
    s = pinRow(s, { dim: "source", value: 1 });
    // Both pinned → the last supported dimension: the single holder×effect
    // row (URL: abil=status:10:500&src=1 — expressible before, unreachable).
    expect(resolveGroupBy(s, CAPABILITIES.buffs)).toBe("source");
    expect(s.ability).toBe("status:10:500");
    expect(s.source).toBe(1);
  });
});

describe("axis housekeeping", () => {
  it("setMetric drops the ability pin when the grammar cannot cross tabs", () => {
    const onDamage = state({ ability: "status:4:1" });
    expect(setMetric(onDamage, "buffs").ability).toBe("status:4:1"); // status pin is the aura grammar
    expect(setMetric(state({ metric: "buffs", ability: "status:4:1" }), "damage").ability).toBeNull();
    expect(setMetric(state({ ability: "skill:1" }), "taken").ability).toBeNull(); // friendly key ≠ enemy attack
  });

  it("setHostility clears the actor pins — their universes swapped", () => {
    const after = setHostility(state({ source: 1, target: 2, by: "target" }), "enemy");
    expect(after.source).toBeNull();
    expect(after.target).toBeNull();
    expect(after.by).toBeNull();
    expect(after.hostility).toBe("enemy");
    // Non-status ability pins clear; status pins survive
    expect(setHostility(state({ ability: "skill:9" }), "enemy").ability).toBeNull();
    expect(setHostility(state({ ability: "status:4:1" }), "enemy").ability).toBe("status:4:1");
    // Window survives
    expect(setHostility(state({ window: [3, 9] }), "enemy").window).toEqual([3, 9]);
  });

  it("setMetric keeps source and window pins, clears by; same metric is a no-op", () => {
    const s = state({ source: 1, window: [3, 9], by: "target" });
    const taken = setMetric(s, "taken");
    expect(taken.source).toBe(1);
    expect(taken.window).toEqual([3, 9]);
    expect(taken.by).toBeNull();
    // Same metric is no-op
    const unchanged = setMetric(s, "damage");
    expect(unchanged).toBe(s);
  });

  it("setWindow keeps pins; clearPin clears one dimension only", () => {
    const windowed = setWindow(state({ source: 1 }), [3, 9]);
    expect(windowed.window).toEqual([3, 9]);
    expect(windowed.source).toBe(1);
    const cleared = clearPin(state({ source: 1, ability: "skill:2" }), "source");
    expect(cleared.source).toBeNull();
    expect(cleared.ability).toBe("skill:2");
  });

  it("regroup sets the override; regrouping to the derived default clears it", () => {
    expect(regroup(DEFAULT_STATE, "target", CAPABILITIES.damage).by).toBe("target");
    expect(regroup(state({ by: "target" }), "source", CAPABILITIES.damage).by).toBeNull();
  });

  it("unsupported regroup overrides are written but inert at the resolver", () => {
    const regrouped = regroup(state({ metric: "sba" }), "target", CAPABILITIES.sba);
    expect(regrouped.by).toBe("target");
    // But the resolver ignores it and returns the supported default
    expect(resolveGroupBy(regrouped, CAPABILITIES.sba)).toBe("source");
  });
});

const SRC_AURA = "src:status:4:1:unknown";
const TGT_AURA = "tgt:status:4:1:unknown";
const SRC_AURA_2 = "src:status:9:1:unknown";

describe("aura filter housekeeping", () => {
  it("toggleAura selects and deselects without touching pins or by", () => {
    const pinned = state({ source: 1, by: "source" });
    const withAura = toggleAura(pinned, SRC_AURA);
    expect(withAura.aura).toEqual([SRC_AURA]);
    expect(withAura.source).toBe(1);
    expect(withAura.by).toBe("source");
    expect(toggleAura(withAura, SRC_AURA).aura).toEqual([]);
  });

  it("selects several at once, in selection order", () => {
    let next = toggleAura(state({ source: 1, target: 0 }), SRC_AURA);
    next = toggleAura(next, TGT_AURA);
    next = toggleAura(next, SRC_AURA_2);
    expect(next.aura).toEqual([SRC_AURA, TGT_AURA, SRC_AURA_2]);
  });

  it("a target aura no longer replaces a source one — the strips share one list", () => {
    const next = toggleAura(toggleAura(state({ source: 1, target: 0 }), SRC_AURA), TGT_AURA);
    expect(next.aura).toEqual([SRC_AURA, TGT_AURA]);
  });

  it("deselecting one leaves the rest standing", () => {
    const s = state({ source: 1, target: 0, aura: [SRC_AURA, TGT_AURA, SRC_AURA_2] });
    expect(toggleAura(s, TGT_AURA).aura).toEqual([SRC_AURA, SRC_AURA_2]);
  });

  it("clearing the anchoring pin drops ONLY the auras anchored to it", () => {
    const s = state({ source: 1, target: 0, aura: [SRC_AURA, TGT_AURA] });
    expect(clearPin(s, "source").aura).toEqual([TGT_AURA]);
    expect(clearPin(s, "target").aura).toEqual([SRC_AURA]);
  });

  it("clearing an UNRELATED pin keeps every aura", () => {
    const s = state({ source: 1, target: 0, aura: [SRC_AURA] });
    expect(clearPin(s, "target").aura).toEqual([SRC_AURA]);
    expect(clearPin(s, "ability").aura).toEqual([SRC_AURA]);
  });

  it("a pin change that drops nothing returns the same state object", () => {
    // Consumers memoise off this; rebuilding it would hand them a fresh
    // identity on every unrelated pin.
    const s = state({ source: 1, target: 0, aura: [SRC_AURA] });
    expect(clearPin(s, "ability").aura).toBe(s.aura);
  });

  it("re-pinning the anchor to a DIFFERENT actor drops its auras; same actor keeps them", () => {
    const s = state({ source: 1, aura: [SRC_AURA, SRC_AURA_2] });
    expect(pinRow(s, { dim: "source", value: 2 }).aura).toEqual([]);
    expect(pinRow(s, { dim: "source", value: 1 }).aura).toEqual([SRC_AURA, SRC_AURA_2]);
    expect(pinRow(s, { dim: "ability", value: "skill:9" }).aura).toEqual([SRC_AURA, SRC_AURA_2]);
  });

  it("setHostility clears every aura with the actor pins they depend on", () => {
    expect(setHostility(state({ source: 1, aura: [SRC_AURA] }), "enemy").aura).toEqual([]);
  });

  it("setMetric keeps the auras, like the window", () => {
    // damage → taken keeps the source pin, so the anchor survives; the
    // resolver decides whether the destination tab honors the filter.
    expect(setMetric(state({ source: 1, aura: [SRC_AURA] }), "taken").aura).toEqual([SRC_AURA]);
  });

  it("clearAuras empties the list, and is identity-stable when already empty", () => {
    expect(clearAuras(state({ aura: [SRC_AURA, TGT_AURA] })).aura).toEqual([]);
    expect(clearAuras(DEFAULT_STATE)).toBe(DEFAULT_STATE);
  });
});

describe("window filter", () => {
  it("toggleWindowFilter selects and deselects one window", () => {
    const selected = toggleWindowFilter(DEFAULT_STATE, "sba:0");
    expect(selected.win).toEqual(["sba:0"]);
    expect(toggleWindowFilter(selected, "sba:0").win).toEqual([]);
  });

  it("selects several windows, across kinds", () => {
    let next = toggleWindowFilter(DEFAULT_STATE, "sba:0");
    next = toggleWindowFilter(next, "sba:2");
    next = toggleWindowFilter(next, "break:1");
    expect(next.win).toEqual(["sba:0", "sba:2", "break:1"]);
  });

  it("selecting a KIND drops that kind's individual entries — it already admits them", () => {
    const s = state({ win: ["sba:0", "sba:2", "break:1"] });
    expect(toggleWindowKind(s, "sba").win).toEqual(["break:1", "sba"]);
  });

  it("deselecting a kind leaves nothing of it behind", () => {
    // Not a fallback to whichever windows happened to be ticked before the
    // kind row was: those were dropped when it went on.
    const s = toggleWindowKind(state({ win: ["sba:0"] }), "sba");
    expect(toggleWindowKind(s, "sba").win).toEqual([]);
  });

  it("a kind toggle leaves OTHER kinds' entries alone", () => {
    const s = state({ win: ["break:1", "link"] });
    expect(toggleWindowKind(s, "sba").win).toEqual(["break:1", "link", "sba"]);
  });

  it("clearWindowFilters empties the list, and is identity-stable when already empty", () => {
    expect(clearWindowFilters(state({ win: ["sba", "break:0"] })).win).toEqual([]);
    expect(clearWindowFilters(DEFAULT_STATE)).toBe(DEFAULT_STATE);
  });

  it("survives pins, metric switches and hostility flips", () => {
    let next = toggleWindowFilter(DEFAULT_STATE, "link");
    next = pinRow(next, { dim: "source", value: 2 });
    next = setMetric(next, "sba");
    next = setHostility(next, "enemy");
    expect(next.win).toEqual(["link"]);
  });
});
