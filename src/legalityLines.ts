/**
 * Which line of a finding's evidence the rule actually condemns.
 *
 * The finding carries the whole item — every trait, every bonus — because a
 * reader needs the context to judge the claim. But only one part of it is
 * wrong, and saying which in prose ("not a pair this sigil rolls") spends a
 * sentence restating what a red line says instantly. So: mark the line, drop
 * the words.
 *
 * Most rules identify their line EXACTLY, because `observed` is the offending
 * id — a trait id, a summon bonus id. Matching on that is what makes the mark
 * trustworthy; the level-matching fallbacks below are for the two rules whose
 * claim is a number rather than an identity.
 */

import { LegalityEvidence, LegalityEvidenceTrait, LegalityFinding } from "@/types";

export type MarkedLines = {
  /** Indices into the item's rendered lines. Empty means the claim is about
   * the item as a whole — or that it could not be pinned to one line, which is
   * the same thing as far as a reader is concerned. */
  lines: number[];
  /** True when the finding carries one allowed value per line, so each line
   * quotes its own cap rather than the whole list. */
  perLine: boolean;
  /** True when the claim is said once, on the item's heading, rather than
   * beside a line. See [`placed`]. */
  markHeading: boolean;
};

/**
 * Where the claim gets said, decided from what was marked.
 *
 * Beside a line when it accuses exactly ONE — a phrase is only readable against
 * something a line SHOWS, and one mark makes that line unambiguous. Per line
 * when the finding carries a cap per line, because each mark then quotes a
 * different number.
 *
 * On the heading otherwise. A whole-set rule marks every member but makes a
 * single claim about them together; repeated beneath each one it read as four
 * separate accusations of the same thing. Nothing marked lands here too — there
 * is no line to read the phrase against.
 */
const placed = (lines: number[], perLine: boolean): MarkedLines => ({
  lines,
  perLine,
  markHeading: lines.length === 0 || (lines.length > 1 && !perLine),
});

const NONE: MarkedLines = placed([], false);

/** The lines a piece of evidence renders, as `{id, level}` pairs in display
 * order — the order the component draws them, so an index means the same thing
 * in both. */
export const linesOf = (evidence: LegalityEvidence | null | undefined): LegalityEvidenceTrait[] => {
  if (!evidence) return [];
  switch (evidence.kind) {
    case "sigil":
    case "wrightstone":
      return evidence.traits;
    // A summon draws its main trait, then its equip bonus.
    case "summon":
      return [evidence.main, evidence.bonus];
    case "summons":
      return evidence.summons.map((summon) => ({ id: summon.summonId, level: 0 }));
    case "overmasteries":
      return evidence.entries.map((entry) => ({ id: entry.id, level: 0 }));
    default:
      return [];
  }
};

/**
 * Which of `lines` a finding condemns.
 *
 * The lines are passed IN rather than read from `finding.evidence`, because two
 * surfaces draw the same gear from different sources: the audit page from the
 * snapshot the finding carries, the log view's Equipment and Builds tabs from
 * the live player data. Marks are line INDICES, so a caller that renders its own
 * lines must be the one to say what they are — deriving them from the evidence
 * instead would silently mark the wrong row wherever the two lists differ (an
 * overmastery set drawn with its empty slots, say).
 */
export const markedLines = (finding: LegalityFinding, lines: LegalityEvidenceTrait[]): MarkedLines => {
  const { observed, allowed, rule } = finding;

  // The bonus is the second line of a summon, and these two rules are always
  // about it — the id/magnitude they carry belongs to the bonus, not the main
  // trait that shares the item.
  if (rule === "summonBonusSource" || rule === "summonBonusMagnitude") {
    return placed(lines.length > 1 ? [1] : [], false);
  }

  // Whole-set odds rules condemn the set, so every line is part of the claim.
  if (rule === "overmasteryAllMaxed" || rule === "summonPerfectCount") {
    return placed(
      lines.map((_, index) => index),
      false
    );
  }

  // An id names its line outright. This is the common case and the reason the
  // explanatory prose could go: the rule already knows exactly what is wrong.
  if (observed.kind === "traitId" || observed.kind === "overmasteryId" || observed.kind === "summonBonusId") {
    const match = lines.findIndex((line) => line.id === observed.value);
    return placed(match === -1 ? [] : [match], false);
  }

  // A list of levels pairs positionally with the lines: a wrightstone's three
  // slots each carry their own cap, so each is judged against its own.
  if (observed.kind === "levels") {
    const caps = allowed.kind === "levels" ? allowed.value : [];
    return placed(
      observed.value.flatMap((level, index) => (caps[index] === undefined || level > caps[index] ? [index] : [])),
      true
    );
  }

  // One level names one line — but only when exactly one line carries it. Two
  // at the same level make the claim ambiguous, and red on the wrong trait is
  // worse than red on none.
  if (observed.kind === "level") {
    const matches = lines.flatMap((line, index) => (line.level === observed.value ? [index] : []));
    return placed(matches.length === 1 ? matches : [], false);
  }

  return NONE;
};
