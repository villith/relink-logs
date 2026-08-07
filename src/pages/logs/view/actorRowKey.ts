/** The two ACTOR row-key namespaces, with one author.
 *
 * Row and band keys share a flat namespace (`player:`, `target:`, `enemy:`,
 * `taken:`, `skill:`, `other` — see `abilityKey.ts`'s `SKILL_PREFIX` note), and
 * consumers dispatch on the prefix. These two were being re-parsed by hand in
 * five places; a sixth copy for the timeline lanes is what this file exists to
 * prevent.
 *
 * `null` rather than `NaN` for anything unparseable: a `NaN` flows into a Map
 * lookup, matches nothing, and reports as an empty lane rather than as a bug. */

const PLAYER_PREFIX = "player:";
const SPAWN_PREFIX = "target:";

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

/** The spawn segment inside a spawn row key, or null when it is not one. */
export const spawnRowSegment = (key: string): number | null => indexAfter(key, SPAWN_PREFIX);
