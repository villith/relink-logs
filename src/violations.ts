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
 *
 * That distinction has a colour. Perfect summons is the one violation whose
 * most likely explanation is a farmer who got there, so it reads gold — a
 * compliment, "Blessed by RNG" — and a player it is the ONLY thing against
 * reads gold everywhere their name is marked. One real breach turns them red:
 * luck does not launder a modded sigil.
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
  wrightstoneTrait: "impossibleWrightstone",
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

/**
 * How a violation reads: as cheating, or as luck.
 *
 * Only perfect summons is luck. Perfect overmasteries stays a cheat read: its
 * rolls come from a bounded ladder a few rerolls can walk, so all-maxed is not
 * the astronomical draw a full set of perfect summons is.
 */
export type LegalityTone = "cheat" | "lucky";

export const violationTone = (violation: Violation): LegalityTone =>
  violation === "perfectSummons" ? "lucky" : "cheat";

/** The tone of a whole set: lucky only when EVERYTHING against it is luck.
 * Undefined on an empty set — "not judged" has no colour. */
export const toneOfViolations = (violations: Violation[]): LegalityTone | undefined => {
  if (violations.length === 0) return undefined;
  return violations.every((violation) => violationTone(violation) === "lucky") ? "lucky" : "cheat";
};

export const findingsTone = (findings: { rule: LegalityRule }[]): LegalityTone | undefined =>
  toneOfViolations(findings.map((finding) => violationOf(finding.rule)));

/** The Mantine colour each tone marks in, so every surface resolves the same
 * pair and none can invent a third. Yellow is Mantine's gold. */
export const TONE_COLOR: Record<LegalityTone, "red" | "yellow"> = { cheat: "red", lucky: "yellow" };
