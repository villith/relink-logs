import type { CapClass, CapLoadout } from "../capSources";
import { accountFactors } from "./account";
import { boardFactors } from "./board";
import { overmasteryFactors, summonFactors } from "./equipment";
import { traitFactors } from "./traits";
import type { CapConditions, CapFactor, CapFactorResult, CapParamKey } from "./types";

/**
 * The whole cap-factor set for one hit: collected from the loadout, then
 * evaluated against whatever the caller knows about the moment it landed.
 *
 * Collection and evaluation are separate on purpose. The set a player carries
 * depends only on their equipment, so it can be built once and re-evaluated as
 * conditions change — and a caller can ask what a factor NEEDS without
 * evaluating anything, which is what lets a UI offer the right controls.
 */

export type CapFactorInput = {
  loadout: CapLoadout | undefined;
  capClass: CapClass | null;
};

/** Every contributor the player carries, in a stable order: what they equipped,
 * then what they unlocked, then what their account grants. */
export const collectCapFactors = ({ loadout, capClass }: CapFactorInput): CapFactor[] => [
  ...traitFactors(loadout, capClass),
  ...overmasteryFactors(loadout, capClass),
  ...summonFactors(loadout, capClass),
  ...boardFactors(loadout, capClass),
  ...accountFactors(loadout, capClass),
];

export type CapFactorRow = { factor: CapFactor; result: CapFactorResult };

export type CapFactorTotals = {
  rows: CapFactorRow[];
  /** The sum of what actually applied, in table units (30 = +30%). */
  attributed: number;
  /** What the unresolved factors are collectively worth. NOT added to
   * `attributed` — it is the size of the question, not part of the answer. */
  unresolved: number;
  /** Every param that would resolve at least one factor, deduplicated. This is
   * the shortest list of things a caller could learn to shrink `unresolved`. */
  missing: CapParamKey[];
};

/** Every factor evaluated under one set of conditions, with the three totals a
 * breakdown needs to be honest: what applied, what is still open, and what
 * would close it. */
export const evaluateCapFactors = (factors: CapFactor[], conditions: CapConditions = {}): CapFactorTotals => {
  const rows = factors.map((factor) => ({ factor, result: factor.evaluate(conditions) }));

  let attributed = 0;
  let unresolved = 0;
  const missing = new Set<CapParamKey>();
  for (const { result } of rows) {
    attributed += result.percent;
    // An inactive factor's potential is deliberately not counted: its gate was
    // evaluated and failed, so it is not part of what is still open.
    if (result.state === "unknown") {
      unresolved += result.potential;
      for (const param of result.missing) missing.add(param);
    }
  }

  return { rows, attributed, unresolved, missing: [...missing].sort() };
};

/** The derived per-hit channel total, as the fraction the formula adds (0.35 =
 * +35%): the sum of the ACTIVE channel-placement factors under these
 * conditions. Record-side factors never count here — the captured record
 * already holds them — and an unresolved factor contributes nothing rather
 * than its potential. This is the one number the hover card credits; the
 * debug panel itemizes the same rows. */
export const deriveChannelTotal = (
  loadout: CapLoadout | undefined,
  capClass: CapClass | null,
  conditions: CapConditions
): number => {
  if (loadout === undefined || capClass === null) return 0;
  let total = 0;
  for (const { factor, result } of evaluateCapFactors(collectCapFactors({ loadout, capClass }), conditions).rows) {
    if (factor.placement === "channel" && result.state === "active") total += result.percent;
  }
  return total / 100;
};

export { DMG_CAP_TRAIT } from "./traits";
export type { CapConditions, CapFactor, CapFactorReason, CapFactorResult, CapFactorState, CapParamKey } from "./types";
