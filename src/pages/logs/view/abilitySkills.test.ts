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

import type { SkillRow, SkillState } from "@/types";

import { parseAbilityKey } from "./abilityKey";
import {
  abilityRowKey,
  actionsForPin,
  childOfPin,
  groupSkillsForRows,
  mergeSkillsByAction,
  rowKeyingFor,
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

  /** THE ECHO EXPANSION. The parser folds every echo onto ONE breakdown row, so
   * that row carries a single payload out of the dozens behind it. Expanding the
   * pin from the row alone filtered to that one payload and reported a quarter
   * of the row's damage as its whole (live: 105.7m/41 hits against a row of
   * 430.3m/260). The facts carry every payload, which is what completes it. */
  it("expands an echo pin to every payload behind the row, not just the folded one", () => {
    const rowAndFacts = [
      skill({ SupplementaryDamage: 1000 }),
      skill({ SupplementaryDamage: 1 }),
      skill({ SupplementaryDamage: 2 }),
      skill({ Normal: 100 }),
    ];

    expect(actionsForPin(abilityRowKey(rowAndFacts[0]), rowAndFacts)).toEqual([
      { SupplementaryDamage: 1000 },
      { SupplementaryDamage: 1 },
      { SupplementaryDamage: 2 },
    ]);
  });
});

describe("abilityRowKey — supplementary damage", () => {
  /** The parser emits one breakdown row per echo payload, so this fold is the
   * only thing keeping the whole family on one display row. Without it the
   * ability selector lists one entry per payload — all of them reading
   * "Supplementary Damage" and each pinning a slice of the row they appear to
   * name. This block is also the toggle-OFF parity proof: adding collapse
   * keying must leave every assertion here green. */
  it("folds every payload onto one row key", () => {
    const keys = [
      abilityRowKey(skill({ SupplementaryDamage: 0 })),
      abilityRowKey(skill({ SupplementaryDamage: 1 })),
      abilityRowKey(skill({ SupplementaryDamage: 1000 })),
    ];

    expect(new Set(keys).size).toBe(1);
  });

  it("folds across bodies too, since an echo belongs to no body class", () => {
    expect(abilityRowKey(skill({ SupplementaryDamage: 1 }, "Pl1900"))).toBe(
      abilityRowKey(skill({ SupplementaryDamage: 7 }, "Pl2000"))
    );
  });

  it("keeps the key parseable, so the pin still names itself", () => {
    // `getSkillName` names an echo from the variant alone, so a canonical
    // payload reads exactly as the table row does.
    expect(parseAbilityKey(abilityRowKey(skill({ SupplementaryDamage: 42 })))).toEqual({ SupplementaryDamage: 0 });
  });

  it("does not fold anything else onto the echo row", () => {
    expect(abilityRowKey(skill({ DamageOverTime: 0 }))).not.toBe(abilityRowKey(skill({ SupplementaryDamage: 0 })));
  });
});

describe("abilityRowKey — collapse keying", () => {
  const skills: SkillRow[] = [
    { actionType: { Normal: 100 }, childCharacterType: "Pl1900" },
    { actionType: { SupplementaryDamage: 100 }, childCharacterType: "Pl1900" },
    { actionType: { SupplementaryDamage: 999 }, childCharacterType: "Pl1900" },
  ];

  it("keeps every echo on the echo row without keying", () => {
    const keying = rowKeyingFor(skills, false);
    expect(abilityRowKey(skills[1], keying)).toBe(abilityRowKey(skills[2], keying));
    expect(abilityRowKey(skills[1], keying)).not.toBe(abilityRowKey(skills[0], keying));
  });

  it("puts an echo on its causing skill's row when collapsing", () => {
    const keying = rowKeyingFor(skills, true);
    expect(abilityRowKey(skills[1], keying)).toBe(abilityRowKey(skills[0], keying));
  });

  it("keeps an echo whose cause the party never used on the echo row", () => {
    const keying = rowKeyingFor(skills, true);
    // 999 names no action in `skills`, so there is no row to move it to.
    expect(abilityRowKey(skills[2], keying)).toBe(abilityRowKey(skills[2], rowKeyingFor(skills, false)));
  });

  it("is unchanged from the no-keying behaviour when keying is absent", () => {
    expect(abilityRowKey(skills[1])).toBe(abilityRowKey(skills[1], rowKeyingFor(skills, false)));
  });
});

describe("childOfPin", () => {
  it("reads the child character out of a group pin", () => {
    expect(childOfPin('Group:normal-attack@"Pl0900"')).toBe("Pl0900");
  });

  it("reads an Unknown-body child as its object form", () => {
    expect(childOfPin('Group:some-group@{"Unknown":123}')).toEqual({ Unknown: 123 });
  });

  it("answers null for a raw action key", () => {
    expect(childOfPin("Normal:100")).toBeNull();
    expect(childOfPin("LinkAttack")).toBeNull();
  });

  it("answers null for a group that spans bodies", () => {
    // The ANY_CHILD sentinel — only Primal Burst, whose classes share one id.
    expect(childOfPin("Group:some-group@*")).toBeNull();
  });

  it("answers null rather than throwing on anything malformed", () => {
    expect(childOfPin("Group:normal-attack@notjson")).toBeNull();
    expect(childOfPin("nonsense")).toBeNull();
  });
});
