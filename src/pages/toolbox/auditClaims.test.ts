import { describe, expect, it } from "vitest";

import { LegalityFinding, LegalityFlaggedPlayer } from "@/types";

import { claimsFor, latestFinding } from "./auditClaims";

const t = ((key: string) => key) as never;

const magnitude: LegalityFinding = {
  rule: "summonBonusMagnitude",
  severity: "impossible",
  subject: { kind: "summon", index: 3 },
  observed: { kind: "amount", value: 75 },
  allowed: { kind: "amount", value: 50 },
  odds: null,
};

const perfect: LegalityFinding = {
  rule: "summonPerfectCount",
  severity: "improbable",
  subject: { kind: "summons" },
  observed: { kind: "count", value: 3 },
  allowed: { kind: "none" },
  odds: 4.7e-7,
};

const player = (findings: { logId: number; time: number; finding: LegalityFinding }[]): LegalityFlaggedPlayer => ({
  displayName: "炎顺帝",
  characterType: "Pl2600" as never,
  impossible: findings.some((row) => row.finding.severity === "impossible"),
  encounters: new Set(findings.map((row) => row.logId)).size,
  lastSeen: Math.max(...findings.map((row) => row.time)),
  findings,
});

describe("claimsFor", () => {
  /** Twenty fights with one modded summon is ONE thing wrong, not twenty. */
  it("collapses the same claim across encounters and counts them", () => {
    const claims = claimsFor(
      t,
      player([
        { logId: 1, time: 100, finding: magnitude },
        { logId: 2, time: 200, finding: magnitude },
        { logId: 3, time: 300, finding: magnitude },
      ])
    );

    expect(claims).toHaveLength(1);
    expect(claims[0].encounters).toBe(3);
  });

  /** Repetition is the signal, so the same claim twice in ONE encounter must
   * not read as two encounters. */
  it("counts distinct encounters, not findings", () => {
    const claims = claimsFor(
      t,
      player([
        { logId: 1, time: 100, finding: magnitude },
        { logId: 1, time: 100, finding: magnitude },
      ])
    );

    expect(claims[0].encounters).toBe(1);
  });

  /** Same rule, different summon — two separate things wrong. */
  it("keeps claims about different subjects apart", () => {
    const other = { ...magnitude, subject: { kind: "summon", index: 0 } as const };
    const claims = claimsFor(
      t,
      player([
        { logId: 1, time: 100, finding: magnitude },
        { logId: 1, time: 100, finding: other },
      ])
    );

    expect(claims).toHaveLength(2);
  });

  it("puts proof above suspicion", () => {
    const claims = claimsFor(
      t,
      player([
        { logId: 1, time: 100, finding: perfect },
        { logId: 1, time: 100, finding: magnitude },
      ])
    );

    expect(claims.map((claim) => claim.impossible)).toEqual([true, false]);
  });

  /** The link has to open the encounter the reader would actually check.
   *
   * Both orders, because only one of them exercises the update: with the
   * newest row first the answer is right by accident, and a version that never
   * updated at all passed this test until the order was flipped. */
  it("links each claim at the most recent encounter carrying it", () => {
    const newestLast = claimsFor(
      t,
      player([
        { logId: 9, time: 100, finding: magnitude },
        { logId: 7, time: 300, finding: magnitude },
      ])
    );
    expect(newestLast[0].latestLogId).toBe(7);

    const newestFirst = claimsFor(
      t,
      player([
        { logId: 7, time: 300, finding: magnitude },
        { logId: 9, time: 100, finding: magnitude },
      ])
    );
    expect(newestFirst[0].latestLogId).toBe(7);
  });
});

describe("latestFinding", () => {
  it("finds the most recent encounter regardless of order", () => {
    const found = latestFinding(
      player([
        { logId: 1, time: 100, finding: magnitude },
        { logId: 2, time: 900, finding: perfect },
        { logId: 3, time: 500, finding: magnitude },
      ])
    );

    expect(found?.logId).toBe(2);
  });
});
