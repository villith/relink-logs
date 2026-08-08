import { describe, expect, it } from "vitest";

import { abilitySlotsOf, actionNameKey } from "./ability-actions.mjs";

/** One `ActionInfo` row as `pl####_action.msg` decodes it: every field a
 * string, absent fields simply missing. */
const row = (id, fields = {}) => ({
  id_: String(id),
  abilityTag_: "",
  relatedAbilityType_: "16",
  derivedId_: "0",
  actionName_: "",
  ...fields,
});

describe("abilitySlotsOf", () => {
  it("reads a base ability action's slot from relatedAbilityType_", () => {
    // Vane's counter (pl2700 1300), tagged AB_PL2700_04 with relatedAbilityType 3.
    const slots = abilitySlotsOf([row(1300, { abilityTag_: "AB_PL2700_04", relatedAbilityType_: "3" })]);

    expect(slots.get(1300)).toBe("04");
  });

  it("prefers relatedAbilityType_ over a tag that contradicts it", () => {
    // Gran's Miserable Mist levels (pl0000 1601) carry Decimate's tag —
    // dev copy-paste junk — while relatedAbilityType_ still names slot 06.
    const slots = abilitySlotsOf([row(1601, { abilityTag_: "AB_PL0000_01", relatedAbilityType_: "5" })]);

    expect(slots.get(1601)).toBe("06");
  });

  it("falls back to the tag when the action claims no ability ordinal", () => {
    // Cagliostro's Mimic Doll (pl1800 10000): relatedAbilityType_ 16, but the
    // tag is the real one.
    const slots = abilitySlotsOf([row(10000, { abilityTag_: "AB_PL1800_01" })]);

    expect(slots.get(10000)).toBe("01");
  });

  it("inherits the base action's slot through derivedId_", () => {
    // Vane's successful counter (pl2700 1310) is untagged and unnamed; only
    // derivedId_ ties it to the counter it follows.
    const slots = abilitySlotsOf([
      row(1300, { abilityTag_: "AB_PL2700_04", relatedAbilityType_: "3" }),
      row(1310, { derivedId_: "1300" }),
    ]);

    expect(slots.get(1310)).toBe("04");
  });

  it("lets an inherited slot beat the base row's own junk tag", () => {
    // pl0000 1610 carries BOTH the junk tag and relatedAbilityType_ 16, so
    // only the derivation reaches the right ability.
    const slots = abilitySlotsOf([
      row(1600, { abilityTag_: "AB_PL0000_06", relatedAbilityType_: "5" }),
      row(1610, { abilityTag_: "AB_PL0000_01", derivedId_: "1600" }),
    ]);

    expect(slots.get(1610)).toBe("06");
  });

  it("follows a derivation chain to the ability at its root", () => {
    const slots = abilitySlotsOf([
      row(1000, { abilityTag_: "AB_PL0400_07", relatedAbilityType_: "6" }),
      row(1001, { derivedId_: "1000" }),
      row(1002, { derivedId_: "1001" }),
    ]);

    expect(slots.get(1002)).toBe("07");
  });

  it("leaves an action that is not an ability cast unresolved", () => {
    // Percival's charged attack (pl1000 200): no tag, no ordinal, no base.
    // `undefined` is data — the game ships no ability art for it.
    const slots = abilitySlotsOf([row(200, { actionName_: "△攻撃溜め左足前" })]);

    expect(slots.has(200)).toBe(false);
  });

  it("ignores a tag for another id space", () => {
    const slots = abilitySlotsOf([row(500, { abilityTag_: "SOMETHING_ELSE" })]);

    expect(slots.has(500)).toBe(false);
  });

  it("terminates on a derivation cycle", () => {
    const slots = abilitySlotsOf([row(10, { derivedId_: "20" }), row(20, { derivedId_: "10" })]);

    expect(slots.size).toBe(0);
  });
});

describe("actionNameKey", () => {
  it("matches names that differ only by the interpunct", () => {
    // Id's Ragnarok Form is "ラグナロク・フォーム" in human form and
    // "ラグナロクフォーム" in dragonform — one ability, two spellings.
    expect(actionNameKey("ラグナロク・フォーム")).toBe(actionNameKey("ラグナロクフォーム"));
  });

  it("drops the bracketed 【アビリティ】 prefix", () => {
    expect(actionNameKey("【アビリティ】ツェアライセン")).toBe(actionNameKey("ツェアライセン"));
  });

  it("drops full-width and ASCII whitespace", () => {
    expect(actionNameKey("アローレイン　分岐")).toBe(actionNameKey("アローレイン 分岐"));
  });

  it("answers empty for a name that is only decoration", () => {
    expect(actionNameKey("【アビリティ】")).toBe("");
    expect(actionNameKey(undefined)).toBe("");
  });
});
