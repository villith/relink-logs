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

import { LegalityFinding, LegalitySeverity, LegalitySubject, LegalityValue } from "./types";

/** The worst severity in a set, or null when nothing fired.
 *
 * `impossible` outranks `improbable` and the two must never be collapsed: one
 * is proof the game could not have produced a build, the other is a report of
 * long odds that a dedicated farmer can genuinely hit. */
export const worstSeverity = (findings: LegalityFinding[]): LegalitySeverity | null => {
  if (findings.some((finding) => finding.severity === "impossible")) return "impossible";
  if (findings.length > 0) return "improbable";
  return null;
};

/** The Mantine colour for a severity; undefined leaves text at its usual
 * colour, which is what a clean player must look like. */
export const severityColor = (severity: LegalitySeverity | null): "red" | "yellow" | undefined => {
  if (severity === "impossible") return "red";
  if (severity === "improbable") return "yellow";
  return undefined;
};

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

/** A `LegalityValue` as a number a sentence can interpolate, or undefined when
 * the value is a list or absent — those rules phrase themselves without one. */
const scalar = (value: LegalityValue | undefined): number | undefined => {
  if (!value) return undefined;
  switch (value.kind) {
    case "level":
    case "count":
    case "amount":
      return value.value;
    default:
      return undefined;
  }
};

/** `odds` is a probability; a reader judges "1 in N". Locale-formatted here so
 * the sentence never has to, and named `denominator` rather than `count` —
 * i18next treats `count` as a pluralisation key. */
const denominator = (odds: number | null): string | undefined =>
  odds !== null && odds !== undefined && odds > 0 ? Math.round(1 / odds).toLocaleString() : undefined;

/**
 * The sentence a reader judges a finding by.
 *
 * `subjectName` is the already-translated name of the thing the finding points
 * at ("Behemoth III", "War Elemental") — the caller has the equipment in hand
 * and this module deliberately does not.
 *
 * Every rule gets its own key so the claim can be phrased in the reader's terms
 * rather than the rule's. `improbable` wording must never accuse: the game can
 * produce those builds and roughly one player in eight in a real database
 * carries one.
 */
export const describeFinding = (t: TFunction, finding: LegalityFinding, subjectName: string): string =>
  t(`ui.legality.explain.${finding.rule}`, {
    subject: subjectName,
    observed: scalar(finding.observed),
    allowed: scalar(finding.allowed),
    denominator: denominator(finding.odds),
  });
