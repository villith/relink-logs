import enemies from "../src-tauri/lang/en/enemies.json";
import type { EnemyType } from "./types";

const EM_KEYS = enemies as Record<string, { key?: string }>;

/** Wire `EnemyType` -> em id key ("EM7000").
 *
 * Its own module because both the attack-name lookup and the portrait lookup
 * need the edge, and neither should drag the other's assets into its bundle.
 * The English bundle specifically: the hash → em-id edge is language-independent
 * and `en` is the one bundle guaranteed present. The eight-digit pad is
 * load-bearing — a hash with a leading zero misses its row.
 */
export const emKeyOf = (type: EnemyType): string | null =>
  typeof type === "string" ? type : EM_KEYS[type.Unknown.toString(16).padStart(8, "0")]?.key ?? null;
