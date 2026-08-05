import attackMap from "../src-tauri/assets/enemy-attack-map.json";
import enemies from "../src-tauri/lang/en/enemies.json";
import type { ActionType, EnemyType } from "./types";

/**
 * The edge from an enemy's attack to its cast-bar callout name.
 *
 * Two halves, kept apart on purpose. The NAMES are generated from the game's
 * own `text_battle.msg` into `lang/<lang>/enemy-attacks.json`, keyed
 * `EM#### -> ordinal -> text` (the ordinal is the `<n>` of `TXT_BT_<em>_<n>`).
 * The ID→ordinal edge is NOT derivable from game data: the game reaches a
 * callout through the enemy's FSM state, never through an action-id table (no
 * `TXT_BT` format string exists; the keys are spelled out inline behind a
 * switch on a per-enemy state field). So it lives in
 * `assets/enemy-attack-map.json` as hand-verified pairs from live capture, and
 * ships empty until someone fights the boss.
 *
 * Which is why every lookup here answers `null` freely: an unmapped attack is
 * the normal case, not a failure, and the caller's "Attack N" fallback is the
 * honest thing to show.
 */
type AttackMap = Record<string, Record<string, number>>;

const EM_KEYS = enemies as Record<string, { key?: string }>;

/** Wire `EnemyType` -> em id key ("EM7000"), the same hash→key edge
 * `enemyIcon.ts` resolves through. */
export const emKeyOf = (type: EnemyType): string | null =>
  typeof type === "string" ? type : EM_KEYS[type.Unknown.toString(16).padStart(8, "0")]?.key ?? null;

/** The `TXT_BT` callout ordinal for one (enemy, attack), or null where the map
 * has no edge — most attacks: only signature moves are named at all, and only
 * for bosses someone has derived pairs for. */
export const enemyAttackOrdinal = (
  enemyType: EnemyType,
  actionId: ActionType,
  map: AttackMap = attackMap as AttackMap
): number | null => {
  if (typeof actionId !== "object" || actionId === null || !("Normal" in actionId)) return null;
  const emKey = emKeyOf(enemyType);
  if (emKey === null) return null;
  return map[emKey]?.[String(actionId.Normal)] ?? null;
};
