/**
 * One definition of what a build-legality finding MEANS, shared by every
 * surface that shows one: the meter's coloured name, the Builds and Equipment
 * tabs' tooltips, and the Toolbox audit page.
 *
 * It lives in one place because the alternative is a public accusation phrased
 * three different ways, and because a rule added in Rust must be impossible to
 * render as a bare id — `LegalityRule` is a closed union, so a new rule fails
 * `tsc` here until someone writes the sentence a reader will judge it by.
 */

import { TFunction } from "i18next";

import { LegalityFinding, LegalitySubject, LegalityValue } from "./types";
import { translateSummonId } from "./utils";

/** The findings pointing at one piece of equipment.
 *
 * Matches on kind AND index, so a sigil finding can never colour the summon in
 * the same position. Whole-set subjects (`summons`, `overmasteries`,
 * `masterTraits`, `wrightstone`) carry no index and are matched by kind alone —
 * pass none, and an indexed subject will not match either. */
export const findingsForSubject = (
  findings: LegalityFinding[],
  kind: LegalitySubject["kind"],
  index?: number
): LegalityFinding[] => findings.filter((finding) => finding.subject.kind === kind && finding.subject.index === index);

/** A `LegalityValue` as the figure a reader compares, or undefined when the
 * value is an id — ids name a thing rather than measure one, and the rules that
 * carry them phrase their value without a number.
 *
 * `summonIds` is the exception, and earns it: the bonus-source claim's limit
 * genuinely IS a set of names ("only Rolan, Lucilius, Beelzebub, Lilith"), and
 * it has to be spelled out because the gear line cannot show it. Two bonus ids
 * share every effect's display name, so the line reads "Healing Cap Up" whether
 * or not this summon may hold that one.
 *
 * `slot` picks one entry out of a per-slot list, so a wrightstone's three caps
 * can each be quoted against the trait line they belong to. Without it a list
 * renders whole (`12 / 9 / 5`), which is what a claim about the levels together
 * needs. */
const displayValue = (value: LegalityValue | undefined, slot?: number): string | number | undefined => {
  if (!value) return undefined;
  switch (value.kind) {
    case "level":
    case "count":
    case "amount":
      return value.value;
    case "levels":
      return slot === undefined ? value.value.join(" / ") : value.value[slot];
    // Sorted after translating, not before: the backend orders them by id, and
    // alphabetical only means anything in the language being read.
    case "summonIds":
      return value.value
        .map(translateSummonId)
        .sort((a, b) => a.localeCompare(b))
        .join(", ");
    default:
      return undefined;
  }
};

/**
 * The string a finding's limit is written in.
 *
 * Only one rule needs a choice: a foreign summon bonus normally names the
 * summons that DO grant it, but an id nobody is known to grant — a modded one,
 * or one granted too widely for the backend to list — leaves nothing to name,
 * and "only " trailing into nothing is worse than the bare claim.
 */
const limitKey = (finding: LegalityFinding): string => {
  const key = `ui.legality.limit.${finding.rule}`;
  const unnamed = finding.allowed?.kind === "summonIds" && finding.allowed.value.length === 0;
  return unnamed ? `${key}-unnamed` : key;
};

/**
 * What the game allows, phrased to sit immediately after a gear line —
 * `max 20`, `doesn't roll on this summon`, `max +50`.
 *
 * A suffix, never a sentence, and never naming its subject: the line it follows
 * already names the item and shows the offending value, so this says only what
 * the limit is. That is the whole reason it replaced the old standalone
 * `15 / max 10` fragments — those restated a number the reader was already
 * looking at, in a vocabulary the rest of the app does not use.
 *
 * `slot` picks the cap belonging to one trait line, for rules that carry one
 * per slot.
 */
export const describeLimit = (
  t: TFunction,
  finding: LegalityFinding,
  slot?: number,
  /** A pre-formatted allowed value, for a caller that knows the unit the rule
   * does not. A summon bonus stores a bare `50`, and "max +50" beside a line
   * reading "+75%" leaves the reader to finish the comparison. */
  allowed?: string
): string =>
  // No probability reaches the template. The two report rules used to quote
  // one; it priced the draws honestly and the question dishonestly, since a
  // farmer rerolls hundreds of times, so the claim is now the count alone
  // (user, 2026-08-03). `finding.odds` survives on the wire and is simply not
  // rendered anywhere.
  t(limitKey(finding), {
    observed: displayValue(finding.observed, slot),
    allowed: allowed ?? displayValue(finding.allowed, slot),
  });
