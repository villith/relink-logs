import { describe, expect, it } from "vitest";

import type { Sigil } from "@/types";

import { capClassOf, deriveCapSources, type CapLoadout } from "./capSources";

const DMG_CAP_TRAIT = 0xdc584f60;
/** utils.ts' OVERMASTERY_EFFECT_IDS representatives, one per class. */
const OM_NORMAL = 0x06595c52;
const OM_SKILL = 0x0b0e4311;
const OM_SBA = 0x047b7a70;
/** "Normal Attack Damage Cap Up" as a summon equip bonus; values[0] is 20%. */
const SUMMON_BONUS_NORMAL = 0x9245dfa4;

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
  sigils: [],
  summons: [],
  weaponState: null,
  weaponInfo: null,
  overmasteryInfo: null,
  ...over,
});

describe("capClassOf", () => {
  it("reads the class the game's own builder would select", () => {
    expect(capClassOf(0x1)).toBe("normal");
    expect(capClassOf(0x10008)).toBe("skill");
    // 0x40000 wins over 0x10000: the builder's 0x40000 branch jumps past the
    // skill assignment.
    expect(capClassOf(0x50000)).toBe("sba");
  });

  it("has no class for a hit whose flags were never captured", () => {
    expect(capClassOf(null)).toBeNull();
  });
});

describe("deriveCapSources", () => {
  it("looks the trait value up ONCE at the combined level, not per sigil", () => {
    // Three sigils of level 21 are one level-63 trait, which the game shows as
    // "DMG Cap +238%" — not three lookups of level 21 (66% each).
    const player = loadout({ sigils: [sigil(DMG_CAP_TRAIT, 21), sigil(DMG_CAP_TRAIT, 21), sigil(DMG_CAP_TRAIT, 21)] });
    const traits = deriveCapSources(player, "normal").filter((s) => s.key === "trait");
    expect(traits).toEqual([{ key: "trait", labelKey: "ui.logs.cap-source-trait", value: 2.38 }]);
  });

  it("clamps a combined level past the trait's top row to that row", () => {
    // Levels above the table's last row are wasted, not extrapolated.
    const player = loadout({ sigils: [sigil(DMG_CAP_TRAIT, 90)] });
    expect(deriveCapSources(player, "normal")[0].value).toBeCloseTo(2.5, 6);
  });

  it("counts only the overmasteries that match the hit's attack class", () => {
    const player = loadout({
      overmasteryInfo: {
        overmasteries: [
          { id: OM_NORMAL, flags: 1, value: 20 },
          { id: OM_NORMAL, flags: 1, value: 15 },
          { id: OM_SKILL, flags: 1, value: 40 },
          { id: OM_SBA, flags: 1, value: 60 },
        ],
      },
    });
    expect(deriveCapSources(player, "normal")).toEqual([
      { key: "overmastery", labelKey: "ui.logs.cap-source-overmastery", value: 0.35 },
    ]);
    expect(deriveCapSources(player, "skill")[0].value).toBeCloseTo(0.4, 6);
  });

  it("skips an overmastery whose magnitude was never recorded", () => {
    // A v2.0.2 town-loadout recovery carries the level in `flags` and a zero
    // value. Its real magnitude is unknown, so it stays unattributed rather
    // than being counted as zero — which would claim it contributed nothing.
    const player = loadout({
      overmasteryInfo: { overmasteries: [{ id: OM_NORMAL, flags: 0b100, value: 0 }] },
    });
    expect(deriveCapSources(player, "normal")).toEqual([]);
  });

  it("counts a summon equip bonus at its own level's magnitude", () => {
    const player = loadout({
      summons: [{ summonId: 1, mainTraitId: 0, mainTraitLevel: 0, bonusId: SUMMON_BONUS_NORMAL, bonusLevel: 0 }],
    });
    expect(deriveCapSources(player, "normal")).toEqual([
      { key: "summon", labelKey: "ui.logs.cap-source-summon", value: 0.2 },
    ]);
    // The same bonus contributes nothing to a Skybound Art's cap.
    expect(deriveCapSources(player, "sba")).toEqual([]);
  });

  it("returns nothing for a player whose loadout was never stored", () => {
    expect(deriveCapSources(undefined, "normal")).toEqual([]);
  });

  it("sums the families into one row each, in a stable order", () => {
    const player = loadout({
      sigils: [sigil(DMG_CAP_TRAIT, 65)],
      summons: [{ summonId: 1, mainTraitId: 0, mainTraitLevel: 0, bonusId: SUMMON_BONUS_NORMAL, bonusLevel: 0 }],
      overmasteryInfo: { overmasteries: [{ id: OM_NORMAL, flags: 1, value: 20 }] },
    });
    expect(deriveCapSources(player, "normal").map((s) => s.key)).toEqual(["trait", "overmastery", "summon"]);
  });
});
