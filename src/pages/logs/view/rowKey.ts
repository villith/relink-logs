import type { ActionType, EnemyType } from "@/types";

import { skillKey, skillKeyPayload } from "./abilityKey";
import { isStatusPin } from "./statusUptime";

/**
 * The flat row/band key namespace, with ONE author.
 *
 * Every table row, chart band, selector option and timeline lane in the view is
 * addressed by a string in this grammar, and consumers dispatch on its prefix.
 * Before this file the prefixes had five authors between them — `skill:` in
 * `abilityKey.ts`, `status:` in `statusUptime.ts`, `player:`/`target:` in
 * `actorRowKey.ts`, `enemy:` in `metrics/damageDone.ts`, and `taken:`, `actor:`
 * and `source:` nowhere at all — while a dozen more files spelled the literals
 * by hand, in `startsWith` chains and three separate regexes.
 *
 * That is not a tidiness complaint. A consumer that forgets a branch does not
 * throw: `bandLabelFor` falls through to the RAW KEY and prints "Normal:1000"
 * at the user, and every icon resolver answers `undefined`, which renders as a
 * row with no picture. Both failures look like missing data rather than like a
 * bug, which is why they kept reaching the user one surface at a time.
 *
 * So the grammar is written once, read once (`rowRefOf`), and every surface
 * dispatches on the parsed union instead of on a prefix it spelled itself. A
 * new namespace is a new variant, and TypeScript's exhaustiveness then names
 * every surface that has to answer for it.
 *
 * Unparseable is `null` rather than a throw: these keys reach the view from
 * bookmarked URLs and from cached payloads written by older binaries, and a row
 * renderer that throws takes the whole tab down over one stale pin.
 */

/** One party member, by `ComputedPlayerState.index` (the actor index a pin
 * carries — NOT the party slot, which a scoped fetch renumbers). */
const PLAYER_PREFIX = "player:";

/** One enemy SPAWN, by its index into the response's `targetEntries`. Spawn and
 * not actor index, because the game reissues a dead boss's actor index to the
 * next one and an index-keyed row would fuse the two. */
const SPAWN_PREFIX = "target:";

/** The holder fallback for an enemy the segmenter never placed — a phantom
 * marker actor. Its window is real capture so the row stays, but a bare actor
 * id indexes no spawn: it has no portrait and no colour of its own. */
const ACTOR_PREFIX = "actor:";

/** One enemy TYPE, merging every spawn of that type. Coarser than a spawn on
 * purpose: `SkillState.targets` records a type, so rows built from it cannot
 * point at one spawn and must not pretend to. */
const ENEMY_PREFIX = "enemy:";

/** One enemy ATTACK on the damage-taken tab, as an `{enemyType, actionId}`
 * pair. Not folded by attack across attackers: GBFR action ids are per-enemy id
 * spaces, so "action 1" from two enemies is two unrelated moves. */
const TAKEN_PREFIX = "taken:";

/** One SBA gauge CAUSE — a rise no skill row can hold. Self-naming (the row
 * carries its own `labelKey`), so it is not an ability and must never reach an
 * ability join. */
const SBA_CAUSE_PREFIX = "source:";

/** The row key the unattributed SBA remainder carries, shared with the
 * backend's band of the same name so the two are one identity.
 *
 * A `skill:` key that names no skill — the one exception in the grammar, and
 * the reason `rowRefOf` tests the gauge causes BEFORE the ability prefix. */
export const SBA_UNATTRIBUTED_KEY = skillKey("unattributed");

/** The rollup band: whatever ranked past the chart's cap, summed. A reserved
 * word rather than a key in any namespace, so it cannot collide with a band. */
export const ROLLUP_KEY = "other";

/** The Total series. Reserved for the same reason — it is the sum OF the bands
 * rather than one of them. */
export const TOTAL_KEY = "total";

const indexAfter = (key: string, prefix: string): number | null => {
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  if (rest === "") return null;
  const value = Number(rest);
  return Number.isInteger(value) ? value : null;
};

/** The row key for one party member, by `ComputedPlayerState.index`. */
export const playerRowKey = (index: number): string => `${PLAYER_PREFIX}${index}`;

/** The player index inside a player row key, or null when it is not one. */
export const playerRowIndex = (key: string): number | null => indexAfter(key, PLAYER_PREFIX);

/** The row key for one enemy SPAWN, by its index into `targetEntries`. */
export const spawnRowKey = (segment: number): string => `${SPAWN_PREFIX}${segment}`;

/** The spawn segment inside a spawn row key, or null when it is not one —
 * including for `actor:` rows, whose bare id indexes nothing. */
export const spawnRowSegment = (key: string): number | null => indexAfter(key, SPAWN_PREFIX);

/** The holder row key for an enemy with no spawn segment. */
export const actorFallbackKey = (actorIndex: number): string => `${ACTOR_PREFIX}${actorIndex}`;

/** The row key naming one enemy TYPE. The label that goes with it IS the JSON
 * this wraps, which is why `parseEnemyRow` reads a bare payload. */
export const enemyRowKey = (type: EnemyType): string => `${ENEMY_PREFIX}${JSON.stringify(type)}`;

/** The `EnemyType` an enemy row's LABEL spells, or null for anything that is
 * not one.
 *
 * Tolerant of a malformed label for the same reason `statusLabelFor` is of a
 * stale pin: `translateEnemyType` and `enemyIconUrl` both answer null with
 * "unknown", which beats throwing inside a row renderer. */
export const parseEnemyRow = (label: string): EnemyType | null => {
  try {
    return JSON.parse(label) as EnemyType;
  } catch {
    return null;
  }
};

/** What a `takenAttack` row's LABEL spells: the attacker and the attack, both
 * halves as their raw wire shapes so the view (which owns i18n) can name and
 * illustrate each. */
export const takenAttackRowLabel = (enemyType: EnemyType, actionId: ActionType): string =>
  JSON.stringify({ enemyType, actionId });

/** The row key for one enemy attack, off the label above. */
export const takenRowKey = (label: string): string => `${TAKEN_PREFIX}${label}`;

/** The reading half of `takenAttackRowLabel`. Tolerant for the same reason
 * `parseEnemyRow` is. */
export const takenAttackRowParts = (label: string): { enemyType: EnemyType; actionId: ActionType } | null => {
  try {
    const parts = JSON.parse(label) as { enemyType: EnemyType; actionId: ActionType };
    return parts && typeof parts === "object" && "enemyType" in parts && "actionId" in parts ? parts : null;
  } catch {
    return null;
  }
};

/** The row key for one SBA gauge cause. The id half discriminates where the
 * kind alone cannot (one effect record from another). */
export const sbaCauseRowKey = (kind: string, id: number | null): string =>
  id === null ? `${SBA_CAUSE_PREFIX}${kind}` : `${SBA_CAUSE_PREFIX}${kind}:${id}`;

/** The `<kind>[:<id>]` payload inside a gauge-cause key, or null when the key
 * is not one. The unattributed remainder is NOT one: it wears a `skill:` key
 * and names itself through its own label key. */
export const sbaCausePayload = (key: string): string | null =>
  key.startsWith(SBA_CAUSE_PREFIX) ? key.slice(SBA_CAUSE_PREFIX.length) : null;

/**
 * What one row or band key names.
 *
 * The vocabulary is `LabelKind`'s (`metrics/types.ts`) wherever the two overlap,
 * because that is what `MetricRow.kind` already declares — one taxonomy, so a
 * row and the band that decomposes it cannot be classified differently.
 *
 * The three variants beyond it are the things that are NOT entities and must
 * never reach an entity join: `actor` (a holder with no spawn behind it),
 * `sbaCause` and `rollup`/`total` (self-naming reserved words).
 */
export type RowRef =
  | { kind: "player"; index: number }
  | { kind: "target"; segment: number }
  | { kind: "actor"; actorIndex: number }
  | { kind: "enemy"; enemyType: EnemyType | null }
  | { kind: "takenAttack"; enemyType: EnemyType; actionId: ActionType }
  | { kind: "ability"; rowKey: string }
  | { kind: "status"; statusKey: string }
  | { kind: "sbaCause"; key: string }
  | { kind: "rollup" }
  | { kind: "total" };

/**
 * The one reader of the grammar.
 *
 * Branch ORDER is load-bearing twice over:
 *
 * - the gauge causes are tested before `skill:`, because the unattributed
 *   remainder (`SBA_UNATTRIBUTED_KEY`) wears a skill key it has no ability for
 *   — sent through the ability join it draws whichever art the fallback lands
 *   on, under a name it never asked for;
 * - the bare-index form is tested LAST, because the per-player chart keys its
 *   series by actor index alone. Those series predate the grammar and carry
 *   none of it, so a key that is only digits is a player — but only once every
 *   prefixed form has been ruled out.
 *
 * `null` for anything unrecognised, which callers render as the raw key: for a
 * stale or hand-edited URL, showing it back is what tells the user what is
 * wrong.
 */
export const rowRefOf = (key: string): RowRef | null => {
  if (key === ROLLUP_KEY) return { kind: "rollup" };
  if (key === TOTAL_KEY) return { kind: "total" };
  if (key === SBA_UNATTRIBUTED_KEY || sbaCausePayload(key) !== null) return { kind: "sbaCause", key };

  const player = playerRowIndex(key);
  if (player !== null) return { kind: "player", index: player };

  const segment = spawnRowSegment(key);
  if (segment !== null) return { kind: "target", segment };

  const actorIndex = indexAfter(key, ACTOR_PREFIX);
  if (actorIndex !== null) return { kind: "actor", actorIndex };

  if (key.startsWith(ENEMY_PREFIX)) return { kind: "enemy", enemyType: parseEnemyRow(key.slice(ENEMY_PREFIX.length)) };

  if (key.startsWith(TAKEN_PREFIX)) {
    const parts = takenAttackRowParts(key.slice(TAKEN_PREFIX.length));
    // A malformed payload is not a taken row: it has no attacker to name it
    // after, and an `{undefined, undefined}` pair would be named "unknown —
    // Attack undefined" rather than reported as the stale key it is.
    return parts === null ? null : { kind: "takenAttack", ...parts };
  }

  // Just the prefix test: the full `status:<effect>:<cause>:<class>` shape is
  // `statusLabel.ts`'s to validate, and a status key that fails its own regex
  // is still a status row (a stale pin, which that module renders verbatim)
  // rather than an ability.
  if (isStatusPin(key)) return { kind: "status", statusKey: key };

  const ability = skillKeyPayload(key);
  if (ability !== null) return { kind: "ability", rowKey: ability };

  // The per-player chart's own series keys — an actor index and nothing else.
  return /^\d+$/.test(key) ? { kind: "player", index: Number(key) } : null;
};

/** Re-exported so a caller that dispatches on the grammar imports it from the
 * grammar's own module rather than from the two files that happen to own these
 * halves. */
export { skillKey, skillKeyPayload };
