/**
 * The Build Audit page's pure logic, kept out of the component so it can be
 * tested without a Tauri backend or a DOM.
 */

import { TFunction } from "i18next";

import { describeFinding } from "@/legality";
import { LegalityFlaggedPlayer, LegalityPlayerFinding, LegalitySubject } from "@/types";

/** Findings that make the same claim about the same thing, collapsed into one
 * line with the encounters it was seen in.
 *
 * A player who ran twenty fights with one modded summon has twenty identical
 * findings; showing them twenty times buries what is actually wrong. The count
 * is kept because repetition is itself the signal — a claim seen once could be
 * a misread, one seen across many fights is a build. */
export type AuditClaim = {
  /** Stable key: rule plus the exact thing it points at. */
  key: string;
  /** The sentence a reader judges, already translated. */
  text: string;
  impossible: boolean;
  /** Distinct encounters this claim was seen in. */
  encounters: number;
  /** Most recent encounter carrying it, for the "open log" link. */
  latestLogId: number;
  latestTime: number;
};

const subjectKey = (subject: LegalitySubject): string =>
  subject.index === undefined ? subject.kind : `${subject.kind}:${subject.index}`;

/**
 * One player's findings collapsed to distinct claims, worst first, then by how
 * many encounters carry them.
 *
 * `subjectName` is left empty: the audit page lists people across many logs and
 * does not hold their equipment, so a claim names what it can from the rule's
 * own numbers. The Builds and Equipment tabs are where a claim gets its item
 * name, because that is where the item is on screen.
 */
export const claimsFor = (t: TFunction, player: LegalityFlaggedPlayer): AuditClaim[] => {
  const byKey = new Map<string, AuditClaim & { logIds: Set<number> }>();

  for (const row of player.findings) {
    const key = `${row.finding.rule}|${subjectKey(row.finding.subject)}`;
    const existing = byKey.get(key);

    if (existing) {
      existing.logIds.add(row.logId);
      if (row.time > existing.latestTime) {
        existing.latestTime = row.time;
        existing.latestLogId = row.logId;
      }
      continue;
    }

    byKey.set(key, {
      key,
      text: describeFinding(t, row.finding, ""),
      impossible: row.finding.severity === "impossible",
      encounters: 0,
      latestLogId: row.logId,
      latestTime: row.time,
      logIds: new Set([row.logId]),
    });
  }

  return [...byKey.values()]
    .map(({ logIds, ...claim }) => ({ ...claim, encounters: logIds.size }))
    .sort(
      (a, b) =>
        Number(b.impossible) - Number(a.impossible) || b.encounters - a.encounters || b.latestTime - a.latestTime
    );
};

/** The most recent encounter a player was flagged in, for the header line. */
export const latestFinding = (player: LegalityFlaggedPlayer): LegalityPlayerFinding | undefined =>
  player.findings.reduce<LegalityPlayerFinding | undefined>(
    (latest, row) => (!latest || row.time > latest.time ? row : latest),
    undefined
  );
