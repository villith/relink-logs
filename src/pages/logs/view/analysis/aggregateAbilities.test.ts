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

import type { CharacterType, SkillState } from "@/types";

import { aggregateAbilities } from "./cardSections";

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
