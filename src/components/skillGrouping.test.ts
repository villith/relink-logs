import { describe, expect, it, vi } from "vitest";

// The real module resolves the bundled JSON through Tauri's resource API at
// import time, which does not exist under jsdom. These are the real Pl0000 and
// Pl0700Ghost entries, trimmed.
vi.mock("@/assets/skill-groups", () => ({
  default: {
    Pl0000: { "normal-attack": { skills: [100, 110, 120, 121, 130, 131] } },
    Pl0700Ghost: { "pet-normal": { skills: [100, 65] } },
  },
}));

import type { SkillState } from "@/types";
import { PRIMAL_BURST_GROUP } from "@/utils";

import { skillGroupFor } from "./skillGrouping";

const skill = (actionType: SkillState["actionType"], childCharacterType: string): SkillState =>
  ({ actionType, childCharacterType }) as unknown as SkillState;

describe("skillGroupFor", () => {
  it("puts a character's normal attack in its normal-attack group", () => {
    // Pl0000's map lists 100, 110, 120, 121, 130, 131 under "normal-attack".
    expect(skillGroupFor(skill({ Normal: 120 }, "Pl0000"))).toEqual({
      group: "normal-attack",
      childCharacterType: "Pl0000",
    });
  });

  it("scopes the group to the child character, so a pet groups apart from its owner", () => {
    const owner = skillGroupFor(skill({ Normal: 100 }, "Pl0000"));
    const pet = skillGroupFor(skill({ Normal: 100 }, "Pl0700Ghost"));

    expect(owner?.childCharacterType).not.toBe(pet?.childCharacterType);
  });

  it("leaves an action in no group ungrouped", () => {
    // Ids in the global namespace (>= 99999) are not character skills at all.
    expect(skillGroupFor(skill({ Normal: 999999 }, "Pl0000"))).toBeNull();
  });

  it("never groups a non-Normal action", () => {
    // Link attacks, SBAs, echoes, DoT ticks and stun rows stay their own series.
    expect(skillGroupFor(skill("LinkAttack", "Pl0000"))).toBeNull();
    expect(skillGroupFor(skill("SBA", "Pl0000"))).toBeNull();
    expect(skillGroupFor(skill({ SupplementaryDamage: 1 }, "Pl0000"))).toBeNull();
    expect(skillGroupFor(skill({ DamageOverTime: 0 }, "Pl0000"))).toBeNull();
  });

  it("groups the three Primal Burst bodies together, across their classes", () => {
    // They are distinct classes sharing one action id, so no per-character map
    // can join them — they match on the body class and ignore the child.
    const burst = skillGroupFor({
      // The summon action id, dealt by a Primal Burst body class.
      actionType: { Normal: 80000 },
      childCharacterType: { Unknown: 0x5418b8f8 },
    } as unknown as SkillState);

    expect(burst).toEqual({ group: PRIMAL_BURST_GROUP, childCharacterType: null });
  });

  it("leaves an unresolved child character ungrouped rather than guessing", () => {
    expect(
      skillGroupFor({ actionType: { Normal: 120 }, childCharacterType: { Unknown: 7 } } as unknown as SkillState)
    ).toBeNull();
  });
});
