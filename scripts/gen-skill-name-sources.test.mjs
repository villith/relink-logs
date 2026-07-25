import { describe, expect, it } from "vitest";

import {
  buildSkillNameSources,
  normalizeName,
  pickAbilityHash,
  pickSummonHash,
  stripTierSuffix,
  validateSources,
} from "./gen-skill-name-sources.mjs";

describe("normalizeName", () => {
  it("collapses the double spaces the game data ships", () => {
    // en/summons.json really contains "Mechanized  Executioner III".
    expect(normalizeName("Mechanized  Executioner")).toBe("Mechanized Executioner");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeName("  Arrow Rain ")).toBe("Arrow Rain");
  });
});

describe("stripTierSuffix", () => {
  it("strips ASCII tier numerals", () => {
    expect(stripTierSuffix("Evyl Blackwyrm III")).toBe("Evyl Blackwyrm");
    expect(stripTierSuffix("Goblin Soldier II")).toBe("Goblin Soldier");
    expect(stripTierSuffix("Quakadile I")).toBe("Quakadile");
  });

  it("strips the full-width numeral zh-CN uses with no separating space", () => {
    // zh-CN ships "黑龙伊弗欧Ⅲ" (U+2162), not " III".
    expect(stripTierSuffix("黑龙伊弗欧Ⅲ")).toBe("黑龙伊弗欧");
  });

  it("normalizes while stripping", () => {
    expect(stripTierSuffix("Mechanized  Executioner III")).toBe("Mechanized Executioner");
  });

  it("keeps a trailing capital I that is part of the name", () => {
    // Requiring whitespace before the ASCII form is what protects this.
    expect(stripTierSuffix("GranblueI")).toBe("GranblueI");
  });

  it("leaves an untiered name untouched", () => {
    expect(stripTierSuffix("Lucilius")).toBe("Lucilius");
  });
});

/** Shaped like en/abilities.json: hash -> { key, text }. */
const ABILITIES = {
  "967964c1": { key: "AB_PL0000_05", text: "Arrow Rain" },
  "2cf1038c": { key: "AB_PL0000_05_CG", text: "Arrow Rain" },
  "9fed6cf3": { key: "AB_PL0200_01", text: "Enchanted Lands" },
  eb3e3386: { key: "AB_PL0200_01_CG", text: "Enchanted Lands" },
  38278041: { key: "AB_PL2700_04_CG", text: "Acidrage  Howl" },
  "9abfc62c": { key: "AB_PL2700_04", text: "Acidrage Howl" },
};

describe("pickAbilityHash", () => {
  it("prefers the base key over its _CG cutscene twin", () => {
    expect(pickAbilityHash("Pl0000", "Arrow Rain", ABILITIES)).toEqual({
      ns: "abilities",
      hash: "967964c1",
      key: "AB_PL0000_05",
    });
  });

  it("scopes candidates to the character, which is what makes the name unique", () => {
    // "Enchanted Lands" exists only under PL0200, so PL0000 must not claim it.
    expect(pickAbilityHash("Pl0000", "Enchanted Lands", ABILITIES)).toBeNull();
    expect(pickAbilityHash("Pl0200", "Enchanted Lands", ABILITIES)).toEqual({
      ns: "abilities",
      hash: "9fed6cf3",
      key: "AB_PL0200_01",
    });
  });

  it("matches through the double spaces in the game data", () => {
    expect(pickAbilityHash("Pl2700", "Acidrage Howl", ABILITIES)).toEqual({
      ns: "abilities",
      hash: "9abfc62c",
      key: "AB_PL2700_04",
    });
  });

  it("returns null for a label with no ability of that name", () => {
    expect(pickAbilityHash("Pl0000", "Power Strike 2", ABILITIES)).toBeNull();
  });

  it("returns null for a character block that is not a PlXXXX id", () => {
    // "default", "summon-classes" and "Pl0700Ghost" have no AB_ key space.
    expect(pickAbilityHash("default", "Arrow Rain", ABILITIES)).toBeNull();
    expect(pickAbilityHash("Pl0700Ghost", "Arrow Rain", ABILITIES)).toBeNull();
  });
});

/** en/summons.json shape. Note So3f00 exists ONLY as tiered text — 62 of the 77
 * real body classes look like this, which is why the runtime strips the suffix.
 *
 * The So ids are real, so gameXxhash32 resolves them to real class hashes:
 *   So0000 -> d2e5407a, So9200 -> 5395ce93, So3f00 -> c3e77085, So0d00 -> 69893920
 */
const SUMMONS_EN = {
  "0033943a": { key: "TXT_SMN_So3f00_3", text: "Evyl Blackwyrm III" },
  aaaa0002: { key: "TXT_SMN_So3f00_2", text: "Evyl Blackwyrm II" },
  "2f15455c": { key: "TXT_SMN_So9200", text: "Beelzebub" },
  a7eff558: { key: "TXT_SMN_So9200", text: "Beelzebub" },
  cccc0001: { key: "TXT_SMN_So4100_3", text: "Mechanized  Executioner III" },
  dddd0001: { key: "TXT_SMN_So5000", text: "Drift Apart" },
  eeee0001: { key: "TXT_SMN_So0d00_1", text: "Goblin Soldier I" },
};

const SUMMONS_BY_LANG = {
  en: SUMMONS_EN,
  jp: {
    "0033943a": { key: "TXT_SMN_So3f00_3", text: "黒竜イーヴィル III" },
    aaaa0002: { key: "TXT_SMN_So3f00_2", text: "黒竜イーヴィル II" },
    "2f15455c": { key: "TXT_SMN_So9200", text: "ベルゼバブ" },
    a7eff558: { key: "TXT_SMN_So9200", text: "ベルゼバブ" },
    cccc0001: { key: "TXT_SMN_So4100_3", text: "断罪の鉄機 III" },
    dddd0001: { key: "TXT_SMN_So5000", text: "すれ違い" },
  },
};

const ENEMIES_EN = {
  ca4091c8: { key: "EM0004", text: "Goblin Soldier" },
  // Only in enemies.json, mirroring the real Lilith body class.
  b39eeab5: { key: "EM2400", text: "Lilith" },
};

describe("pickSummonHash", () => {
  it("resolves a class by hashing So ids, not by matching the ui.json name", () => {
    // c3e77085 == gameXxhash32("So3f00"). The label is deliberately wrong here:
    // identity must win, because two different summons can share a display name.
    expect(pickSummonHash("c3e77085", "A Totally Wrong Label", SUMMONS_EN, ENEMIES_EN, SUMMONS_BY_LANG)).toEqual({
      ns: "summons",
      hash: "0033943a",
      key: "TXT_SMN_So3f00_3",
      via: "id",
    });
  });

  it("breaks a duplicate-key tie on the smaller hash", () => {
    // TXT_SMN_So9200 really ships at two hashes with identical text.
    expect(pickSummonHash("5395ce93", "Beelzebub", SUMMONS_EN, ENEMIES_EN, SUMMONS_BY_LANG)).toEqual({
      ns: "summons",
      hash: "2f15455c",
      key: "TXT_SMN_So9200",
      via: "id",
    });
  });

  it("prefers a suffix-free entry over a tiered one for the same So id", () => {
    const summons = { ...SUMMONS_EN, bbbb0000: { key: "TXT_SMN_So3f00", text: "Evyl Blackwyrm" } };

    expect(pickSummonHash("c3e77085", "Evyl Blackwyrm", summons, ENEMIES_EN, { en: summons })).toEqual({
      ns: "summons",
      hash: "bbbb0000",
      key: "TXT_SMN_So3f00",
      via: "id",
    });
  });

  it("skips a duplicate-key set whose text disagrees in another language", () => {
    // Two hashes under one key are only interchangeable if they stay so after
    // translation.
    const byLang = {
      en: SUMMONS_EN,
      jp: { ...SUMMONS_BY_LANG.jp, a7eff558: { key: "TXT_SMN_So9200", text: "別の名前" } },
    };

    expect(pickSummonHash("5395ce93", "Beelzebub", SUMMONS_EN, ENEMIES_EN, byLang)).toBeNull();
  });

  it("falls back to a name match when no So id hashes to the class", () => {
    // Real case: the Cat and Lilith bodies are not So#### summons, so identity
    // cannot resolve them. Their name matches an enemy, whose text agrees with
    // the summon of the same name in every language.
    expect(pickSummonHash("ffffffff", "Lilith", SUMMONS_EN, ENEMIES_EN, SUMMONS_BY_LANG)).toEqual({
      ns: "enemies",
      hash: "b39eeab5",
      key: "EM2400",
      via: "name",
    });
  });

  it("returns null when the name fallback finds an entry missing from another language", () => {
    // A hash absent from a shipped bundle cannot be relied on to translate.
    expect(pickSummonHash("ffffffff", "Goblin Soldier", SUMMONS_EN, ENEMIES_EN, SUMMONS_BY_LANG)).toBeNull();
  });

  it("matches the name fallback through the double spaces in the game data", () => {
    expect(pickSummonHash("ffffffff", "Mechanized Executioner", SUMMONS_EN, ENEMIES_EN, SUMMONS_BY_LANG)).toEqual({
      ns: "summons",
      hash: "cccc0001",
      key: "TXT_SMN_So4100_3",
      via: "name",
    });
  });

  it("returns null for a hand-coined name in no lang file", () => {
    expect(pickSummonHash("ffffffff", "Silverslime/Goldslime", SUMMONS_EN, ENEMIES_EN, SUMMONS_BY_LANG)).toBeNull();
  });
});

const UI = {
  skills: {
    Pl0000: { 1301: "Arrow Rain", 100: "Attack 1" },
    Pl0200: { 1: "Enchanted Lands" },
    "summon-classes": { "5395ce93": "Beelzebub", 34894579: "Silverslime/Goldslime" },
    default: { 700: "Guard (?)" },
  },
};

const GENERATED = {
  abilities: ABILITIES,
  summons: SUMMONS_EN,
  enemies: ENEMIES_EN,
  summonsByLang: SUMMONS_BY_LANG,
};

describe("buildSkillNameSources", () => {
  it("maps ability rows under their character block", () => {
    const { sources } = buildSkillNameSources(UI, GENERATED);

    expect(sources.Pl0000).toEqual({
      1301: { ns: "abilities", hash: "967964c1", key: "AB_PL0000_05" },
    });
    expect(sources.Pl0200).toEqual({
      1: { ns: "abilities", hash: "9fed6cf3", key: "AB_PL0200_01" },
    });
  });

  it("maps summon classes under summon-classes", () => {
    const { sources } = buildSkillNameSources(UI, GENERATED);

    expect(sources["summon-classes"]).toEqual({
      "5395ce93": { ns: "summons", hash: "2f15455c", key: "TXT_SMN_So9200", via: "id" },
    });
  });

  it("omits blocks that mapped nothing rather than leaving them empty", () => {
    const { sources } = buildSkillNameSources(UI, GENERATED);

    expect(sources.default).toBeUndefined();
  });

  it("reports every leaf it could not map, so nothing is silently dropped", () => {
    const { report } = buildSkillNameSources(UI, GENERATED);

    expect(report.mapped).toBe(3);
    expect(report.unmapped).toEqual([
      { block: "Pl0000", id: "100", label: "Attack 1" },
      { block: "default", id: "700", label: "Guard (?)" },
      { block: "summon-classes", id: "34894579", label: "Silverslime/Goldslime" },
    ]);
  });

  it("produces deterministic key order so the artifact diffs cleanly", () => {
    const a = JSON.stringify(buildSkillNameSources(UI, GENERATED).sources);
    const b = JSON.stringify(buildSkillNameSources(UI, GENERATED).sources);

    expect(a).toBe(b);
  });
});

const SOURCES = {
  Pl0000: { 1301: { ns: "abilities", hash: "967964c1", key: "AB_PL0000_05" } },
  "summon-classes": { "5395ce93": { ns: "summons", hash: "2f15455c", key: "TXT_SMN_So9200" } },
};

describe("validateSources", () => {
  it("passes a map whose hashes all resolve and whose ui.json holds no duplicates", () => {
    expect(validateSources(SOURCES, GENERATED, { en: { skills: { Pl0000: { 100: "Attack 1" } } } })).toEqual([]);
  });

  it("flags a hash a game patch removed", () => {
    const generated = { ...GENERATED, abilities: {} };
    const errors = validateSources(SOURCES, generated, {});

    expect(errors).toEqual([
      "Pl0000.1301 -> abilities:967964c1 (AB_PL0000_05) no longer resolves; a game patch may have renamed it",
    ]);
  });

  it("flags a hash whose text went empty", () => {
    const generated = { ...GENERATED, abilities: { "967964c1": { key: "AB_PL0000_05", text: "" } } };
    const errors = validateSources(SOURCES, generated, {});

    expect(errors).toEqual([
      "Pl0000.1301 -> abilities:967964c1 (AB_PL0000_05) no longer resolves; a game patch may have renamed it",
    ]);
  });

  it("flags a ui.json that re-introduced a mapped label", () => {
    const uiByLang = { ko: { skills: { Pl0000: { 1301: "애로우 레인" } } } };
    const errors = validateSources(SOURCES, GENERATED, uiByLang);

    expect(errors).toEqual(["ko/ui.json duplicates mapped entry skills.Pl0000.1301; delete it or drop the mapping"]);
  });
});
