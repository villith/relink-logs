import { describe, expect, it } from "vitest";

import type { Sigil, WeaponState } from "@/types";

import type { CapLoadout } from "../capSources";
import { traitFactors } from "./traits";

/** The three boundary weapon traits. Each carries a SECOND cap-up block that
 * applies only when the equipped weapon is transcended. */
const AIN = 0x1a2ef59e;
const SEVEN_STAR = 0xef05ec4d;
const TWO_CROWN = 0x281214ab;

/**
 * Real live data (2026-07-18 WSDIAG, mirrored from utils.test.ts): Hraesvelgr
 * at in-game Transcendence 9/10. Reused rather than invented so the fixture
 * cannot drift away from what `deriveTranscendence` actually accepts.
 */
const HRAESVELGR = 0xded16fcf;
const STAGE_9_INNATES = [
  { id: 0x1e1cecce, level: 32 },
  { id: 0xa8a3163b, level: 22 },
  { id: 0xdc584f60, level: 12 },
  { id: 0x57e8a93f, level: 1 },
];

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

const weapon = (weaponId: number, innateTraits: { id: number; level: number }[]): WeaponState => ({
  weaponId,
  exp: 0,
  starLevel: 0,
  plusMarks: 0,
  awakeningLevel: 10,
  wrightstoneId: 0,
  wrightstoneTraits: [],
  innateTraits,
});

const loadout = (traitId: number, weaponState: WeaponState | null): CapLoadout => ({
  // The boundary trait is supplied as a sigil so its level is controlled
  // independently of the innate levels the transcendence stage is derived from.
  sigils: [sigil(traitId, 15)],
  summons: [],
  weaponState,
  weaponInfo: null,
  overmasteryInfo: null,
});

/** The transcended half of a boundary trait, which is its own row. */
const transcendedFactor = (traitId: number, weaponState: WeaponState | null) =>
  traitFactors(loadout(traitId, weaponState), "normal").find((factor) => factor.key.endsWith("-transcended"));

describe("transcended boundary traits", () => {
  it("adds its own block on a transcended weapon", () => {
    // The base block is +100% and the transcended block +20%. It ADDS: read as
    // a replacement, transcending a weapon would CUT the cap from +100% to
    // +20%, and the game's own text puts it in a separate "If equipped weapon
    // is transcended:" clause rather than restating the first.
    const factor = transcendedFactor(AIN, weapon(HRAESVELGR, STAGE_9_INNATES));
    expect(factor?.evaluate({})).toMatchObject({ percent: 20, state: "active" });
  });

  it("does not apply on a weapon that is not transcended, but keeps its potential", () => {
    // Weapon id absent from the transcendence curves: derives no stage at all.
    const factor = transcendedFactor(AIN, weapon(0x0badf00d, []));
    expect(factor?.evaluate({})).toMatchObject({ percent: 0, potential: 20, state: "inactive" });
  });

  it("does not apply when the log has no weapon state to judge by", () => {
    expect(transcendedFactor(AIN, null)?.evaluate({})).toMatchObject({ state: "inactive" });
  });

  it("covers all three boundary traits", () => {
    for (const traitId of [AIN, SEVEN_STAR, TWO_CROWN]) {
      expect(transcendedFactor(traitId, weapon(HRAESVELGR, STAGE_9_INNATES))?.evaluate({})).toMatchObject({
        percent: 20,
        state: "active",
      });
    }
  });

  it("leaves the trait's base block as its own separate row", () => {
    // Two rows, not one merged number: the reader has to be able to see which
    // half of the trait each percent came from.
    const factors = traitFactors(loadout(AIN, weapon(HRAESVELGR, STAGE_9_INNATES)), "normal").filter(
      (factor) => factor.id === AIN
    );
    expect(factors).toHaveLength(2);
    expect(factors.find((factor) => !factor.key.endsWith("-transcended"))?.evaluate({})).toMatchObject({
      percent: 100,
      state: "active",
    });
  });

  it("produces no transcended row for a trait that has no transcended block", () => {
    // Fatebreaker is an ordinary unconditional cap trait.
    expect(transcendedFactor(0xd029fe08, weapon(HRAESVELGR, STAGE_9_INNATES))).toBeUndefined();
  });
});
