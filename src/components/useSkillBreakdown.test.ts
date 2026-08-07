import { renderHook } from "@testing-library/react";
import i18n from "i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The real module resolves the bundled JSON through Tauri's resource API at
// import time, which does not exist under jsdom. Pl1800's own groups are not
// what these tests exercise — the Primal Burst group is keyed by body class.
vi.mock("@/assets/skill-groups", () => ({
  default: { Pl1800: { "pain-train": { skills: [1234] } } },
}));

import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { ComputedPlayerState, ComputedSkillGroup, ComputedSkillState, SkillState } from "@/types";

import { useSkillBreakdown } from "./useSkillBreakdown";

beforeAll(async () => {
  await i18n.init({
    lng: "en",
    resources: {
      en: {
        translation: {
          skills: {
            default: {
              "80000": "Summon Attack/Primal Burst",
              "unknown-skill": "Skill {{id}}",
              "primal-bursts": { "5418b8f8": "Catastrophe", "32776c5b": "Azure Ruin" },
              "skill-groups": { "primal-burst": "Primal Burst" },
            },
          },
        },
      },
    },
    interpolation: { escapeValue: false },
  });
});

const skill = (overrides: Partial<SkillState>): SkillState =>
  ({
    actionType: { Normal: 80000 },
    childCharacterType: "Pl1800",
    hits: 1,
    minDamage: 100,
    maxDamage: 100,
    totalDamage: 100,
    totalStunValue: 0,
    maxStunValue: 0,
    stunEligibleHits: 0,
    cappedHits: 0,
    cappableHits: 0,
    overcapBaseSum: 0,
    overcapCapSum: 0,
    targets: [],
    ...overrides,
  }) as SkillState;

const player = (skillBreakdown: SkillState[]): ComputedPlayerState =>
  ({ characterType: "Pl1800", skillBreakdown }) as ComputedPlayerState;

const isGroup = (row: ComputedSkillGroup | ComputedSkillState): row is ComputedSkillGroup =>
  typeof row.actionType === "object" && Object.hasOwn(row.actionType, "Group");

const breakdown = (skills: SkillState[], condensed = true) => {
  useMeterSettingsStore.setState({ use_condensed_skills: condensed });
  return renderHook(() => useSkillBreakdown(player(skills))).result.current.skills;
};

describe("useSkillBreakdown recomputation", () => {
  // The overlay re-renders on a 500ms clock as well as on encounter events, so
  // this hook runs for every open row on renders where nothing it reads has
  // changed. The grouping fold is a linear scan per skill (O(skills^2)), which
  // is why it must be keyed rather than repeated.
  it("returns the same rows when re-rendered with an unchanged player", () => {
    useMeterSettingsStore.setState({ use_condensed_skills: true });
    const subject = player([skill({ totalDamage: 100 })]);

    const { result, rerender } = renderHook(() => useSkillBreakdown(subject));
    const first = result.current.skills;
    rerender();

    expect(result.current.skills).toBe(first);
  });

  it("recomputes when the player's breakdown changes", () => {
    useMeterSettingsStore.setState({ use_condensed_skills: true });
    let subject = player([skill({ totalDamage: 100 })]);

    const { result, rerender } = renderHook(() => useSkillBreakdown(subject));
    const first = result.current.skills;
    subject = player([skill({ totalDamage: 250 })]);
    rerender();

    expect(result.current.skills).not.toBe(first);
    expect(result.current.skills[0].totalDamage).toBe(250);
  });
});

describe("useSkillBreakdown Primal Burst grouping", () => {
  const primalBurst = (bodyHash: number, totalDamage: number) =>
    skill({ childCharacterType: { Unknown: bodyHash }, totalDamage, hits: 2 });

  it("folds every Primal Burst body into one group, whichever primal answered", () => {
    // The three bodies are distinct classes, so the per-character skill-group
    // map (keyed by action id under a character) can never join them.
    const rows = breakdown([primalBurst(0x5418b8f8, 300), primalBurst(0x32776c5b, 200)]);

    expect(rows).toHaveLength(1);
    const group = rows[0];
    if (!isGroup(group)) throw new Error("expected a group row");
    expect(group.actionType).toEqual({ Group: "primal-burst" });
    expect(group.totalDamage).toBe(500);
    expect(group.hits).toBe(4);
    expect(group.skills).toHaveLength(2);
  });

  it("leaves an ordinary summon call out of the Primal Burst group", () => {
    // Same action id, different body: a called summon is not a Primal Burst.
    const rows = breakdown([primalBurst(0x5418b8f8, 300), primalBurst(0xb0792857, 50)]);

    expect(rows.filter(isGroup)).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });

  it("keeps the bodies as separate rows when condensed skills are off", () => {
    const rows = breakdown([primalBurst(0x5418b8f8, 300), primalBurst(0x32776c5b, 200)], false);

    expect(rows.filter(isGroup)).toHaveLength(0);
    expect(rows).toHaveLength(2);
  });
});
