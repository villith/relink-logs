import { describe, expect, it, vi } from "vitest";

// Two bodies whose action 100 folds into a same-named group each — the
// collision the qualifier exists for (Id's kit vs his dragonform's). Mocked
// so the case does not depend on the shipped table's exact contents.
vi.mock("@/assets/skill-groups", () => ({
  default: {
    Pl0900: { "normal-attack": { skills: [100] } },
    Pl0910: { "normal-attack": { skills: [100] } },
  },
}));

import type { CharacterType, ComputedPlayerState, SkillState } from "@/types";

import { rowKeyingFor } from "../abilitySkills";

import { aggregateAbilities, aggregateSources } from "./cardSections";

const skill = (action: number, child: string, damage: number): SkillState =>
  ({
    actionType: { Normal: action },
    childCharacterType: child,
    hits: 1,
    minDamage: damage,
    maxDamage: damage,
    totalDamage: damage,
    totalStunValue: 0,
    maxStunValue: 0,
    cappedHits: 0,
    cappableHits: 0,
    overcapBaseSum: 0,
    overcapCapSum: 0,
  }) as unknown as SkillState;

describe("aggregateAbilities — duplicate labels", () => {
  const SKILLS = [skill(100, "Pl0900", 200), skill(100, "Pl0910", 100), skill(9001, "Pl0900", 50)];
  // One display name for both groups — the collision under test.
  const label = (key: string) => (key.startsWith("Group:") ? "Normal Attack" : "Reginleiv");
  const characterName = (type: CharacterType) => (type === "Pl0910" ? "Dragonform" : "Id");

  it("qualifies colliding labels with the owning character, and only those", () => {
    const entries = aggregateAbilities(SKILLS, label, (s) => s.totalDamage, undefined, characterName);

    // Sorted by value descending, as before; only the colliding pair gains an owner.
    expect(entries.map((entry) => entry.label)).toEqual([
      "Normal Attack (Id)",
      "Normal Attack (Dragonform)",
      "Reginleiv",
    ]);
  });

  it("keeps labels bare when no character namer is given", () => {
    const entries = aggregateAbilities(SKILLS, label, (s) => s.totalDamage);
    expect(entries.map((entry) => entry.label)).toEqual(["Normal Attack", "Normal Attack", "Reginleiv"]);
  });
});

describe("aggregateAbilities — the collapsed entry's split", () => {
  // The card explains the row above it, so an entry that folded an echo must
  // draw the same two-segment bar the table row does. 9001 is deliberately in
  // no skill group, so these cases turn only on the collapse keying.
  const CAUSE = skill(9001, "Pl0900", 300);
  const ECHO = { ...skill(0, "Pl0900", 100), actionType: { SupplementaryDamage: 9001 } } as unknown as SkillState;
  const SKILLS = [CAUSE, ECHO];
  const label = (key: string) => key;

  it("carries the echo's share as subValue on the entry it folded into", () => {
    const entries = aggregateAbilities(
      SKILLS,
      label,
      (s) => s.totalDamage,
      undefined,
      undefined,
      rowKeyingFor(SKILLS, true)
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].value).toBe(400);
    expect(entries[0].subValue).toBe(100);
  });

  it("mounts no split on an entry that is echo all the way across", () => {
    // Collapse off, the echo is its own entry and its label already says so.
    const entries = aggregateAbilities(
      SKILLS,
      label,
      (s) => s.totalDamage,
      undefined,
      undefined,
      rowKeyingFor(SKILLS, false)
    );
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.subValue === undefined)).toBe(true);
  });
});

describe("aggregateSources — the per-player split", () => {
  const CAUSE = skill(9001, "Pl0900", 300);
  const ECHO = { ...skill(0, "Pl0900", 100), actionType: { SupplementaryDamage: 9001 } } as unknown as SkillState;
  const player = { index: 3, skillBreakdown: [CAUSE, ECHO] } as unknown as ComputedPlayerState;

  it("carries each player's own echo share, so the section matches the row it explains", () => {
    const entries = aggregateSources(
      [player],
      (p) => p.skillBreakdown,
      (index) => `P${index}`,
      () => "#fff",
      (s) => s.totalDamage
    );
    expect(entries[0].value).toBe(400);
    expect(entries[0].subValue).toBe(100);
  });
});
