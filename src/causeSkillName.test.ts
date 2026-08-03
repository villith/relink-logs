import i18n from "i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { causeSkillName } from "./utils";

beforeAll(async () => {
  await i18n.init({
    lng: "en",
    resources: {
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
