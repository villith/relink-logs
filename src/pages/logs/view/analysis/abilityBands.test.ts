import { describe, expect, it } from "vitest";

import type { AbilitySeries } from "@/types";

import { abilityBands } from "./abilityBands";

const skill = (id: number, values: number[]): AbilitySeries => ({
  kind: "skill",
  actionType: { Normal: id },
  childCharacterType: "Pl0000",
  values,
});

const cause = (key: string, values: number[]): AbilitySeries => ({ kind: "cause", key, values });

/** The identity labeller — these tests are about folding and ranking, not naming. */
const asKey = (key: string) => key;

describe("abilityBands", () => {
  it("sums bands that fold to the same row element-wise", () => {
    // Two backend bands for one action id (the parser files one row per
    // (action, child), and an ungrouped skill's row key drops the child).
    const bands = abilityBands([skill(1, [1, 2]), skill(1, [3, 4])], 8, asKey);

    expect(bands).toHaveLength(1);
    expect(bands[0].values).toEqual([4, 6]);
  });

  it("keeps a cause band under its own key rather than folding it", () => {
    // A cause has no action to group by; its key IS the row key.
    const bands = abilityBands([cause("source:partyAward", [5])], 8, asKey);

    expect(bands.map((band) => band.key)).toEqual(["source:partyAward"]);
  });

  it("ranks by total and folds the tail into exactly one other band", () => {
    const input = Array.from({ length: 10 }, (_, index) => skill(index, [10 - index]));
    const bands = abilityBands(input, 3, asKey);

    expect(bands).toHaveLength(4);
    expect(bands.slice(0, 3).map((band) => band.values[0])).toEqual([10, 9, 8]);
    expect(bands[3].key).toBe("other");
    // 7+6+5+4+3+2+1 = 28 — the tail is summed, never dropped.
    expect(bands[3].values[0]).toBe(28);
  });

  it("omits the other band when nothing is left over", () => {
    const bands = abilityBands([skill(1, [5]), skill(2, [3])], 8, asKey);

    expect(bands.map((band) => band.key)).not.toContain("other");
  });

  it("pads short series so every band spans the same buckets", () => {
    // A band that accrued nothing late in the fight can arrive short; recharts
    // would read the missing tail as a gap rather than as zero.
    const bands = abilityBands([skill(1, [1, 2, 3]), skill(2, [5])], 8, asKey);

    expect(bands.every((band) => band.values.length === 3)).toBe(true);
    expect(bands.find((band) => band.values[0] === 5)?.values).toEqual([5, 0, 0]);
  });

  it("labels every band through the injected namer", () => {
    const bands = abilityBands([skill(1, [1]), cause("source:partyAward", [1])], 8, (key) => key.toUpperCase());

    expect(bands.every((band) => band.label === band.key.toUpperCase())).toBe(true);
  });

  it("is empty for no input", () => {
    expect(abilityBands([], 8, asKey)).toEqual([]);
  });
});
