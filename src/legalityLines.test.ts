import { describe, expect, it } from "vitest";

import { LegalityEvidence, LegalityFinding } from "@/types";

import { linesOf, markedLines } from "./legalityLines";

const finding = (over: Partial<LegalityFinding> = {}): LegalityFinding => ({
  rule: "sigilTraitLevel",
  subject: { kind: "sigil", index: 0 },
  observed: { kind: "level", value: 30 },
  allowed: { kind: "level", value: 15 },
  odds: null,
  ...over,
});

const sigil = (traits: { id: number; level: number }[]): LegalityEvidence => ({
  kind: "sigil",
  sigilId: 500,
  level: 15,
  traits,
});

/** The audit page's own call: mark against the lines the finding's own evidence
 * draws. The log view passes lines built from live player data instead, which is
 * why `markedLines` takes them rather than deriving them. */
const markOwnLines = (finding: LegalityFinding) => markedLines(finding, linesOf(finding.evidence));

describe("markedLines", () => {
  /** THE case the explanatory prose used to cover. The rule knows exactly which
   * trait is wrong — it carries its id — so the line can be marked outright and
   * "not a pair this sigil rolls" says nothing the red does not. */
  it("marks the exact trait a rule names by id", () => {
    const marked = markOwnLines(
      finding({
        rule: "sigilLockedPair",
        observed: { kind: "traitId", value: 77 },
        allowed: { kind: "traitIds", value: [12] },
        evidence: sigil([
          { id: 55, level: 15 },
          { id: 77, level: 15 },
        ]),
      })
    );

    expect(marked.lines).toEqual([1]);
  });

  /** A summon's bonus is its second line, and the bonus rules are always about
   * it — never the main trait sharing the item. */
  it("marks the bonus line for the two rules that judge a bonus", () => {
    const evidence: LegalityEvidence = {
      kind: "summon",
      summonId: 9,
      main: { id: 1, level: 9 },
      bonus: { id: 2, level: 9 },
    };

    for (const rule of ["summonBonusSource", "summonBonusMagnitude"] as const) {
      expect(markOwnLines(finding({ rule, observed: { kind: "amount", value: 75 }, evidence })).lines).toEqual([1]);
    }
  });

  /** A whole-set odds rule condemns the set, so every member is part of the
   * claim and every line is marked.
   *
   * But it is ONE claim about them together, so it is said ONCE, on the
   * heading. Said per line it repeated verbatim under all four overmasteries —
   * one finding rendered as four identical accusations. */
  it("marks every line of a whole-set claim and says it once on the heading", () => {
    const evidence: LegalityEvidence = {
      kind: "overmasteries",
      entries: [
        { id: 1, value: 20, flags: 0 },
        { id: 2, value: 30, flags: 0 },
      ],
    };

    expect(markOwnLines(finding({ rule: "overmasteryAllMaxed", evidence }))).toEqual({
      lines: [0, 1],
      perLine: false,
      markHeading: true,
    });
  });

  /** The counterpart: a claim that names ONE line stays beside that line, where
   * it can be read against the magnitude the line shows. */
  it("keeps a claim about a single line beside that line", () => {
    const marked = markOwnLines(
      finding({
        rule: "sigilLockedPair",
        observed: { kind: "traitId", value: 77 },
        evidence: sigil([
          { id: 55, level: 15 },
          { id: 77, level: 15 },
        ]),
      })
    );

    expect(marked).toEqual({ lines: [1], perLine: false, markHeading: false });
  });

  /** Nothing to point at means nothing to read a phrase against, so the claim
   * falls back to the item as a whole. */
  it("puts an unpinnable claim on the heading", () => {
    expect(markOwnLines(finding({ evidence: null })).markHeading).toBe(true);
  });

  /** A wrightstone's slots pair positionally with its caps, so each breached
   * slot is named exactly and a slot inside its cap is left alone. */
  it("pairs a per-slot list against a per-slot cap", () => {
    const marked = markOwnLines(
      finding({
        rule: "wrightstoneTraitLevel",
        subject: { kind: "wrightstone" },
        observed: { kind: "levels", value: [30, 20, 20] },
        allowed: { kind: "levels", value: [20, 15, 30] },
        evidence: {
          kind: "wrightstone",
          wrightstoneId: 4,
          traits: [
            { id: 1, level: 30 },
            { id: 2, level: 20 },
            { id: 3, level: 20 },
          ],
        },
      })
    );

    // Per-slot caps give each mark its own distinct claim, so these stay on
    // their lines however many of them there are.
    expect(marked).toEqual({ lines: [0, 1], perLine: true, markHeading: false });
  });

  it("marks the single line whose level matches a scalar observation", () => {
    const marked = markOwnLines(
      finding({
        evidence: sigil([
          { id: 1, level: 30 },
          { id: 2, level: 15 },
        ]),
      })
    );

    expect(marked.lines).toEqual([0]);
  });

  /** Two lines at the same level make the claim ambiguous. Red on the wrong
   * trait is a worse failure than red on none. */
  it("marks nothing when two lines could be the one meant", () => {
    const marked = markOwnLines(
      finding({
        observed: { kind: "level", value: 30 },
        evidence: sigil([
          { id: 1, level: 30 },
          { id: 2, level: 30 },
        ]),
      })
    );

    expect(marked.lines).toEqual([]);
  });

  /** An old row stored before the snapshot existed has nothing to mark, and
   * must not throw trying. */
  it("marks nothing when the finding carries no evidence", () => {
    expect(markOwnLines(finding({ evidence: null })).lines).toEqual([]);
  });
});

describe("linesOf", () => {
  it("draws a summon as its main trait then its bonus", () => {
    const lines = linesOf({
      kind: "summon",
      summonId: 9,
      main: { id: 1, level: 4 },
      bonus: { id: 2, level: 9 },
    });

    expect(lines).toEqual([
      { id: 1, level: 4 },
      { id: 2, level: 9 },
    ]);
  });

  it("has no lines for a claim about a count", () => {
    expect(linesOf({ kind: "masterTraits", observed: 63, allowed: 50 })).toEqual([]);
  });
});
