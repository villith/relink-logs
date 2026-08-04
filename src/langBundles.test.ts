import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";

import enAbilities from "../src-tauri/lang/en/abilities.json";
import enSigils from "../src-tauri/lang/en/sigils.json";
import enStatuses from "../src-tauri/lang/en/statuses.json";
import enTraits from "../src-tauri/lang/en/traits.json";
import enUi from "../src-tauri/lang/en/ui.json";
import { translateAbilityId, translateSigilId, translateStatusName, translateTraitId } from "./utils";

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
      resources: { en: { ui: enUi, traits: enTraits, sigils: enSigils, abilities: enAbilities, statuses: enStatuses } },
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

  it("names a status by the id the hook emits", () => {
    // status.tbl's StatusId, decimal, exactly as StatusApplyEvent carries it —
    // not a hash like every other bundle, which is why this has its own test.
    // The name is the game's own buff-icon TITLE ("ATK\u2191"), not the longer
    // description on the same row ("ATK is boosted").
    expect(translateStatusName(0)).toBe("ATK\u2191");
    expect(translateStatusName(4)).toBe("DMG Cut");
    expect(translateStatusName(1000)).toBe("Poison");
  });

  it("names the character-signature statuses the first extraction left blank", () => {
    // The first bundle only carried the ~77 rows whose titles the extraction
    // surfaced; the character-signature buffs have real names too. Observed on
    // log 1636: Sandalphon's aura and Fraux's stance buffs all rendered as
    // "Effect <id>" without these rows.
    expect(translateStatusName(47)).toBe("Näed Nulli");
    expect(translateStatusName(60)).toBe("Heliotrope Aura");
    expect(translateStatusName(119)).toBe("Enhanced Upright");
  });

  it("answers empty for a status the game never names", () => {
    // A handful of rows are internal and carry no text at all. Empty is the
    // contract statusLabelFor expects: it is what makes the row fall back to
    // "Effect <id>" rather than printing a blank name.
    expect(translateStatusName(12)).toBe("");
    expect(translateStatusName(999999)).toBe("");
  });
});
