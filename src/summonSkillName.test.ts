import i18n from "i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { SkillState } from "./types";
import { getSkillName } from "./utils";

/** The real lookup, against a minimal copy of the en/ui.json shape, so these
 * assert what a user actually reads in the meter rather than a key string. */
beforeAll(async () => {
  await i18n.init({
    lng: "en",
    resources: {
      en: {
        translation: {
          skills: {
            "summon-classes": { d2e5407a: "Lucilius" },
            default: { "80000": "Summon Attack/Primal Burst", "unknown-skill": "Skill {{id}}" },
            Pl1800: { "1234": "Pain Train" },
          },
        },
      },
    },
    interpolation: { escapeValue: false },
  });
});

const summonHit = (id: number, childCharacterType: SkillState["childCharacterType"]) =>
  ({ actionType: { Normal: id }, childCharacterType }) as SkillState;

describe("getSkillName for summon hits", () => {
  it("names the row after the summon whose body class dealt the hit", () => {
    expect(getSkillName("Pl1800", summonHit(80000, { Unknown: 0xd2e5407a }))).toBe("Lucilius");
  });

  it("falls back to the generic label for an unnamed body class", () => {
    // Most summons share two generic body classes, so their rows cannot be told
    // apart — the generic label is the honest answer, not a wrong summon name.
    expect(getSkillName("Pl1800", summonHit(80000, { Unknown: 0xb0792857 }))).toBe("Summon Attack/Primal Burst");
  });

  it("leaves every other action id on the normal character lookup", () => {
    expect(getSkillName("Pl1800", summonHit(1234, "Pl1800"))).toBe("Pain Train");
  });

  it("does not hijack action 80000 when the source is a known character", () => {
    // Only an unresolved (summon) child type takes the class path; a real
    // character keeps its own skill block.
    expect(getSkillName("Pl1800", summonHit(80000, "Pl1800"))).toBe("Summon Attack/Primal Burst");
  });
});
