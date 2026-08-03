import i18n from "i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { setSkillNameSources } from "./skillNameSources";
import { SkillState } from "./types";
import { getSkillName } from "./utils";

/** The language-major order end-to-end: a French player reads French game
 * names even for actions only English ever hand-labelled, while a language's
 * own hand label still wins inside that language. */
beforeAll(async () => {
  setSkillNameSources({
    Pl0400: {
      "7000": { ns: "abilities", hash: "ab040004", key: "AB_PL0400_04" },
      "8000": { ns: "abilities", hash: "ab040003", key: "AB_PL0400_03" },
    },
  });

  await i18n.init({
    lng: "fr",
    fallbackLng: "en",
    resources: {
      fr: {
        translation: { skills: { Pl0400: { "6000": "Concentration FR" } } },
        abilities: { ab040004: { text: "Puits de gravité" } },
      },
      en: {
        translation: {
          skills: {
            // 7000 carries both an en hand label and a bridge entry — the
            // coexistence the language-major order exists for.
            Pl0400: { "6000": "Concentration", "7000": "Gravity Well (Charged)" },
            default: { "unknown-skill": "Skill {{id}}" },
          },
        },
        abilities: { ab040004: { text: "Gravity Well" }, ab040003: { text: "Lightning" } },
      },
    },
    interpolation: { escapeValue: false },
  });
});

const hit = (id: number) => ({ actionType: { Normal: id }, childCharacterType: "Pl0400" }) as SkillState;

describe("getSkillName language-major resolution", () => {
  it("keeps the current language's own hand label first", () => {
    expect(getSkillName("Pl0400", hit(6000))).toBe("Concentration FR");
  });

  it("prefers the current language's bridge name over a foreign hand label", () => {
    expect(getSkillName("Pl0400", hit(7000))).toBe("Puits de gravité");
  });

  it("uses the fallback language's bridge name when nothing else resolves", () => {
    expect(getSkillName("Pl0400", hit(8000))).toBe("Lightning");
  });

  it("still interpolates the unknown-skill fallback", () => {
    expect(getSkillName("Pl0400", hit(4321))).toBe("Skill 4321");
  });
});
