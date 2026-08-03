import i18n from "i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  resolveSkillName,
  setSkillNameResolutionMode,
  setSkillNameSources,
  stripTierSuffix,
  summonClassSource,
} from "./skillNameSources";

const SOURCES = {
  Pl0000: { "1301": { ns: "abilities" as const, hash: "967964c1", key: "AB_PL0000_05" } },
  Pl0700Ghost: { "1234": { ns: "abilities" as const, hash: "deadbeef", key: "AB_PL0700_09" } },
  "summon-classes": { "5395ce93": { ns: "summons" as const, hash: "2f15455c", key: "TXT_SMN_So9200" } },
};

beforeEach(() => setSkillNameSources(SOURCES));

describe("stripTierSuffix", () => {
  // Mirrors scripts/gen-skill-name-sources.mjs — same fixtures on purpose, so
  // the two copies of the regex cannot drift apart unnoticed.
  it("strips ASCII tier numerals", () => {
    expect(stripTierSuffix("Evyl Blackwyrm III")).toBe("Evyl Blackwyrm");
    expect(stripTierSuffix("Goblin Soldier II")).toBe("Goblin Soldier");
    expect(stripTierSuffix("Quakadile I")).toBe("Quakadile");
  });

  it("strips the full-width numeral zh-CN uses with no separating space", () => {
    expect(stripTierSuffix("黑龙伊弗欧Ⅲ")).toBe("黑龙伊弗欧");
  });

  it("normalizes while stripping", () => {
    expect(stripTierSuffix("Mechanized  Executioner III")).toBe("Mechanized Executioner");
  });

  it("keeps a trailing capital I that is part of the name", () => {
    expect(stripTierSuffix("GranblueI")).toBe("GranblueI");
  });

  it("leaves an untiered name untouched", () => {
    expect(stripTierSuffix("Lucilius")).toBe("Lucilius");
  });
});

describe("resolveSkillName", () => {
  // The point of the language-major order: a French player must read the French
  // game name for a skill only English ever hand-labelled, instead of the
  // English label leaking through i18next's per-key fallback.
  beforeAll(async () => {
    await i18n.init({
      lng: "fr",
      fallbackLng: "en",
      resources: {
        fr: {
          translation: {
            skills: { Pl0400: { "1100": "Étiquette FR" }, Pl0400Child: { "1100": "Enfant FR" } },
          },
          abilities: { aaaa1111: { text: "Pont FR 1100" }, dddd4444: { text: "Pont FR 4400" } },
        },
        en: {
          translation: {
            skills: { Pl0400: { "1100": "Label EN 1100", "2200": "Label EN 2200", "4400": "Label EN 4400" } },
          },
          abilities: {
            aaaa1111: { text: "Bridge EN 1100" },
            bbbb2222: { text: "Bridge EN 2200" },
            cccc3333: { text: "Bridge EN 3300" },
            dddd4444: { text: "Bridge EN 4400" },
          },
        },
      },
      interpolation: { escapeValue: false },
    });
  });

  beforeEach(() =>
    setSkillNameSources({
      Pl0400: {
        "1100": { ns: "abilities", hash: "aaaa1111", key: "AB_PL0400_01" },
        "2200": { ns: "abilities", hash: "bbbb2222", key: "AB_PL0400_02" },
        "3300": { ns: "abilities", hash: "cccc3333", key: "AB_PL0400_03" },
        "4400": { ns: "abilities", hash: "dddd4444", key: "AB_PL0400_04" },
      },
    })
  );

  it("prefers the current language's hand label over its bridge name", () => {
    expect(resolveSkillName(["Pl0400"], 1100)).toBe("Étiquette FR");
  });

  it("prefers the current language's bridge name over a foreign hand label", () => {
    // 4400 is hand-labelled in en only; the fr player reads the fr game name.
    expect(resolveSkillName(["Pl0400"], 4400)).toBe("Pont FR 4400");
  });

  it("prefers the fallback language's hand label over its bridge name", () => {
    expect(resolveSkillName(["Pl0400"], 2200)).toBe("Label EN 2200");
  });

  it("reaches the fallback language's bridge name last", () => {
    expect(resolveSkillName(["Pl0400"], 3300)).toBe("Bridge EN 3300");
  });

  it("checks the child block before the character block within a language", () => {
    expect(resolveSkillName(["Pl0400Child", "Pl0400"], 1100)).toBe("Enfant FR");
  });

  it("returns null when nothing names the id", () => {
    expect(resolveSkillName(["Pl0400"], 9999)).toBeNull();
  });

  it("misses a bridge-only id when the map has not loaded yet", () => {
    setSkillNameSources({});
    expect(resolveSkillName(["Pl0400"], 3300)).toBeNull();
  });

  it("resolves a regional UI language through its base-language bundles", async () => {
    // The picker ships "fr-FR" while the lang directory is "fr"; the resolve
    // hierarchy ["fr-FR", "fr", "en"] is what connects the two.
    await i18n.changeLanguage("fr-FR");
    try {
      expect(resolveSkillName(["Pl0400"], 4400)).toBe("Pont FR 4400");
    } finally {
      await i18n.changeLanguage("fr");
    }
  });

  describe("in label-first mode (the pre-language-major behavior)", () => {
    // The settings page offers the old order back: every hand label — any
    // language's, via the normal per-key fallback — before any bridge name.
    beforeEach(() => setSkillNameResolutionMode("label-first"));
    afterEach(() => setSkillNameResolutionMode("language-first"));

    it("lets a foreign hand label beat the current language's bridge name", () => {
      expect(resolveSkillName(["Pl0400"], 4400)).toBe("Label EN 4400");
    });

    it("still puts the current language's own hand label first", () => {
      expect(resolveSkillName(["Pl0400"], 1100)).toBe("Étiquette FR");
    });

    it("still reaches the bridge for an unlabelled id", () => {
      expect(resolveSkillName(["Pl0400"], 3300)).toBe("Bridge EN 3300");
    });

    it("keeps the child block ahead of the character block", () => {
      expect(resolveSkillName(["Pl0400Child", "Pl0400"], 1100)).toBe("Enfant FR");
    });
  });
});

describe("summonClassSource", () => {
  it("resolves a mapped body class hash", () => {
    expect(summonClassSource("5395ce93")).toEqual({
      ns: "summons",
      hash: "2f15455c",
      key: "TXT_SMN_So9200",
    });
  });

  it("returns null for an unmapped body class", () => {
    expect(summonClassSource("34894579")).toBeNull();
  });
});
