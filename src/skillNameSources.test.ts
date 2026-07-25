import { beforeEach, describe, expect, it } from "vitest";

import { abilitySourceKeys, setSkillNameSources, stripTierSuffix, summonClassSource } from "./skillNameSources";

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

describe("abilitySourceKeys", () => {
  it("builds the i18next key for a mapped action id", () => {
    expect(abilitySourceKeys("Pl0000", "Pl0000", 1301)).toEqual(["abilities:967964c1.text"]);
  });

  it("prefers the child character's block, then the parent's", () => {
    // A summon or alternate body reports its own child type; that block wins.
    expect(abilitySourceKeys("Pl0700", "Pl0700Ghost", 1234)).toEqual(["abilities:deadbeef.text"]);
  });

  it("returns nothing for an unmapped action id", () => {
    expect(abilitySourceKeys("Pl0000", "Pl0000", 100)).toEqual([]);
  });

  it("returns nothing when the map has not loaded yet", () => {
    setSkillNameSources({});
    expect(abilitySourceKeys("Pl0000", "Pl0000", 1301)).toEqual([]);
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
