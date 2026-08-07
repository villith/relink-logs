import { describe, expect, it } from "vitest";

import type { AbilitySeries, SkillRow } from "@/types";

import { skillKey } from "../abilityKey";
import { abilityRowKey, rowKeyingFor } from "../abilitySkills";
import { abilityBands } from "./abilityBands";
import { groupBandsFor } from "./machine/groupRows";

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

describe("abilityBands — key grammar", () => {
  it("namespaces skill bands with `skill:`, like every other band producer", () => {
    // The whole app dispatches band and row keys on this prefix — `bandLabelFor`
    // resolves `skill:` through labelForAbility and falls through to the RAW KEY
    // otherwise, which is what printed "Normal:1" in the legend and tooltip.
    const bands = abilityBands([skill(1, [1])], 8, asKey);

    expect(bands[0].key).toBe("skill:Normal:1");
  });

  it("leaves a cause band's key alone — it is already a full row key", () => {
    const bands = abilityBands([cause("source:partyAward", [1])], 8, asKey);

    expect(bands[0].key).toBe("source:partyAward");
  });
});

describe("abilityBands vs groupBandsFor", () => {
  it("keys the same ability identically to the damage/taken band path", () => {
    // The two producers feed ONE consumer (`bandLabelFor`) and one legend, so a
    // grammar that differs between them shows up as a raw key in the tooltip on
    // whichever tab got it wrong — which is exactly how this was found.
    // Normal:100 folds into a skill GROUP, so this also pins the folded spelling.
    const viaGroups = groupBandsFor([
      {
        key: { kind: "friendlyAbility", actionType: { Normal: 100 }, childCharacterType: "Pl0000" },
        measure: { amount: 300, hits: 1, min: null, max: null },
        series: [100, 200],
      },
    ]);
    const viaAbility = abilityBands(
      [{ kind: "skill", actionType: { Normal: 100 }, childCharacterType: "Pl0000", values: [100, 200] }],
      8,
      asKey
    );

    expect(viaAbility.map((band) => band.key)).toEqual(viaGroups.map((band) => band.key));
    expect(viaAbility[0].key).toBe('skill:Group:normal-attack@"Pl0000"');
  });

  it("folds skill-group members together the same way too", () => {
    // Two member actions of one group are ONE band in both paths.
    const viaAbility = abilityBands(
      [
        { kind: "skill", actionType: { Normal: 100 }, childCharacterType: "Pl0000", values: [100, 0] },
        { kind: "skill", actionType: { Normal: 110 }, childCharacterType: "Pl0000", values: [0, 100] },
      ],
      8,
      asKey
    );

    expect(viaAbility).toHaveLength(1);
    expect(viaAbility[0].values).toEqual([100, 100]);
  });
});

describe("abilityBands — fold mode", () => {
  it("folds a group's members into one band by default", () => {
    // 100 and 110 are members of the shipped "normal-attack" group.
    const bands = abilityBands([skill(100, [10]), skill(110, [5])], 8, asKey);

    expect(bands).toHaveLength(1);
    expect(bands[0].values).toEqual([15]);
  });

  it("keeps the members apart when a group is PINNED", () => {
    // Pinned, the rows ARE the members (see metrics/stun.ts), so folding them
    // back would redraw the single band that was just clicked.
    const bands = abilityBands([skill(100, [10]), skill(110, [5])], 8, asKey, "action");

    expect(bands.map((band) => band.key)).toEqual(["skill:Normal:100", "skill:Normal:110"]);
  });

  it("keys members by action alone, matching mergeSkillsByAction", () => {
    // A player and their summon on one action id are ONE member skill.
    const bands = abilityBands(
      [
        { kind: "skill", actionType: { Normal: 100 }, childCharacterType: "Pl0000", values: [10] },
        { kind: "skill", actionType: { Normal: 100 }, childCharacterType: "Pl0300", values: [5] },
      ],
      8,
      asKey,
      "action"
    );

    expect(bands).toHaveLength(1);
    expect(bands[0].values).toEqual([15]);
  });
});

describe("abilityBands — supplementary collapse", () => {
  // Narrowed to the SKILL variant, which is the half of `AbilitySeries` that
  // structurally IS a `SkillRow` — the keying and the row key both take one, and
  // a cause band (no action at all) can never reach either.
  const series: (AbilitySeries & SkillRow)[] = [
    { kind: "skill", actionType: { Normal: 100 }, childCharacterType: "Pl1900", values: [10, 0] },
    { kind: "skill", actionType: { SupplementaryDamage: 100 }, childCharacterType: "Pl1900", values: [4, 0] },
  ];

  it("merges an echo band into its cause's band when collapsing", () => {
    const bands = abilityBands(series, 8, asKey, "group", rowKeyingFor(series, true));
    expect(bands).toHaveLength(1);
    expect(bands[0].values[0]).toBe(14);
  });

  it("keeps the echo band separate without collapsing", () => {
    expect(abilityBands(series, 8, asKey, "group", rowKeyingFor(series, false))).toHaveLength(2);
  });

  it("keys a band exactly as the table keys the same row", () => {
    // The agree-by-construction claim, made testable: a band and the row it
    // decomposes must never be keyed two different ways.
    const keying = rowKeyingFor(series, true);
    expect(abilityBands(series, 8, asKey, "group", keying)[0].key).toBe(skillKey(abilityRowKey(series[1], keying)));
  });
});
