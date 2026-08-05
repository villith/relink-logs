import { describe, expect, it } from "vitest";

import { CAPABILITIES } from "./capabilities";
import { resolveViewSpec } from "./resolve";
import { DEFAULT_STATE, DIMENSIONS, METRIC_KEYS, type AnalysisState } from "./state";

/** Every meaningful shape of the state space. Pin VALUES don't change the
 * resolution — only pin PRESENCE does — so one representative value per
 * dimension enumerates the machine. */
export const allStates = (): AnalysisState[] => {
  const states: AnalysisState[] = [];
  for (const metric of METRIC_KEYS) {
    for (const hostility of ["friendly", "enemy"] as const) {
      for (const source of [null, 1]) {
        for (const ability of [null, metric === "buffs" || metric === "debuffs" ? "status:10:3" : "skill:5"]) {
          for (const target of [null, 0]) {
            for (const by of [null, ...DIMENSIONS]) {
              for (const window of [null, [5, 20] as [number, number]]) {
                states.push({ ...DEFAULT_STATE, metric, hostility, source, ability, target, by, window });
              }
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
      const spec = resolveViewSpec(state, CAPABILITIES[state.metric]);
      expect(spec.regroupTabs.filter((tab) => tab.active)).toHaveLength(1);
      // Every disabled tab must say why.
      for (const tab of spec.regroupTabs) {
        if (!CAPABILITIES[state.metric].dimensions[tab.dim].supported) {
          expect(tab.disabledReason, `${state.metric}/${tab.dim}`).toBeTruthy();
        }
      }
    }
  });

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
        state.window ? "win" : "···",
        "→",
        spec.groupBy,
        spec.chart.source,
        spec.chart.titleKey,
        spec.fetch ? "fetch" : "local",
      ].join(" ");
    });
    expect(rows).toMatchSnapshot();
  });
});
