import { describe, expect, it, vi } from "vitest";

// Resolved through Tauri's resource API at import time, which jsdom has not.
// These are the real entries, trimmed: Id (Pl1900) and his dragon form (Pl2000)
// really do share three group names, which is what forces the child into the key.
vi.mock("@/assets/skill-groups", () => ({
  default: {
    Pl0000: { "normal-attack": { skills: [100, 110, 120] }, "power-raise": { skills: [200, 201] } },
    Pl1900: { "normal-attack": { skills: [100, 110] } },
    Pl2000: { "normal-attack": { skills: [300, 310] } },
  },
}));

import type { SkillState } from "@/types";

import {
  abilityRowKey,
  actionsForPin,
  groupSkillsForRows,
  mergeSkillsByAction,
  skillsForAbilityKey,
} from "./abilitySkills";

const skill = (actionType: SkillState["actionType"], childCharacterType = "Pl0000"): SkillState =>
  ({ actionType, childCharacterType, totalDamage: 0, hits: 0 }) as unknown as SkillState;

describe("abilityRowKey", () => {
  it("keys a grouped skill by its group AND its child character", () => {
    // Id's own normal attack and his dragon form's are two rows, both called
    // "Normal Attack" — without the child they would collapse into one and
    // pinning either would select the other's damage too.
    const own = abilityRowKey(skill({ Normal: 100 }, "Pl1900"));
    const dragon = abilityRowKey(skill({ Normal: 300 }, "Pl2000"));

    expect(own).not.toBe(dragon);
    expect(own).toContain("normal-attack");
    expect(dragon).toContain("normal-attack");
  });

  it("keys an ungrouped skill by its action alone, so duplicates still merge", () => {
    // The parser emits one row per (action, child), so a player and their summon
    // sharing an action id are two rows of ONE ability.
    expect(abilityRowKey(skill("LinkAttack", "Pl0000"))).toBe(abilityRowKey(skill("LinkAttack", "Wp0000")));
  });
});

describe("groupSkillsForRows", () => {
  it("collapses a group's members into one row", () => {
    const rows = groupSkillsForRows([skill({ Normal: 100 }), skill({ Normal: 110 }), skill({ Normal: 200 })]);

    expect(rows).toHaveLength(2);
    expect(rows[0].skills).toHaveLength(2);
  });

  it("keeps an ungrouped action as its own row", () => {
    const rows = groupSkillsForRows([skill({ Normal: 100 }), skill("SBA")]);

    expect(rows).toHaveLength(2);
  });

  it("keeps first-seen order, so a caller's own sort decides the rest", () => {
    const rows = groupSkillsForRows([skill("SBA"), skill({ Normal: 100 })]);

    expect(rows[0].key).toBe("SBA");
  });
});

describe("mergeSkillsByAction", () => {
  it("keeps a group's members apart instead of folding them", () => {
    // 100 and 110 are both "normal-attack". The abilities level condenses them;
    // this level is where you find out what is inside.
    const rows = mergeSkillsByAction([skill({ Normal: 100 }), skill({ Normal: 110 })]);

    expect(rows.map((row) => row.key)).toEqual(["Normal:100", "Normal:110"]);
  });

  it("merges one action dealt by a player and their summon into one row", () => {
    // The parser emits one breakdown row per (action, child), so a player and
    // their summon sharing an action id are two rows of a single skill — the
    // rule 68e148c established for the hover card.
    const rows = mergeSkillsByAction([skill({ Normal: 100 }), skill({ Normal: 100 }, "Wp0000")]);

    expect(rows).toHaveLength(1);
    expect(rows[0].skills).toHaveLength(2);
  });

  it("keeps first-seen order", () => {
    const rows = mergeSkillsByAction([skill({ Normal: 110 }), skill({ Normal: 100 })]);

    expect(rows.map((row) => row.key)).toEqual(["Normal:110", "Normal:100"]);
  });

  it("returns nothing for an empty breakdown", () => {
    expect(mergeSkillsByAction([])).toEqual([]);
  });
});

describe("skillsForAbilityKey", () => {
  it("finds every skill behind a group row", () => {
    const skills = [skill({ Normal: 100 }), skill({ Normal: 110 }), skill({ Normal: 200 })];
    const key = abilityRowKey(skills[0]);

    expect(skillsForAbilityKey(skills, key)).toHaveLength(2);
  });

  it("finds every skill behind a raw ability row", () => {
    const skills = [skill("LinkAttack", "Pl0000"), skill("LinkAttack", "Wp0000"), skill("SBA")];

    expect(skillsForAbilityKey(skills, "LinkAttack")).toHaveLength(2);
  });
});

describe("actionsForPin", () => {
  it("expands a pinned group into the raw actions the player actually used", () => {
    // The backend filters on raw action ids and knows nothing about groups, so
    // the pin is expanded here rather than teaching the parser the table.
    const skills = [skill({ Normal: 100 }), skill({ Normal: 110 }), skill({ Normal: 200 })];

    expect(actionsForPin(abilityRowKey(skills[0]), skills)).toEqual([{ Normal: 100 }, { Normal: 110 }]);
  });

  it("expands only what was used, not every id the table lists", () => {
    // 120 is in the group but this player never used it; sending it would widen
    // the filter for no reason.
    const skills = [skill({ Normal: 100 })];

    expect(actionsForPin(abilityRowKey(skills[0]), skills)).toEqual([{ Normal: 100 }]);
  });

  it("expands a raw ability pin to that one action", () => {
    expect(actionsForPin("LinkAttack", [skill("LinkAttack")])).toEqual(["LinkAttack"]);
  });

  it("falls back to the parsed key when the party has no such skill", () => {
    // A stale or hand-edited URL: an empty list would read as "all abilities"
    // at the backend and silently drop the filter.
    expect(actionsForPin("Normal:9999", [])).toEqual([{ Normal: 9999 }]);
  });
});
