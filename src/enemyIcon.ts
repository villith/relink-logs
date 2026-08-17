import { emKeyOf } from "./emKey";
import { iconsByName } from "./iconMap";
import type { EnemyType } from "./types";

/**
 * Resolves an enemy type to its portrait, where the game drew one.
 *
 * The portraits come out of the SUMMON atlas — Relink's summons are the
 * primal-beast bosses, so their equip-screen art is enemy art for the boss
 * roster (43 of the 134 named enemies today). The portrait files are named by
 * the em id `emKeyOf` resolves.
 *
 * `undefined` is the common case, not an error — trash mobs have no portrait
 * anywhere in the game's UI (the bestiary renders live models).
 */
const ICONS = import.meta.glob<string>("./assets/game-icons/enemy/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

const BY_ID = iconsByName(ICONS);

/** The portrait URL for an enemy type, or `undefined` when the game has none. */
export const enemyIconUrl = (type: EnemyType | null): string | undefined => {
  if (type === null) return undefined;
  const emKey = emKeyOf(type);
  return emKey ? BY_ID.get(emKey.toLowerCase()) : undefined;
};
