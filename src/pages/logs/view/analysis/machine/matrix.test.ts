import { describe, expect, it } from "vitest";

import { CAPABILITIES } from "./capabilities";
import { resolveViewSpec } from "./resolve";
import { DEFAULT_STATE, DIMENSIONS, METRIC_KEYS, type AnalysisState } from "./state";

/** Every meaningful shape of the state space. Pin VALUES don't change the
 * resolution — only pin PRESENCE does — so one representative value per
 * dimension enumerates the machine. `window` is deliberately left at
 * DEFAULT_STATE's null — see the invariance assertion below. */
const allStates = (): AnalysisState[] => {
  const states: AnalysisState[] = [];
  for (const metric of METRIC_KEYS) {
    for (const hostility of ["friendly", "enemy"] as const) {
      for (const source of [null, 1]) {
        for (const ability of [null, metric === "buffs" || metric === "debuffs" ? "status:10:3" : "skill:5"]) {
          for (const target of [null, 0]) {
            for (const by of [null, ...DIMENSIONS]) {
              states.push({ ...DEFAULT_STATE, metric, hostility, source, ability, target, by });
            }
          }
        }
      }
    }
  }
  return states;
};

describe("the full state matrix", () => {
  it("resolves every state to a spec with an active grouping and no silent holes", () => {
    for (const state of allStates()) {
      const caps = CAPABILITIES[state.metric];
      const spec = resolveViewSpec(state, caps);
      expect(spec.regroupTabs.filter((tab) => tab.active)).toHaveLength(1);
      // Every tab — enabled or disabled — must have something to display.
      for (const tab of spec.regroupTabs) {
        expect(tab.labelKey, `${state.metric}/${tab.dim}`).toBeTruthy();
        // Every disabled tab must say why.
        if (!caps.dimensions[tab.dim].supported) {
          expect(tab.disabledReason, `${state.metric}/${tab.dim}`).toBeTruthy();
        }
      }
      // window never affects resolution today — assert it explicitly, so the
      // moment it starts mattering, a test fails naming it.
      expect(resolveViewSpec({ ...state, window: [5, 20] }, caps)).toEqual(spec);
    }
  });

  // Row: metric hostility pins by → groupBy chart.source fetch|local
  // pins: S/A/T = source/ability/target pinned (fixed order), - = unpinned;
  // · = no by override.
  it("matches the reviewed snapshot — a diff here is a behavior change", () => {
    const rows = allStates().map((state) => {
      const spec = resolveViewSpec(state, CAPABILITIES[state.metric]);
      const pins = [
        state.source !== null ? "S" : "-",
        state.ability !== null ? "A" : "-",
        state.target !== null ? "T" : "-",
      ].join("");
      return [
        state.metric,
        state.hostility,
        pins,
        state.by ?? "·",
        "→",
        spec.groupBy,
        spec.chart.source,
        spec.fetch ? "fetch" : "local",
      ].join(" ");
    });
    expect(rows).toMatchSnapshot();
  });
});
