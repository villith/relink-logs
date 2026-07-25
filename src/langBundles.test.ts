import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";

import enAbilities from "../src-tauri/lang/en/abilities.json";
import enSigils from "../src-tauri/lang/en/sigils.json";
import enTraits from "../src-tauri/lang/en/traits.json";
import enUi from "../src-tauri/lang/en/ui.json";
import { translateAbilityId, translateSigilId, translateTraitId } from "./utils";

/// Guards the shipped en lang bundles against the ids the hook actually reports.
/// An id's runtime value is its .tbl Key hash, which usually — but not always —
/// mirrors the TXT_ text row the name comes from: rows that share another row's
/// display name have a Key of their own but no TXT_ row of their own. A bundle
/// built from the text rows alone misses exactly those ids.
describe("lang bundles", () => {
  beforeAll(async () => {
    await i18next.init({
      lng: "en",
      defaultNS: "ui",
      resources: { en: { ui: enUi, traits: enTraits, sigils: enSigils, abilities: enAbilities } },
      interpolation: { escapeValue: false },
    });
  });

  it("names the trait a Crabvestment Returns sigil carries", () => {
    // The sigil is GEEN_141_04, but its trait is SKILL_141_00 — named by
    // TXT_SKILL_141_04, i.e. under a sibling's hash. Regression: the trait
    // rendered as "Unknown (1b0d9897)" in the Builds tab.
    expect(translateSigilId(0xf8fef304)).toBe("Crabvestment Returns");
    expect(translateTraitId(0x1b0d9897)).toBe("Crabvestment Returns");
  });

  it("names a trait whose key mirrors its text row", () => {
    expect(translateTraitId(0xceb700ee)).toBe("Stun Power");
    expect(translateTraitId(0x50079a1c)).toBe("ATK");
  });

  it("names abilities that borrow another character's text row", () => {
    // Djeeta's sixteen are AB_PL0100_*, named by Gran's TXT_AB_PL0000_* rows;
    // Id's Fourfold Vengeance is AB_PL2000_05 -> TXT_AB_PL1900_06. All rendered
    // as "Unknown (…)" before ability.tbl was joined in.
    expect(translateAbilityId(0xaa949a9e)).toBe("Decimate"); // Djeeta, slot 1
    expect(translateAbilityId(0xd064b37f)).toBe("Substitute"); // Djeeta, slot 16
    expect(translateAbilityId(0x007ee2ae)).toBe("Fourfold Vengeance"); // Id
    expect(translateAbilityId(0x7f36d12b)).toBe("Ethereal Prison"); // Sandalphon
  });

  it("names an ability whose key mirrors its text row", () => {
    expect(translateAbilityId(0xbad9baa3)).toBe("Decimate"); // Gran, AB_PL0000_01
  });

  it("falls back to the generic label for an id no bundle covers", () => {
    expect(translateTraitId(0xdeadbeef)).toBe("Unknown (deadbeef)");
    expect(translateAbilityId(0xdeadbeef)).toBe("Unknown (deadbeef)");
  });
});
