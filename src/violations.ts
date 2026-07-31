/**
 * What a finding is a violation OF, in the reader's terms.
 *
 * The twelve rules are how the audit is computed; they are not how anyone
 * thinks about it. A reader looks at a person and asks "what about their build
 * could not exist?", and the answer is a piece of equipment — a sigil, a
 * wrightstone, a summon — not `sigilQuestLockedTrait`. Four sigil rules are one
 * thing to them, and listing all four spends four chips saying it once.
 *
 * Proof and long odds never collapse even on the same equipment: "impossible
 * summon" is a mod, "perfect summons" is a farmer's luck, and merging them
 * would turn a report into an accusation.
 */

import { TFunction } from "i18next";

import { LegalityRule } from "./types";

export type Violation =
  | "impossibleSigil"
  | "impossibleWrightstone"
  | "impossibleSummon"
  | "impossibleOvermastery"
  | "perfectSummons"
  | "perfectOvermasteries"
  | "masterTraits";

/** Display order: proof first, then the long-odds reports. A person's chips
 * read the same way every time, so two people carrying the same violations look
 * alike instead of looking like two different problems. */
export const VIOLATIONS: Violation[] = [
  "impossibleSigil",
  "impossibleWrightstone",
  "impossibleSummon",
  "impossibleOvermastery",
  "perfectSummons",
  "perfectOvermasteries",
  "masterTraits",
];

const BY_RULE: Record<LegalityRule, Violation> = {
  wrightstoneTraitLevel: "impossibleWrightstone",
  sigilTraitLevel: "impossibleSigil",
  sigilLockedPair: "impossibleSigil",
  sigilQuestLockedTrait: "impossibleSigil",
  sigilSingleTraitOnly: "impossibleSigil",
  overmasteryValue: "impossibleOvermastery",
  overmasteryAllMaxed: "perfectOvermasteries",
  summonTrait: "impossibleSummon",
  summonBonusSource: "impossibleSummon",
  summonBonusMagnitude: "impossibleSummon",
  summonPerfectCount: "perfectSummons",
  masterTraitCount: "masterTraits",
};

export const violationOf = (rule: LegalityRule): Violation => BY_RULE[rule];

export const violationLabel = (t: TFunction, violation: Violation): string => t(`ui.legality.violation.${violation}`);
