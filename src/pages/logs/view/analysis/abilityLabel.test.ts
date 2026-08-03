import { describe, expect, it } from "vitest";

import type { CharacterType, ComputedPlayerState, SkillRow, SkillState } from "@/types";

import { abilityLabelFor } from "./abilityLabel";

/** Stands in for `getSkillName`: names an action against its owner, and reports
 * the unnamed case the way the real chain's `skills.default.unknown-skill`
 * fallback does. */
const SKILL_NAME = (characterType: CharacterType, skill: SkillRow) => {
  const action = skill.actionType;
  if (typeof action === "object" && "Group" in action) return `group:${action.Group}`;
  // The real chain resolves `skills.<character>.<id>` before anything else, so
  // with no character to key on it drops through to the unknown-skill string.
  const named = characterType !== "";
  if (action === "LinkAttack") return named ? `${characterType} Link Attack` : "Unknown skill (LinkAttack)";
  if (typeof action === "object" && "Normal" in action) {
    if (named && action.Normal === 1000) return `${characterType} Light Blast`;
    if (named && action.Normal === 2000) return `${characterType} Bolt Blast`;
    return `Unknown skill (${action.Normal})`;
  }
  return "unnamed";
};

const player = (index: number, characterType: string, actions: SkillState["actionType"][]) =>
  ({
    index,
    characterType,
    skillBreakdown: actions.map((actionType) => ({ actionType, childCharacterType: characterType })),
  }) as unknown as ComputedPlayerState;

const PARTY = [player(0, "Pl1000", [{ Normal: 1000 }, "LinkAttack"]), player(1, "Pl1400", [{ Normal: 2000 }])];

describe("abilityLabelFor", () => {
  it("names an ability against the player who used it", () => {
    expect(abilityLabelFor("Normal:1000", PARTY, SKILL_NAME)).toBe("Pl1000 Light Blast");
  });

  it("searches the whole party, not just the first player", () => {
    // The regression this exists for: the view searched the SCOPED party, which
    // holds only the pinned player, so every other player's abilities fell
    // through to the raw key.
    expect(abilityLabelFor("Normal:2000", PARTY, SKILL_NAME)).toBe("Pl1400 Bolt Blast");
  });

  it("names a bare action type", () => {
    expect(abilityLabelFor("LinkAttack", PARTY, SKILL_NAME)).toBe("Pl1000 Link Attack");
  });

  it("never leaks the wire key for an action no one in the party used", () => {
    const label = abilityLabelFor("Normal:99999", PARTY, SKILL_NAME);

    expect(label).not.toContain(":");
    expect(label).toBe("Unknown skill (99999)");
  });

  it("names an action no one used even when the party is empty", () => {
    expect(abilityLabelFor("Normal:1000", [], SKILL_NAME)).toBe("Unknown skill (1000)");
  });

  it("names a condensed group row through its group, not its raw key", () => {
    // Against the REAL table: Gran's 100 and 110 are "normal-attack". The
    // legend and the dropdown must read "Normal Attack", never "normal-attack".
    const gran = player(4, "Pl0000", [{ Normal: 100 }, { Normal: 110 }]);

    const label = abilityLabelFor('Group:normal-attack@"Pl0000"', [gran], SKILL_NAME);

    expect(label).toBe("group:normal-attack");
  });

  it("returns an unparseable key unchanged rather than inventing a name", () => {
    // A stale or hand-edited URL. Showing it back is how the user sees what is
    // wrong; the selector itself degrades to "All".
    expect(abilityLabelFor("nonsense", PARTY, SKILL_NAME)).toBe("nonsense");
  });

  it("names a colliding action against the preferred player, not the first owner", () => {
    // Action ids are shared across characters — 120 is Eustace's "Grade 1
    // Shot" and Id's "Combo Finisher (Dragonform)". With a source pinned, the
    // rows are that player's own, so the first party member to also own the id
    // must not name them.
    const collision = [player(0, "Pl1000", [{ Normal: 1000 }]), player(1, "Pl1400", [{ Normal: 1000 }])];

    expect(abilityLabelFor("Normal:1000", collision, SKILL_NAME, collision[1])).toBe("Pl1400 Light Blast");
  });

  it("falls back to the party scan when the preferred player never used the action", () => {
    const preferred = player(1, "Pl1400", [{ Normal: 2000 }]);

    expect(abilityLabelFor("Normal:1000", PARTY, SKILL_NAME, preferred)).toBe("Pl1000 Light Blast");
  });
});
