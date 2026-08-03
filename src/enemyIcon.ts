import enemies from "../src-tauri/lang/en/enemies.json";
import type { EnemyType } from "./types";

/**
 * Resolves an enemy type to its portrait, where the game drew one.
 *
 * The portraits come out of the SUMMON atlas — Relink's summons are the
 * primal-beast bosses, so their equip-screen art is enemy art for the boss
 * roster (43 of the 134 named enemies today). The wire form of `EnemyType` is
 * always `{ Unknown: hash }`; the hash resolves through the same
 * `enemies.json` rows the name lookup uses, whose `key` field is the em id
 * the portrait files are named by. The English bundle specifically: the
 * hash → em-id edge is language-independent, and `en` is the one bundle
 * guaranteed present.
 *
 * `undefined` is the common case, not an error — trash mobs have no portrait
 * anywhere in the game's UI (the bestiary renders live models).
 */
const ICONS = import.meta.glob<string>("./assets/game-icons/enemy/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

const BY_ID = new Map(
  Object.entries(ICONS).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -".png".length), url])
);

const EM_KEYS = enemies as Record<string, { key?: string }>;

/** The portrait URL for an enemy type, or `undefined` when the game has none. */
export const enemyIconUrl = (type: EnemyType | null): string | undefined => {
  if (type === null) return undefined;
  const emKey = typeof type === "string" ? type : EM_KEYS[type.Unknown.toString(16).padStart(8, "0")]?.key;
  return emKey ? BY_ID.get(emKey.toLowerCase()) : undefined;
};
