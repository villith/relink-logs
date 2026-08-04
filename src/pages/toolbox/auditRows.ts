/**
 * The Cheat Audit page's two levels, as pure data.
 *
 * The page asks one question — **who have I played with that cheats, and what
 * exactly did they do?** — so it needs two shapes and no more:
 *
 *   1. `auditRows` — one entry per person for the rail: name and character.
 *                    What they were flagged for belongs to the detail pane,
 *                    which is the only place it is drawn.
 *   2. `caseFor`   — one person's whole case: the distinct findings against
 *                    them, which fight to name the gear from, and every fight
 *                    they were flagged in.
 *
 * There used to be a third level, one row per flagged fight, because the page
 * was a tree. It went with the tree: a person flagged in six fights is almost
 * always ONE bad build seen six times, and making a reader open all six to
 * learn that was the page's central waste.
 *
 * No i18next here: names of characters, quests and equipment all come from
 * bundles the page already has, and keeping this layer free of them is what
 * lets it be tested as data.
 */

import { CharacterType, LegalityFinding, LegalityFlaggedPlayer } from "@/types";
import { LegalityTone, VIOLATIONS, Violation, findingsTone, toneOfViolations, violationOf } from "@/violations";

/** One person, as the rail lists them. */
export type AuditRow = {
  key: string;
  displayName: string;
  characterType: CharacterType;
  lastSeen: number;
  /** How everything against them reads together — "lucky" draws their name
   * gold, so a farmer is never listed looking like the cheats around them. */
  tone: LegalityTone | undefined;
};

/** One flagged fight, as a row of the case's table of contents. */
export type AuditFight = {
  logId: number;
  time: number;
  questId?: number | null;
  /**
   * The entry this fight jumps to — the log whose evidence group holds what
   * this fight was flagged for.
   *
   * Usually itself. It differs whenever a fight's findings all deduplicated
   * into a newer fight's entry, which is the normal case: the same build worn
   * six times has one entry and six fights, and five of those fights would
   * otherwise point at an entry the page never drew.
   */
  entryLogId: number;
};

/**
 * One finding, WITH the fight it was computed from.
 *
 * The pairing is not decoration. A finding's subject is a slot index — `Sigil(7)`
 * means "slot 7 of THAT encounter's player data" — so a finding can only be
 * named against its own encounter. Resolving it against a different one names
 * whatever sigil happens to occupy that slot there, which is how a build the
 * rules never flagged ends up wearing someone else's accusation.
 */
export type AuditEvidence = {
  finding: LegalityFinding;
  /** The most recent fight this exact finding was computed from. */
  logId: number;
};

/**
 * Everything the detail pane shows for one person.
 *
 * `evidenceLogIds` are the encounters the page must fetch to put names to the
 * gear. Usually one: the same build is normally equipped in every flagged
 * fight, so deduplication collapses everything onto the newest log. A person
 * who changed their gear needs one per distinct build, and gets it.
 */
export type AuditCase = {
  violations: Violation[];
  /** The case's tone as a whole, matching the rail's read of the same person. */
  tone: LegalityTone | undefined;
  evidence: AuditEvidence[];
  fights: AuditFight[];
  /** Distinct logs the evidence needs, newest fight first. */
  evidenceLogIds: number[];
};

/** Search only. The violation picker went with the tree — it filtered a list
 * of five that the rail already shows in full. */
export type AuditFilters = {
  search: string;
};

export const DEFAULT_FILTERS: AuditFilters = { search: "" };

/** The people a search keeps, whole. You look someone up by name and expect all
 * of them, so this never cuts a matched person's findings. */
export const applyFilters = (players: LegalityFlaggedPlayer[], filters: AuditFilters): LegalityFlaggedPlayer[] => {
  const needle = filters.search.trim().toLowerCase();
  if (needle === "") return players;
  return players.filter((player) => player.displayName.toLowerCase().includes(needle));
};

/** Violations present in a set of findings, always in `VIOLATIONS` order so the
 * same build reads the same way wherever it appears. */
const violationsIn = (findings: LegalityFinding[]): Violation[] => {
  const present = new Set(findings.map((finding) => violationOf(finding.rule)));
  return VIOLATIONS.filter((violation) => present.has(violation));
};

/** What identifies one person in the rail. Exported so the lookup map the page
 * builds is keyed by exactly what the rows carry — the two drifting apart would
 * leave a selected row permanently unresolvable. */
export const playerKey = (player: { displayName: string; characterType: CharacterType }): string =>
  `${player.displayName}-${player.characterType}`;

export const auditRows = (players: LegalityFlaggedPlayer[]): AuditRow[] =>
  players.map((player) => ({
    key: playerKey(player),
    displayName: player.displayName,
    characterType: player.characterType,
    lastSeen: player.lastSeen,
    tone: findingsTone(player.findings.map((row) => row.finding)),
  }));

/** What makes a finding distinct: the same rule against the same slot is the
 * same fact however many fights measured it. The VALUES join the key so a build
 * that changed between fights still shows both readings rather than silently
 * collapsing to whichever was seen first. */
const findingKey = (finding: LegalityFinding): string =>
  JSON.stringify([finding.rule, finding.subject, finding.observed, finding.allowed]);

export const caseFor = (player: LegalityFlaggedPlayer): AuditCase => {
  // Sorted here rather than trusted from the caller: "the first sighting is the
  // most recent one" is what makes the dedup below keep the newest fight for
  // each finding, and that is the fight its gear will be named from.
  const rows = [...player.findings].sort((a, b) => b.time - a.time || b.logId - a.logId);

  const byKey = new Map<string, AuditEvidence>();
  const byLog = new Map<number, AuditFight>();

  for (const row of rows) {
    const key = findingKey(row.finding);
    if (!byKey.has(key)) byKey.set(key, { finding: row.finding, logId: row.logId });
    // Read back through `byKey` rather than using `row.logId`: that is what
    // resolves a fight to the entry that absorbed it. Newest-first ordering is
    // what makes it well defined — by the time a fight is first seen, the entry
    // for its newest finding has already been claimed.
    if (!byLog.has(row.logId))
      byLog.set(row.logId, {
        logId: row.logId,
        time: row.time,
        questId: row.questId,
        entryLogId: byKey.get(key)?.logId ?? row.logId,
      });
  }

  const evidence = [...byKey.values()];
  const fights = [...byLog.values()].sort((a, b) => b.time - a.time || b.logId - a.logId);

  // Newest fight first, matching `fights`, so the pane reads chronologically:
  // what they are wearing now, then what they wore before.
  const order = new Map(fights.map((fight, index) => [fight.logId, index]));
  const evidenceLogIds = [...new Set(evidence.map((row) => row.logId))].sort(
    (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)
  );

  const violations = violationsIn(evidence.map((row) => row.finding));

  return {
    violations,
    tone: toneOfViolations(violations),
    evidence,
    fights,
    evidenceLogIds,
  };
};
