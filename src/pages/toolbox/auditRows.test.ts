import { describe, expect, it } from "vitest";

import { LegalityFinding, LegalityFlaggedPlayer, LegalityPlayerFinding } from "@/types";

import { DEFAULT_FILTERS, applyFilters, auditRows, caseFor } from "./auditRows";

const sigilLevel: LegalityFinding = {
  rule: "sigilTraitLevel",
  subject: { kind: "sigil", index: 7 },
  observed: { kind: "level", value: 15 },
  allowed: { kind: "level", value: 10 },
  odds: null,
};
const sigilPair: LegalityFinding = {
  rule: "sigilLockedPair",
  subject: { kind: "sigil", index: 3 },
  observed: { kind: "traitIds", value: [1, 2] },
  allowed: { kind: "traitIds", value: [8, 9] },
  odds: null,
};
const perfect: LegalityFinding = {
  rule: "summonPerfectCount",
  subject: { kind: "summons" },
  observed: { kind: "count", value: 3 },
  allowed: { kind: "none" },
  odds: 4.7e-7,
};

const row = (logId: number, time: number, finding: LegalityFinding, questId?: number): LegalityPlayerFinding => ({
  logId,
  time,
  questId,
  finding,
});

const player = (displayName: string, findings: LegalityPlayerFinding[]): LegalityFlaggedPlayer => ({
  displayName,
  characterType: "Pl1000" as never,
  encounters: new Set(findings.map((r) => r.logId)).size,
  lastSeen: Math.max(...findings.map((r) => r.time)),
  findings,
});

// Flagged in two fights. The sigil-level finding repeats across both, because
// the same build was equipped both times — which is the normal case, and the
// thing `caseFor` exists to collapse.
const siunaus = player("siunaus", [
  row(10, 300, sigilLevel, 401),
  row(10, 300, sigilPair, 401),
  row(10, 300, perfect, 401),
  row(11, 200, sigilLevel, 402),
]);

describe("auditRows", () => {
  /** The rail is one row per person: name and character. The violations belong
   * to the detail pane, which is the only place they are drawn. */
  it("gives each person one row", () => {
    expect(auditRows([siunaus])).toHaveLength(1);
  });

  /** Name and character are drawn separately, so they arrive separately — the
   * page translates the character, this layer does not. */
  it("keeps the person's name and character apart", () => {
    const [entry] = auditRows([siunaus]);
    expect(entry.displayName).toBe("siunaus");
    expect(entry.characterType).toBe("Pl1000");
  });
});

describe("caseFor", () => {
  /** THE reason master–detail beats the old tree. The same build is usually
   * equipped in every flagged fight, so a person flagged six times is one bad
   * wrightstone seen six times. Stating it once is the whole point; the tree
   * made you open all six and read the identical block each time. */
  it("states each distinct finding once across every fight", () => {
    expect(caseFor(siunaus).evidence.map((row) => row.finding)).toEqual([sigilLevel, sigilPair, perfect]);
  });

  /** A build that CHANGED between fights is two different facts, so the values
   * join the identity — otherwise the second reading is silently swallowed. */
  it("keeps two readings of the same slot when the values differ", () => {
    const relevelled = { ...sigilLevel, observed: { kind: "level" as const, value: 30 } };
    const changed = player("changed", [row(1, 100, sigilLevel), row(2, 200, relevelled)]);

    expect(caseFor(changed).evidence).toHaveLength(2);
  });

  /** THE pairing that keeps an accusation honest. A finding's subject is a slot
   * index into the encounter it came from, so it can only be named against that
   * encounter — carrying the log alongside it is what stops the page resolving
   * an old finding against a newer build and accusing the wrong sigil. */
  it("carries the fight each finding came from", () => {
    const relevelled = { ...sigilLevel, observed: { kind: "level" as const, value: 30 } };
    const changed = player("changed", [row(1, 100, sigilLevel), row(2, 200, relevelled)]);

    // Newest first, and each finding keeps its own fight.
    expect(caseFor(changed).evidence.map((row) => row.logId)).toEqual([2, 1]);
  });

  /** The same build in every fight is the normal case, and it must still cost
   * exactly one encounter to name. */
  it("needs one encounter when the build never changed", () => {
    expect(caseFor(siunaus).evidenceLogIds).toEqual([10]);
  });

  /** A changed build needs one encounter per build — the price of naming each
   * one correctly — newest fight first. */
  it("needs one encounter per distinct build, newest first", () => {
    const relevelled = { ...sigilLevel, observed: { kind: "level" as const, value: 30 } };
    const changed = player("changed", [row(1, 100, sigilLevel), row(2, 200, relevelled)]);

    expect(caseFor(changed).evidenceLogIds).toEqual([2, 1]);
  });

  /** Every flagged fight is still listed — they are the links out to the log. */
  it("lists every flagged fight once, newest first", () => {
    expect(caseFor(siunaus).fights.map((f) => f.logId)).toEqual([10, 11]);
  });

  it("carries the quest each fight was, for the page to name", () => {
    expect(caseFor(siunaus).fights[0].questId).toBe(401);
  });

  /** Two sigil rules across two fights are still one "Impossible Sigil" — the
   * chips say what is wrong with the build, not how often it was measured. */
  it("summarises what the person is flagged for, each violation once", () => {
    expect(caseFor(siunaus).violations).toEqual(["impossibleSigil", "perfectSummons"]);
  });

  /** A person with no findings has no fight to read gear from, and the page
   * must not fetch log `undefined`. */
  it("has no evidence log when there is nothing to show", () => {
    expect(caseFor(player("empty", [])).evidenceLogIds).toEqual([]);
  });
});

describe("applyFilters", () => {
  it("keeps everyone when nothing is set", () => {
    const mixed = player("mixed", [row(1, 100, sigilLevel, 1), row(1, 100, perfect, 1)]);
    expect(applyFilters([siunaus, mixed], DEFAULT_FILTERS).map((p) => p.displayName)).toEqual(["siunaus", "mixed"]);
  });

  it("matches a name whatever the case", () => {
    expect(applyFilters([siunaus], { search: "SIUN" })).toHaveLength(1);
    expect(applyFilters([siunaus], { search: "nobody" })).toEqual([]);
  });

  /** Search looks someone up by name and expects all of them — it must never
   * cut the findings the way the old violation filter did. */
  it("keeps every finding of a person it matched", () => {
    const [found] = applyFilters([siunaus], { search: "siunaus" });
    expect(found.findings).toHaveLength(4);
  });
});
