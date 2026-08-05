import type { CharacterType, StatusInterval } from "@/types";

import type { Hostility, LabelKind } from "../metrics/types";
import { isStatusPin, statusPinKey } from "../statusUptime";
import type { AbilityLabelPlayer } from "./abilityLabel";

/** How a status row's key is spelled: the effect, then the ability that caused
 * it, or the literal `unknown` where the hook could not attribute one. */
const STATUS_KEY = /^status:(\d+):(\d+|unknown)$/;

/** The effect id inside a `status:<effect>:<cause>` key, or null for anything
 * that is not one — the same tolerance `statusLabelFor` shows a stale pin. */
export const statusIdOfKey = (key: string): number | null => statusKeyParts(key)?.statusId ?? null;

/** Both ids inside a `status:<effect>:<cause>` key, or null for anything that
 * is not one. `causeId` null = the literal `unknown` cause. */
export const statusKeyParts = (key: string): { statusId: number; causeId: number | null } | null => {
  const parsed = STATUS_KEY.exec(key);
  if (parsed === null) return null;
  return { statusId: Number(parsed[1]), causeId: parsed[2] === "unknown" ? null : Number(parsed[2]) };
};

/** What a status table's rows currently ARE, for labelling them and for naming
 * the column above them.
 *
 * The PIN decides whether they are effects or holders, exactly as `statusRows`
 * decides which rows to build; the HOSTILITY decides what a holder is — a
 * player on the friendly side, an enemy spawn on the enemy side. The tab
 * cannot: with the hostility switch either tab can show either side. */
export const statusRowKindFor = (pin: string | null, hostility: Hostility): LabelKind =>
  isStatusPin(pin) ? (hostility === "friendly" ? "player" : "target") : "status";

/** How a debuff holder row names the enemy that held the effect: the SPAWN it
 * belonged to, or the bare actor id when the segmenter never placed it. */
const TARGET_ROW = /^(target|actor):(\d+)$/;

/** The spawn segment inside a `target:<n>` row label, or null — including for
 * `actor:<id>` rows, whose bare id indexes nothing a portrait could hang on. */
export const targetRowSegment = (label: string): number | null => {
  const parsed = TARGET_ROW.exec(label);
  return parsed !== null && parsed[1] === "target" ? Number(parsed[2]) : null;
};

/** Display name for a debuff holder row.
 *
 * Two spellings because there are two things to say. `target:<n>` indexes the
 * response's `targetEntries`, which is what carries an enemy's name and its
 * "#n" — the actor index cannot, because the game reissues a dead boss's index
 * to the next one. `actor:<id>` is the fallback for an enemy with no segment at
 * all (a phantom marker actor the segmenter skips): its window is real capture,
 * so the row stays, showing the only identity there is.
 *
 * `labelForTarget` is injected for the same reason `statusLabelFor` injects its
 * names — it needs i18n and the entries vector, and this stays pure. */
export const targetRowLabel = (label: string, labelForTarget: (segment: number) => string): string => {
  const parsed = TARGET_ROW.exec(label);
  if (!parsed) return label;

  const [, kind, id] = parsed;
  return kind === "target" ? labelForTarget(Number(id)) : id;
};

/** The hook's `+0x4c` cause discriminator, as a bare number.
 *
 * The numeric fallback under `causeNameFor`: it is what keeps two abilities
 * granting one effect on separate rows when no table names the cause.
 * All-ones is the game's own "no value" and 0 is what appliers pass when
 * there is no cause, so both read as unattributed instead of as a number the
 * user can do nothing with. */
export const causeLabel = (id: number | null): string =>
  id === null || id === 0 || id === 0xffffffff ? "" : String(id);

/** Display name for the `+0x4c` cause discriminator.
 *
 * A cause in the character bands IS the applying character's action id — the
 * same id space the damage meter names (established by the status-cause RE
 * investigation: 1100 is "Scourge (Dragonform)" both statically and live) —
 * so it resolves through the same per-character skill tables, with
 * `skills.default` carrying the global bands (sigil/trait, environment,
 * perfect guard). A cause no table names stays a number: id spaces collide
 * across characters, so fabricating a name from a numeric coincidence is the
 * one forbidden move.
 *
 * `nameForCause` is injected for the same reason `statusLabelFor` injects its
 * names — the lookup needs i18n and the party, and this stays pure. */
export const causeNameFor = (id: number | null, nameForCause: (id: number) => string): string => {
  // `causeLabel` owns the unattributed test; re-spelling it here let the two
  // disagree about what counts as "no cause".
  const bare = causeLabel(id);
  return bare === "" ? "" : nameForCause(id as number) || bare;
};

/** Candidate character types for naming one status row's cause: the CASTERS
 * of that row's own intervals, plus their child (sub-actor) types. The child
 * types matter: Id's Dragonform Burn arrives from the Pl2000 sub-actor, and
 * only Pl2000's table names its actions — the parent Pl1900 cannot.
 *
 * The casters, never the whole party: a cause is the applying character's
 * action id, and action ids collide across characters — the party scan named
 * Eustace's supp-DMG cause 1500 with Id's "Ragnarok Form", and Id's own cause
 * 1200 with Eustace's "Play with Fire", purely by party order (log 1636). A
 * row whose casters resolve to no player gets no candidates at all: the
 * shared bands can still name it, and past them the number is the honest
 * answer.
 *
 * `playerOf` is injected for the same reason the other lookups here are —
 * it needs the view's actor-indexed party, and this stays pure. */
export const causeCandidatesOf = (
  intervals: Pick<StatusInterval, "casterIndex">[],
  playerOf: (actorIndex: number) => AbilityLabelPlayer | undefined
): CharacterType[] => {
  const seen = new Set<CharacterType>();
  // One caster contributes the same types however many intervals it holds, and
  // reading them means walking its whole skill breakdown — so each is walked
  // once per row rather than once per interval.
  const walked = new Set<number>();
  for (const interval of intervals) {
    const casterIndex = interval.casterIndex;
    if (casterIndex === null || walked.has(casterIndex)) continue;
    walked.add(casterIndex);
    const caster = playerOf(casterIndex);
    if (!caster) continue;
    seen.add(caster.characterType);
    for (const skill of caster.skillBreakdown) {
      if (skill.childCharacterType) seen.add(skill.childCharacterType);
    }
  }
  return [...seen];
};

/** `causeCandidatesOf` for one row key, selecting that row's intervals out of
 * the whole fight. Callers with many rows to label should group ONCE by
 * `statusPinKey` and call `causeCandidatesOf` per group instead — this scans
 * every interval, so a call per row is quadratic. */
export const causeCandidatesFor = (
  key: string,
  intervals: Pick<StatusInterval, "statusId" | "abilityId" | "casterIndex">[],
  playerOf: (actorIndex: number) => AbilityLabelPlayer | undefined
): CharacterType[] =>
  causeCandidatesOf(
    intervals.filter((interval) => statusPinKey(interval) === key),
    playerOf
  );

/** Display name for a `status:<effect>:<cause>` row key.
 *
 * Reads as `Attack Up (Signo Drive)` — effect first so that two abilities
 * granting one effect sort next to each other, cause in parentheses because
 * they are nonetheless two separate rows.
 *
 * Both names are injected rather than looked up here, for the same reason
 * `abilityLabelFor` injects `skillName`: the lookups need i18n and the settings
 * store, and this stays a pure function. An effect with no name falls back to
 * its raw id — status.tbl is not extracted yet, so that is the shipping path
 * rather than a corner case, and it is better than a blank row.
 *
 * Anything that is not a status key is handed back untouched: a stale or
 * hand-edited pin, where showing it to the user is what explains the empty
 * table. */
export const statusLabelFor = (
  key: string,
  t: (key: string, vars?: Record<string, unknown>) => string,
  names: { effect: (statusId: number) => string; cause: (abilityId: number | null) => string }
): string => {
  const parsed = STATUS_KEY.exec(key);
  if (!parsed) return key;

  const [, statusId, causeId] = parsed;
  const abilityId = causeId === "unknown" ? null : Number(causeId);

  return t("ui.logs.buff-label", {
    effect: names.effect(Number(statusId)) || t("ui.logs.buff-effect-unnamed", { id: statusId }),
    cause: names.cause(abilityId) || t("ui.logs.buff-cause-unknown"),
  });
};
