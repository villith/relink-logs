import i18n from "i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { setSkillNameSources } from "./skillNameSources";
import { SkillState } from "./types";
import { getSkillName } from "./utils";

/** The real lookup, against a minimal copy of the en/ui.json shape plus the
 * generated bundles the bridge map points into, so these assert what a user
 * actually reads in the meter rather than a key string. */
beforeAll(async () => {
  setSkillNameSources({
    // 1700 has no ui.json label — only the map can name it.
    Pl1800: { "1700": { ns: "abilities", hash: "ed1219cc", key: "AB_PL1800_07" } },
    "summon-classes": {
      // d2e5407a is ALSO named in ui.json below, a leftover the map now overrules.
      d2e5407a: { ns: "summons", hash: "cccc3333", key: "TXT_SMN_So9800" },
      "5395ce93": { ns: "summons", hash: "aaaa1111", key: "TXT_SMN_So9900" },
      // A class hash with a leading zero (So5f01), which only resolves if the
      // lookup zero-pads to eight digits.
      "0f617ff0": { ns: "summons", hash: "bbbb2222", key: "TXT_SMN_So5f00" },
    },
  });

  await i18n.init({
    lng: "en",
    resources: {
      en: {
        translation: {
          skills: {
            "summon-classes": { d2e5407a: "Stale Hand Label" },
            default: { "80000": "Summon Attack/Primal Burst", "unknown-skill": "Skill {{id}}" },
            Pl1800: { "1234": "Pain Train" },
          },
        },
        abilities: { ed1219cc: { key: "AB_PL1800_07", text: "Alexandria" } },
        summons: {
          aaaa1111: { key: "TXT_SMN_So9900", text: "Beelzebub III" },
          bbbb2222: { key: "TXT_SMN_So5f00", text: "Cat" },
          cccc3333: { key: "TXT_SMN_So9800", text: "Lucilius II" },
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

describe("getSkillName via the bridge map", () => {
  const hit = (id: number) => summonHit(id, "Pl1800");

  it("names a mapped action id from the generated abilities bundle", () => {
    // Nothing in ui.json names 1700; the map points it at AB_PL1800_07.
    expect(getSkillName("Pl1800", hit(1700))).toBe("Alexandria");
  });

  it("lets a ui.json label win over the mapped ability name", () => {
    // Hand-authored labels are reverse-engineered and intentionally differ from
    // the game's own wording, so they sit ahead of the generated bundle.
    expect(getSkillName("Pl1800", hit(1234))).toBe("Pain Train");
  });

  it("falls back to the unknown-skill label when nothing maps", () => {
    expect(getSkillName("Pl1800", hit(4321))).toBe("Skill 4321");
  });
});

describe("getSkillName for mapped summon body classes", () => {
  const bodyHit = (bodyHash: number) => summonHit(80000, { Unknown: bodyHash });

  it("names the row from the generated summons bundle, tier suffix stripped", () => {
    // The bundle says "Beelzebub III"; one body class covers every tier, so the
    // row must read "Beelzebub".
    expect(getSkillName("Pl1800", bodyHit(0x5395ce93))).toBe("Beelzebub");
  });

  it("ignores a leftover ui.json label for a mapped class", () => {
    // ui.json used to hand-name summon classes and won over the map. Those names
    // are gone from every shipped ui.json, so a stray entry is stale data, not an
    // override: d2e5407a is labelled "Stale Hand Label" there and must not win.
    expect(getSkillName("Pl1800", bodyHit(0xd2e5407a))).toBe("Lucilius");
  });

  it("zero-pads the class hash, so a leading-zero class still resolves", () => {
    // So5f01 = 0x0f617ff0; dropping the leading zero silently misses the map and
    // the row falls back to the generic label.
    expect(getSkillName("Pl1800", bodyHit(0x0f617ff0))).toBe("Cat");
  });
});
