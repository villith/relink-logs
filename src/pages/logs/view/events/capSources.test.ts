import { describe, expect, it } from "vitest";

import type { Sigil } from "@/types";

import {
  capClassOf,
  deriveConditionalSources,
  deriveRecordComponents,
  dmgCapTraitValue,
  enumerateOvermasteries,
  enumerateSummons,
  enumerateTraits,
  type CapLoadout,
} from "./capSources";

const DMG_CAP_TRAIT = 0xdc584f60;
const FATEBREAKER_TRAIT = 0xd029fe08;
/** Catastrophe Nova — conditional (gated on max-HP fraction). */
const CATASTROPHE_NOVA_TRAIT = 0x1e1cecce;
/** utils.ts' OVERMASTERY_EFFECT_IDS representatives, one per class. */
const OM_NORMAL = 0x06595c52;
const OM_SKILL = 0x0b0e4311;
const OM_SBA = 0x047b7a70;
/** "Normal Attack Damage Cap Up" as a summon equip bonus; values[0] is 20%. */
const SUMMON_BONUS_NORMAL = 0x9245dfa4;
/** Cap traits whose top row raises exactly one class: +30% normal / +30% skill. */
const NORMAL_ONLY_TRAIT = 0xbbd77c33;
const SKILL_ONLY_TRAIT = 0x020db733;
/** A trait with no row in any cap table — a damage/ATK sigil, say. */
const NOT_A_CAP_TRAIT = 0x0badf00d;

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

/** The live (upgrade-resolved) id of the terminus Sigil Booster innate. */
const SIGIL_BOOSTER_LIVE = 0x57e92e3f;

const weaponStateWith = (innateTraits: { id: number; level: number }[]) => ({
  weaponId: 1,
  exp: 0,
  starLevel: 6,
  plusMarks: 0,
  awakeningLevel: 10,
  wrightstoneId: 0,
  wrightstoneTraits: [],
  innateTraits,
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

describe("dmgCapTraitValue", () => {
  it("looks the trait value up ONCE at the combined level, not per sigil", () => {
    // Three sigils of level 21 are one level-63 trait, which the game shows as
    // "DMG Cap +238%" — not three lookups of level 21 (66% each).
    const player = loadout({ sigils: [sigil(DMG_CAP_TRAIT, 21), sigil(DMG_CAP_TRAIT, 21), sigil(DMG_CAP_TRAIT, 21)] });
    expect(dmgCapTraitValue(player, "normal")).toBeCloseTo(2.38, 6);
  });

  it("clamps a combined level past the trait's top row to that row", () => {
    // Levels above the table's last row are wasted, not extrapolated.
    const player = loadout({ sigils: [sigil(DMG_CAP_TRAIT, 90)] });
    expect(dmgCapTraitValue(player, "normal")).toBeCloseTo(2.5, 6);
  });

  it("is zero without the trait or without a loadout", () => {
    expect(dmgCapTraitValue(loadout(), "normal")).toBe(0);
    expect(dmgCapTraitValue(undefined, "normal")).toBe(0);
  });

  it("raises each SIGIL-sourced level by the Sigil Booster level", () => {
    // Log 2573's oracle reconciliation: every local player ran 3 DMG Cap
    // sigils (45) + the terminus innate (15) = combined 60 (+220%), yet every
    // hit's cap demanded level 63 (+238%) — Sigil Booster 1 raises each
    // equipped sigil trait by its level, and DMG Cap sits on three sigils.
    const player = loadout({
      sigils: [sigil(DMG_CAP_TRAIT, 15), sigil(DMG_CAP_TRAIT, 15), sigil(DMG_CAP_TRAIT, 15)],
      weaponState: weaponStateWith([
        { id: DMG_CAP_TRAIT, level: 15 },
        { id: SIGIL_BOOSTER_LIVE, level: 1 },
      ]),
    });
    expect(dmgCapTraitValue(player, "normal")).toBeCloseTo(2.38, 6);
  });

  it("does not boost non-sigil DMG Cap sources", () => {
    // The booster reads "sigils' trait levels": a weapon-innate DMG Cap with
    // no sigil instances stays at its own level.
    const player = loadout({
      weaponState: weaponStateWith([
        { id: DMG_CAP_TRAIT, level: 15 },
        { id: SIGIL_BOOSTER_LIVE, level: 1 },
      ]),
    });
    expect(dmgCapTraitValue(player, "normal")).toBeCloseTo(0.45, 6);
  });
});

describe("deriveRecordComponents", () => {
  it("keeps the DMG Cap trait OUT of the trait row", () => {
    // The 2026-08-09 oracle reconciliation: the plain DMG Cap trait is the one
    // unconditional trait the game does NOT fuse into the per-player record —
    // it enters the formula through its own second lookup. Counting it here
    // AND as its own term would double-attribute it.
    const player = loadout({ sigils: [sigil(DMG_CAP_TRAIT, 63), sigil(FATEBREAKER_TRAIT, 15)] });
    const traits = deriveRecordComponents(player, "normal").filter((s) => s.key === "trait");
    // Fatebreaker L15 is +50% on every class.
    expect(traits).toEqual([{ key: "trait", labelKey: "ui.logs.cap-source-trait", value: 0.5 }]);
  });

  it("keeps conditional traits out entirely", () => {
    const player = loadout({ sigils: [sigil(CATASTROPHE_NOVA_TRAIT, 15)] });
    expect(deriveRecordComponents(player, "normal")).toEqual([]);
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
    expect(deriveRecordComponents(player, "normal")).toEqual([
      { key: "overmastery", labelKey: "ui.logs.cap-source-overmastery", value: 0.35 },
    ]);
    expect(deriveRecordComponents(player, "skill")[0].value).toBeCloseTo(0.4, 6);
  });

  it("skips an overmastery whose magnitude was never recorded", () => {
    // A v2.0.2 town-loadout recovery carries the level in `flags` and a zero
    // value. Its real magnitude is unknown, so it stays unattributed rather
    // than being counted as zero — which would claim it contributed nothing.
    const player = loadout({
      overmasteryInfo: { overmasteries: [{ id: OM_NORMAL, flags: 0b100, value: 0 }] },
    });
    expect(deriveRecordComponents(player, "normal")).toEqual([]);
  });

  it("renders the captured Mastery total as its own record sub-row", () => {
    // The game's resolved limit-bonus store, per class in table units — a
    // component of the fused record like the families above, so it renders as
    // a sub-row and never adds to the attributed total.
    const player = loadout({ limitBonusCapNormal: 684, limitBonusCapSkill: 600 });
    expect(deriveRecordComponents(player, "normal")).toEqual([
      { key: "mastery", labelKey: "ui.logs.cap-source-mastery", value: 6.84 },
    ]);
    expect(deriveRecordComponents(player, "skill")[0].value).toBeCloseTo(6.0, 6);
  });

  it("omits the Mastery sub-row on a log without the capture", () => {
    expect(deriveRecordComponents(loadout(), "normal")).toEqual([]);
  });

  it("counts a summon equip bonus at its own level's magnitude", () => {
    const player = loadout({
      summons: [{ summonId: 1, mainTraitId: 0, mainTraitLevel: 0, bonusId: SUMMON_BONUS_NORMAL, bonusLevel: 0 }],
    });
    expect(deriveRecordComponents(player, "normal")).toEqual([
      { key: "summon", labelKey: "ui.logs.cap-source-summon", value: 0.2 },
    ]);
    // The same bonus contributes nothing to a Skybound Art's cap.
    expect(deriveRecordComponents(player, "sba")).toEqual([]);
  });

  it("returns nothing for a player whose loadout was never stored", () => {
    expect(deriveRecordComponents(undefined, "normal")).toEqual([]);
  });

  it("sums the families into one row each, in a stable order", () => {
    const player = loadout({
      sigils: [sigil(FATEBREAKER_TRAIT, 15)],
      summons: [{ summonId: 1, mainTraitId: 0, mainTraitLevel: 0, bonusId: SUMMON_BONUS_NORMAL, bonusLevel: 0 }],
      overmasteryInfo: { overmasteries: [{ id: OM_NORMAL, flags: 1, value: 20 }] },
    });
    expect(deriveRecordComponents(player, "normal").map((s) => s.key)).toEqual(["trait", "overmastery", "summon"]);
  });
});

describe("enumerateTraits", () => {
  it("lists every combined trait, including the ones that contribute nothing", () => {
    // The debug panel's premise: a trait considered and rejected must be
    // visible as considered, or the reader cannot tell it from one we missed.
    const player = loadout({ sigils: [sigil(NORMAL_ONLY_TRAIT, 15), sigil(NOT_A_CAP_TRAIT, 15)] });
    const rows = enumerateTraits(player, "normal");
    expect(rows.map((row) => row.id).sort()).toEqual([NOT_A_CAP_TRAIT, NORMAL_ONLY_TRAIT].sort());
  });

  it("carries the level it looked up and the whole three-class row it found", () => {
    const player = loadout({ sigils: [sigil(NORMAL_ONLY_TRAIT, 15)] });
    const [row] = enumerateTraits(player, "normal");
    expect(row.level).toBe(15);
    expect(row.row).toEqual([30, 0, 0]);
    expect(row.percent).toBe(30);
    expect(row.excluded).toBeNull();
  });

  it("says a cap trait raised a DIFFERENT class rather than dropping it", () => {
    const player = loadout({ sigils: [sigil(SKILL_ONLY_TRAIT, 15)] });
    const [row] = enumerateTraits(player, "normal");
    expect(row.excluded).toBe("other-class");
    expect(row.percent).toBe(0);
    // The row is still carried: seeing [0, 30, 0] is what says WHICH class.
    expect(row.row).toEqual([0, 30, 0]);
  });

  it("says a trait is not a cap source at all", () => {
    const player = loadout({ sigils: [sigil(NOT_A_CAP_TRAIT, 15)] });
    const [row] = enumerateTraits(player, "normal");
    expect(row.excluded).toBe("not-a-cap-source");
    expect(row.row).toBeNull();
  });

  it("marks the plain DMG Cap trait as its own term, outside the record", () => {
    const player = loadout({ sigils: [sigil(DMG_CAP_TRAIT, 63)] });
    const [row] = enumerateTraits(player, "normal");
    expect(row.excluded).toBe("dmg-cap-trait");
    expect(row.percent).toBe(0);
    // Its magnitude is still shown — it just belongs to a different term.
    expect(row.row?.[0]).toBeCloseTo(238, 6);
  });

  it("marks a conditional trait as itemized elsewhere", () => {
    const player = loadout({ sigils: [sigil(CATASTROPHE_NOVA_TRAIT, 15)] });
    const [row] = enumerateTraits(player, "normal");
    expect(row.excluded).toBe("conditional");
    expect(row.percent).toBe(0);
  });

  it("says a cap trait's row is empty at the level reached", () => {
    // Nova's own table is genuinely all zeroes below combined level 26, so a
    // single L15 sigil of a graded trait contributes nothing YET.
    const player = loadout({ sigils: [sigil(SKILL_ONLY_TRAIT, 1)] });
    const [row] = enumerateTraits(player, "skill");
    expect(row.percent).toBe(0);
    expect(row.excluded).toBe("zero-at-level");
  });
});

describe("enumerateOvermasteries", () => {
  it("lists every roll with the magnitude the log recorded", () => {
    const player = loadout({
      overmasteryInfo: {
        overmasteries: [
          { id: OM_NORMAL, flags: 1, value: 20 },
          { id: OM_SKILL, flags: 1, value: 40 },
        ],
      },
    });
    const rows = enumerateOvermasteries(player, "normal");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: OM_NORMAL, percent: 20, excluded: null });
    expect(rows[1]).toMatchObject({ id: OM_SKILL, percent: 0, excluded: "other-class" });
  });

  it("says a roll's magnitude was never recorded", () => {
    const player = loadout({ overmasteryInfo: { overmasteries: [{ id: OM_NORMAL, flags: 0b100, value: 0 }] } });
    const [row] = enumerateOvermasteries(player, "normal");
    expect(row.excluded).toBe("value-unrecorded");
    expect(row.percent).toBe(0);
  });

  it("says a roll is not a cap roll", () => {
    const player = loadout({ overmasteryInfo: { overmasteries: [{ id: NOT_A_CAP_TRAIT, flags: 1, value: 18 }] } });
    expect(enumerateOvermasteries(player, "normal")[0].excluded).toBe("not-a-cap-source");
  });
});

describe("enumerateSummons", () => {
  it("lists each equipped summon's bonus with the level it was read at", () => {
    const player = loadout({
      summons: [
        { summonId: 1, mainTraitId: 0, mainTraitLevel: 0, bonusId: SUMMON_BONUS_NORMAL, bonusLevel: 0 },
        { summonId: 2, mainTraitId: 0, mainTraitLevel: 0, bonusId: NOT_A_CAP_TRAIT, bonusLevel: 0 },
      ],
    });
    const rows = enumerateSummons(player, "normal");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: SUMMON_BONUS_NORMAL, level: 0, percent: 20, excluded: null });
    expect(rows[1].excluded).toBe("not-a-cap-source");
  });

  it("says a summon bonus raises a different class", () => {
    const player = loadout({
      summons: [{ summonId: 1, mainTraitId: 0, mainTraitLevel: 0, bonusId: SUMMON_BONUS_NORMAL, bonusLevel: 0 }],
    });
    expect(enumerateSummons(player, "sba")[0].excluded).toBe("other-class");
  });
});

describe("the enumerations and the family sums", () => {
  // The whole point of pushing enumeration down here: the tooltip's family
  // total IS the sum of the debug panel's line items, by construction. Asserted
  // rather than assumed, because a divergence would be invisible in both views.
  const player = loadout({
    sigils: [
      sigil(FATEBREAKER_TRAIT, 15),
      sigil(NORMAL_ONLY_TRAIT, 15),
      sigil(SKILL_ONLY_TRAIT, 15),
      sigil(DMG_CAP_TRAIT, 63),
      sigil(CATASTROPHE_NOVA_TRAIT, 15),
      sigil(NOT_A_CAP_TRAIT, 15),
    ],
    summons: [{ summonId: 1, mainTraitId: 0, mainTraitLevel: 0, bonusId: SUMMON_BONUS_NORMAL, bonusLevel: 0 }],
    overmasteryInfo: {
      overmasteries: [
        { id: OM_NORMAL, flags: 1, value: 20 },
        { id: OM_NORMAL, flags: 1, value: 15 },
        { id: OM_SKILL, flags: 1, value: 40 },
        { id: OM_SBA, flags: 0b100, value: 0 },
      ],
    },
  });

  const familyValue = (capClass: "normal" | "skill" | "sba", key: string) =>
    deriveRecordComponents(player, capClass).find((source) => source.key === key)?.value ?? 0;

  const sum = (rows: { percent: number }[]) => rows.reduce((total, row) => total + row.percent, 0);

  it.each(["normal", "skill", "sba"] as const)("agrees with the record's family rows for %s hits", (capClass) => {
    expect(sum(enumerateTraits(player, capClass)) / 100).toBe(familyValue(capClass, "trait"));
    expect(sum(enumerateOvermasteries(player, capClass)) / 100).toBe(familyValue(capClass, "overmastery"));
    expect(sum(enumerateSummons(player, capClass)) / 100).toBe(familyValue(capClass, "summon"));
  });
});

describe("deriveConditionalSources", () => {
  it("names each equipped conditional trait at its maximum", () => {
    // Two Nova sigils: combined level 30, where the table holds +430%. (The
    // trait's rows are genuinely zero below combined level 26.)
    const player = loadout({
      sigils: [sigil(CATASTROPHE_NOVA_TRAIT, 15), sigil(CATASTROPHE_NOVA_TRAIT, 15), sigil(FATEBREAKER_TRAIT, 15)],
    });
    const rows = deriveConditionalSources(player, "normal");
    expect(rows).toHaveLength(1);
    expect(rows[0].traitId).toBe(CATASTROPHE_NOVA_TRAIT);
    expect(rows[0].value).toBeCloseTo(4.3, 6);
  });

  it("is empty without conditional cap traits", () => {
    expect(deriveConditionalSources(loadout(), "normal")).toEqual([]);
    expect(deriveConditionalSources(undefined, "normal")).toEqual([]);
  });
});
