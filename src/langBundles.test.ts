import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";

import enSigils from "../src-tauri/lang/en/sigils.json";
import enTraits from "../src-tauri/lang/en/traits.json";
import enUi from "../src-tauri/lang/en/ui.json";
import { translateSigilId, translateTraitId } from "./utils";

/// Guards the shipped en lang bundles against the ids the hook actually reports.
/// A trait's runtime id is its skill.tbl Key hash, which usually — but not
/// always — mirrors the TXT_SKILL_ text row the name comes from, so a bundle
/// built from the text rows alone can miss ids that real sigils carry.
describe("lang bundles", () => {
  beforeAll(async () => {
    await i18next.init({
      lng: "en",
      defaultNS: "ui",
      resources: { en: { ui: enUi, traits: enTraits, sigils: enSigils } },
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

  it("falls back to the generic label for an id no bundle covers", () => {
    expect(translateTraitId(0xdeadbeef)).toBe("Unknown (deadbeef)");
  });
});
