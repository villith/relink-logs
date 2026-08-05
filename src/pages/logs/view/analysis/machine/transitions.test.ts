import { describe, expect, it } from "vitest";

import { CAPABILITIES } from "./capabilities";
import { resolveGroupBy } from "./resolve";
import { DEFAULT_STATE, type AnalysisState } from "./state";
import { clearPin, pinRow, regroup, setAura, setHostility, setMetric, setWindow } from "./transitions";

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

describe("aura filter housekeeping", () => {
  it("setAura sets and clears the filter without touching pins or by", () => {
    const pinned = state({ source: 1, by: "source" });
    const withAura = setAura(pinned, "src:status:4:1");
    expect(withAura.aura).toBe("src:status:4:1");
    expect(withAura.source).toBe(1);
    expect(withAura.by).toBe("source");
    expect(setAura(withAura, null).aura).toBeNull();
  });

  it("clearing the anchoring pin clears the aura", () => {
    expect(clearPin(state({ source: 1, aura: "src:status:4:1" }), "source").aura).toBeNull();
    expect(clearPin(state({ target: 0, aura: "tgt:status:4:1" }), "target").aura).toBeNull();
  });

  it("clearing an UNRELATED pin keeps the aura", () => {
    const s = state({ source: 1, target: 0, aura: "src:status:4:1" });
    expect(clearPin(s, "target").aura).toBe("src:status:4:1");
    expect(clearPin(s, "ability").aura).toBe("src:status:4:1");
  });

  it("re-pinning the anchor to a DIFFERENT actor clears the aura; same actor keeps it", () => {
    const s = state({ source: 1, aura: "src:status:4:1" });
    expect(pinRow(s, { dim: "source", value: 2 }).aura).toBeNull();
    expect(pinRow(s, { dim: "source", value: 1 }).aura).toBe("src:status:4:1");
    expect(pinRow(s, { dim: "ability", value: "skill:9" }).aura).toBe("src:status:4:1");
  });

  it("setHostility clears the aura with the actor pins it depends on", () => {
    expect(setHostility(state({ source: 1, aura: "src:status:4:1" }), "enemy").aura).toBeNull();
  });

  it("setMetric keeps the aura, like the window", () => {
    // damage → taken keeps the source pin, so the anchor survives; the
    // resolver decides whether the destination tab honors the filter.
    expect(setMetric(state({ source: 1, aura: "src:status:4:1" }), "taken").aura).toBe("src:status:4:1");
  });
});
