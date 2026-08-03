import i18n from "i18next";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { setSkillNameResolutionMode, setSkillNameSources } from "./skillNameSources";
import { causeSkillName } from "./utils";

beforeAll(async () => {
  await i18n.init({
    lng: "en",
    fallbackLng: "en",
    resources: {
      fr: {
        translation: {},
        abilities: { ab127001: { text: "Mise à mort" } },
      },
      en: {
        translation: {
          skills: {
            Pl2000: { "1100": "Scourge (Dragonform)" },
            Pl2700: { "1000": "Slow Kill (Uncharged - Melee)", "1600": "Flamek Thunder (Uncharged)" },
            Pl2800: { "20000": "Stacks" },
            // The DAMAGE id space's shared table. Deliberately not consulted
            // for causes: its entries name actions, and 99999 the action is
            // "Conflux Effect" while 99999 the cause provably is not (Shield
            // arrives under it in quests with no conflux at all).
            default: { "99999": "Conflux Effect", "800": "Chain Burst" },
          },
          causes: {
            default: { "9999": "Sigil/Trait Effect", "800": "Chain Burst" },
          },
        },
        abilities: { ab127001: { text: "Slow Kill" } },
      },
    },
    interpolation: { escapeValue: false },
  });
});

describe("causeSkillName", () => {
  it("resolves a cause through a candidate's own skill table", () => {
    expect(causeSkillName(["Pl2000"], 1100)).toBe("Scourge (Dragonform)");
  });

  it("resolves through whichever candidate owns the id", () => {
    // The party scan: the row does not retain its applier, so every party
    // character (and sub-actor) table is tried in order.
    expect(causeSkillName(["Pl0400", "Pl2000"], 1100)).toBe("Scourge (Dragonform)");
  });

  it("falls back to the decade base for a computed or variant cause", () => {
    // The game numbers variants within a decade (1600/1601/1602 are all
    // Flamek Thunder charge levels) and stamps computed causes as base+n
    // (Fraux stores stance stacks as 20000+count, so live 20002 = 2 stacks).
    expect(causeSkillName(["Pl2700"], 1602)).toBe("Flamek Thunder (Uncharged)");
    expect(causeSkillName(["Pl2800"], 20002)).toBe("Stacks");
  });

  it("does not fall back past the decade", () => {
    // 1110 is NOT a variant of 1100 — a hundreds-floor would cross into a
    // different action (and a different party member's band: Eustace's 1110
    // record vs Id's 1100 Scourge). The number is the honest answer.
    expect(causeSkillName(["Pl2700", "Pl2000"], 1110)).toBe("");
  });

  it("names the global bands through causes.default", () => {
    expect(causeSkillName(["Pl2000"], 9999)).toBe("Sigil/Trait Effect");
    expect(causeSkillName([], 800)).toBe("Chain Burst");
  });

  it("never names a cause from the damage id space's shared table", () => {
    // skills.default names ACTIONS. The two spaces only coincide inside one
    // character's own band; the shared table's ids are damage-side facts
    // (99999 the action is a conflux effect), and Shield arrived under cause
    // 99999 in quests with no conflux — a wrong name, where the number is
    // merely an unresolved one.
    expect(causeSkillName([], 99999)).toBe("");
  });

  it("answers empty when nothing names the cause", () => {
    expect(causeSkillName(["Pl2000"], 3300)).toBe("");
  });
});

describe("causeSkillName across languages (language-first mode)", () => {
  beforeAll(() => {
    // Pl2700's 1000 carries BOTH an en hand label (above) and a bridge entry —
    // the coexistence the language-major order resolves per language. The mode
    // is an opt-in: label-first is the shipped default.
    setSkillNameResolutionMode("language-first");
    setSkillNameSources({
      Pl2700: { "1000": { ns: "abilities", hash: "ab127001", key: "AB_PL2700_01" } },
    });
  });

  afterAll(() => setSkillNameResolutionMode("label-first"));

  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("prefers the current language's bridge name over a foreign hand label", async () => {
    await i18n.changeLanguage("fr");
    expect(causeSkillName(["Pl2700"], 1000)).toBe("Mise à mort");
  });

  it("keeps the en hand label first while en is the language", () => {
    expect(causeSkillName(["Pl2700"], 1000)).toBe("Slow Kill (Uncharged - Melee)");
  });

  it("carries the language-major order through the decade retry", async () => {
    await i18n.changeLanguage("fr");
    expect(causeSkillName(["Pl2700"], 1003)).toBe("Mise à mort");
  });
});
