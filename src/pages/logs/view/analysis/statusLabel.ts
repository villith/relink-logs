import type { CharacterType, StatusInterval } from "@/types";

import type { Hostility, LabelKind } from "../metrics/types";
import { isStatusPin, statusPinKey } from "../statusUptime";
import type { AbilityLabelPlayer } from "./abilityLabel";

/** How a status row's key is spelled: the effect, the ability that caused it,
 * and the RTTI class that applied it — each of the latter two either a number
 * or the literal `unknown` where the hook could not attribute one. */
const STATUS_KEY = /^status:(\d+):(\d+|unknown):(\d+|unknown)$/;

/** The effect id inside a `status:<effect>:<cause>:<class>` key, or null for
 * anything that is not one — the same tolerance `statusLabelFor` shows a stale
 * pin. */
export const statusIdOfKey = (key: string): number | null => statusKeyParts(key)?.statusId ?? null;

/** All three ids inside a `status:<effect>:<cause>:<class>` key, or null for
 * anything that is not one. A null `causeId`/`classHash` is the literal
 * `unknown` segment. */
export const statusKeyParts = (
  key: string
): { statusId: number; causeId: number | null; classHash: number | null } | null => {
  const parsed = STATUS_KEY.exec(key);
  if (parsed === null) return null;
  return {
    statusId: Number(parsed[1]),
    causeId: parsed[2] === "unknown" ? null : Number(parsed[2]),
    classHash: parsed[3] === "unknown" ? null : Number(parsed[3]),
  };
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

/* A debuff holder row names either the SPAWN that held the effect or, where
 * the segmenter never placed it, the bare actor id. Both live in the row-key
 * grammar (`rowKey.ts`): `spawnRowSegment` reads the first and answers null for
 * the second, whose id indexes nothing a portrait could hang on, and the entity
 * ladder names each through its own branch. This module used to spell that
 * grammar a third time, in a regex of its own. */

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
 * Four sources, most specific first:
 *
 * 1. the applying character's own skill table, because a cause in the character
 *    bands IS that character's action id — the same id space the damage meter
 *    names (established by the status-cause RE investigation: 1100 is "Scourge
 *    (Dragonform)" both statically and live) — with `skills.default` carrying
 *    the global bands (sigil/trait, environment, perfect guard);
 * 2. the action the CASTER was performing at the apply, which names the rows
 *    the cause cannot: 9998 means no activated action produced the effect (a
 *    passive, a guardpoint, a summon aura, a transformation), so there is no
 *    action id recorded — but the caster was still mid-action;
 * 3. the applying status object's RTTI CLASS, which names the MECHANISM rather
 *    than the ability — less specific than 2, and available where 2 is not;
 * 4. the bare number, kept deliberately: a real but uncurated action id is
 *    honest, and it is the only thing distinguishing two such rows.
 *
 * The two inferred rungs sit ABOVE the number, not below it — this function
 * returns the number whenever nothing names the cause, so anything placed
 * after it could never fire. A cause no source names stays a number: id spaces
 * collide across characters, so fabricating a name from a numeric coincidence
 * is the one forbidden move.
 *
 * All three lookups are injected for the same reason `statusLabelFor` injects
 * its names — they need i18n and the party, and this stays pure. The last two
 * default, so every existing two-argument caller compiles unchanged. */
export const causeNameFor = (
  id: number | null,
  nameForCause: (id: number) => string,
  nameForCasterAction: () => string = () => "",
  nameForClass: () => string = () => ""
): string => {
  // `causeLabel` owns the unattributed test; re-spelling it here let the two
  // disagree about what counts as "no cause".
  const bare = causeLabel(id);
  if (bare === "") return "";
  return nameForCause(id as number) || nameForCasterAction() || nameForClass() || bare;
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

/** The action every interval of one row agrees its caster was performing when
 * the effect landed, or null where they disagree.
 *
 * Unanimity rather than the first one seen. A row is `(effect, cause, class)`
 * across every holder, and the caster action is deliberately NOT part of that
 * key — it is inferred rather than recorded, so keying on it would split rows
 * by a guess. One row can therefore span several actions, and naming it after
 * whichever interval happened to sort first is the same fabrication as naming
 * a cause from a numeric coincidence. Where they disagree the class rung below
 * is the honest answer.
 *
 * An interval with no caster action ABSTAINS rather than vetoes: every log
 * written before the field existed carries none at all, and one apply the hook
 * could not read must not silence the rest of the row. */
export const casterActionOf = (intervals: Pick<StatusInterval, "casterActionId">[]): number | null => {
  let agreed: number | null = null;
  for (const interval of intervals) {
    const action = interval.casterActionId;
    if (action === null) continue;
    if (agreed === null) agreed = action;
    else if (agreed !== action) return null;
  }
  return agreed;
};

/** `causeCandidatesOf` for one row key, selecting that row's intervals out of
 * the whole fight. Callers with many rows to label should group ONCE by
 * `statusPinKey` and call `causeCandidatesOf` per group instead — this scans
 * every interval, so a call per row is quadratic. */
export const causeCandidatesFor = (
  key: string,
  intervals: Pick<StatusInterval, "statusId" | "abilityId" | "statusClass" | "casterIndex">[],
  playerOf: (actorIndex: number) => AbilityLabelPlayer | undefined
): CharacterType[] =>
  causeCandidatesOf(
    intervals.filter((interval) => statusPinKey(interval) === key),
    playerOf
  );

/** Display name for a `status:<effect>:<cause>:<class>` row key.
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
