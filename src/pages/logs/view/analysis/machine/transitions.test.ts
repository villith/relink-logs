import { describe, expect, it } from "vitest";

import { CAPABILITIES } from "./capabilities";
import { resolveGroupBy } from "./resolve";
import { DEFAULT_STATE, type AnalysisState } from "./state";
import { clearPin, pinRow, regroup, setHostility, setMetric, setWindow } from "./transitions";

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
