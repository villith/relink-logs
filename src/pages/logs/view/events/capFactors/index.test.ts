import { describe, expect, it } from "vitest";

import type { Sigil } from "@/types";

import type { CapLoadout } from "../capSources";
import { collectCapFactors, deriveChannelBreakdown, deriveChannelTotal, evaluateCapFactors } from "./index";

/** Unconditional, +50% to every class at level 15. */
const FATEBREAKER = 0xd029fe08;
/** Conditional: "While at 75% HP or more: ... DMG Cap +70%" at level 15. */
const CELESTIAL_LUMEN = 0xa7726190;
const OM_NORMAL = 0x06595c52;

const sigil = (traitId: number, level: number): Sigil => ({
  firstTraitId: traitId,
  firstTraitLevel: level,
  secondTraitId: 0,
  secondTraitLevel: 0,
  sigilId: 1,
  equippedCharacter: 0,
  sigilLevel: 1,
  acquisitionCount: 0,
  notificationEnum: 0,
});

const loadout = (over: Partial<CapLoadout> = {}): CapLoadout => ({
  sigils: [sigil(FATEBREAKER, 15), sigil(CELESTIAL_LUMEN, 15)],
  summons: [],
  weaponState: null,
  weaponInfo: null,
  overmasteryInfo: { overmasteries: [{ id: OM_NORMAL, flags: 0, value: 20 }] },
  ...over,
});

describe("collectCapFactors", () => {
  it("returns every family in a stable order", () => {
    const kinds = collectCapFactors({ loadout: loadout(), capClass: "normal" }).map((factor) => factor.kind);
    expect(kinds.filter((kind, index) => kinds.indexOf(kind) === index)).toEqual(["trait", "overmastery", "account"]);
  });

  it("has nothing to collect for a hit whose class was never captured", () => {
    // Substituting another class's factors would attribute sources the formula
    // did not use — but the account terms exist regardless of the hit.
    const factors = collectCapFactors({ loadout: loadout(), capClass: null });
    expect(factors.every((factor) => factor.kind === "account")).toBe(true);
  });

  it("lets a caller see what a factor needs without evaluating it", () => {
    const factors = collectCapFactors({ loadout: loadout(), capClass: "normal" });
    expect(factors.find((factor) => factor.id === CELESTIAL_LUMEN)?.params).toEqual(["hpRatio"]);
    expect(factors.find((factor) => factor.id === FATEBREAKER)?.params).toEqual([]);
  });
});

describe("evaluateCapFactors", () => {
  it("sums only what actually applied", () => {
    const factors = collectCapFactors({ loadout: loadout(), capClass: "normal" });
    const totals = evaluateCapFactors(factors);
    // Fatebreaker +50 and the overmastery roll +20. Celestial Lumen is
    // unresolved and contributes nothing.
    expect(totals.attributed).toBe(70);
  });

  it("keeps the unresolved total apart from the attributed one", () => {
    const totals = evaluateCapFactors(collectCapFactors({ loadout: loadout(), capClass: "normal" }));
    // The size of the question, not part of the answer.
    expect(totals.unresolved).toBe(70);
    expect(totals.missing).toEqual(["hpRatio"]);
  });

  it("moves a resolved conditional out of unresolved and into attributed", () => {
    const factors = collectCapFactors({ loadout: loadout(), capClass: "normal" });
    const totals = evaluateCapFactors(factors, { hpRatio: 0.9 });
    expect(totals.attributed).toBe(140);
    expect(totals.unresolved).toBe(0);
    expect(totals.missing).toEqual([]);
  });

  it("does not count a failed gate as still open", () => {
    // Its gate was evaluated and failed, so it is not part of what is unknown.
    const totals = evaluateCapFactors(collectCapFactors({ loadout: loadout(), capClass: "normal" }), { hpRatio: 0.1 });
    expect(totals.attributed).toBe(70);
    expect(totals.unresolved).toBe(0);
  });

  it("deduplicates the params it asks for across factors", () => {
    const player = loadout({ sigils: [sigil(CELESTIAL_LUMEN, 15), sigil(0x0de887a0, 15)] });
    const totals = evaluateCapFactors(collectCapFactors({ loadout: player, capClass: "normal" }));
    // Both traits gate on the HP fraction; the caller is asked for it once.
    expect(totals.missing).toEqual(["hpRatio"]);
  });
});

describe("deriveChannelTotal", () => {
  it("sums only the ACTIVE channel-side factors, as a fraction", () => {
    // pl0300_000c (+15, always) resolves active with no conditions;
    // pl0300_0016-style group nodes stay unresolved and contribute nothing;
    // pl0300_0023 (counted-sigil) is record-side and never counts here even
    // while active. Log 2573: the channel is exactly the FreeWork terms.
    const player = loadout({
      sigils: [sigil(0x50079a1c, 1), sigil(0x50079a1c, 1), sigil(0x50079a1c, 1)],
      characterType: "Pl0300",
      skillboard: [0x0c, 0x23],
    });
    expect(deriveChannelTotal(player, "normal", {})).toBeCloseTo(0.15, 6);
  });

  it("is zero with nothing derivable", () => {
    expect(deriveChannelTotal(loadout(), "normal", {})).toBe(0);
    expect(deriveChannelTotal(undefined, "normal", {})).toBe(0);
    expect(deriveChannelTotal(loadout(), null, {})).toBe(0);
  });
});

describe("deriveChannelBreakdown", () => {
  it("splits the channel into active and unresolved fractions", () => {
    // pl0300_000c (+15, always) is active; pl0300_001f (+35, attack-group 1)
    // cannot be settled without the hit's action id, and its potential is the
    // prediction's honest uncertainty.
    const player = loadout({ characterType: "Pl0300", skillboard: [0x0c, 0x1f] });
    const { active, unresolved } = deriveChannelBreakdown(player, "normal", {});
    expect(active).toBeCloseTo(0.15, 6);
    expect(unresolved).toBeCloseTo(0.35, 6);
  });

  it("ignores record-side unknowns — the captured record already holds them", () => {
    // Celestial Lumen (conditional trait) is unresolved without hpRatio, but it
    // is record-placement: it must not leak into the channel's uncertainty.
    const { active, unresolved } = deriveChannelBreakdown(loadout(), "normal", {});
    expect(active).toBe(0);
    expect(unresolved).toBe(0);
  });

  it("is empty with nothing derivable", () => {
    expect(deriveChannelBreakdown(undefined, "normal", {})).toEqual({ active: 0, unresolved: 0 });
    expect(deriveChannelBreakdown(loadout(), null, {})).toEqual({ active: 0, unresolved: 0 });
  });
});
