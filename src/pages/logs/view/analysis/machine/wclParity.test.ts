import { describe, expect, it } from "vitest";

import { CAPABILITIES } from "./capabilities";
import { resolveGroupBy } from "./resolve";
import { DEFAULT_STATE, type AnalysisState } from "./state";

const state = (over: Partial<AnalysisState>): AnalysisState => ({ ...DEFAULT_STATE, ...over });

/** Each case: the WCL report state it mirrors → the grouping WCL showed.
 * Report P6CwHkgFR9Krf1Bz fight 10 unless noted. */
const CASES: { name: string; state: AnalysisState; groupBy: string }[] = [
  { name: "?type=damage-done → Done By Source", state: DEFAULT_STATE, groupBy: "source" },
  { name: "?type=damage-done&source=14 → Done By Ability", state: state({ source: 14 }), groupBy: "ability" },
  {
    name: "?type=damage-done&source=14&ability=450499 → Done To Enemy",
    state: state({ source: 14, ability: "skill:450499" }),
    groupBy: "target",
  },
  {
    name: "?type=damage-done&ability=450499 → Done By Source",
    state: state({ ability: "skill:450499" }),
    groupBy: "source",
  },
  {
    name: "?type=damage-done&source=14&ability=450499&target=2 → still Done To Enemy (one-row)",
    state: state({ source: 14, ability: "skill:450499", target: 2 }),
    groupBy: "target",
  },
  {
    name: "?type=damage-done&hostility=1 → Done By Source (enemies)",
    state: state({ hostility: "enemy" }),
    groupBy: "source",
  },
  {
    name: "48dLj6Yhaqw3F1XM f24 ?type=damage-taken → Taken By Friendly",
    state: state({ metric: "taken" }),
    groupBy: "source",
  },
  {
    name: "48dLj6Yhaqw3F1XM f24 ?type=damage-taken&source=15 → Taken From Ability",
    state: state({ metric: "taken", source: 15 }),
    groupBy: "ability",
  },
  { name: "?type=auras → Gained By (effect rows)", state: state({ metric: "buffs" }), groupBy: "ability" },
  {
    name: "?type=auras&ability=80353 → holders",
    state: state({ metric: "buffs", ability: "status:80353:0" }),
    groupBy: "source",
  },
  {
    name: "?type=auras&hostility=1 → Gained By Enemy",
    state: state({ metric: "debuffs", hostility: "enemy" }),
    groupBy: "ability",
  },
];

describe("WCL parity — the reference machine's observed behavior", () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(resolveGroupBy(c.state, CAPABILITIES[c.state.metric])).toBe(c.groupBy);
    });
  }
});
