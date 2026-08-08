import type { ActionType } from "@/types";

const BARE = ["LinkAttack", "SBA", "PerfectGuard", "PerfectGuardQuickening"] as const;
const PAYLOAD = ["StunEffect", "SupplementaryDamage", "DamageOverTime", "Normal", "Group"] as const;

/** A stable string for one `ActionType`, safe to put in a URL. */
export const abilityKey = (action: ActionType): string => {
  if (typeof action === "string") return action;
  const [name, payload] = Object.entries(action)[0];
  return `${name}:${payload}`;
};

const SUPPLEMENTARY = "SupplementaryDamage";

/** The FOLDED echo key — the one key every supplementary hit reduces to.
 *
 * `SupplementaryDamage(n)` carries the id of the skill that caused the echo, so
 * keyed raw each distinct cause is its own key: a table row, a chart band and a
 * hover-card entry repeated once per cause, every one of them reading
 * "Supplementary Damage". Folding onto payload 0 is what makes them one row,
 * and it is spelled HERE so the table's fold, the timeline's part keys and the
 * cast fold cannot fold to three different keys. */
export const SUPPLEMENTARY_ACTION = { [SUPPLEMENTARY]: 0 } as ActionType;
export const SUPPLEMENTARY_KEY = abilityKey(SUPPLEMENTARY_ACTION);

/** The CAUSE id inside an echo key, or null when the key names no echo — the
 * reading half of `abilityKey({ SupplementaryDamage: n })`, so the echo grammar
 * is not spelled by hand wherever an echo has to be recognised. */
export const supplementaryCause = (key: string): number | null => {
  const parsed = parseAbilityKey(key);
  return parsed !== null && typeof parsed === "object" && SUPPLEMENTARY in parsed
    ? (parsed as { SupplementaryDamage: number })[SUPPLEMENTARY]
    : null;
};

/** The namespace every ability ROW and chart BAND key carries.
 *
 * Row and band keys share one flat namespace (`player:`, `target:`, `enemy:`,
 * `taken:`, `skill:`, `source:`, `other`), and consumers dispatch on the prefix
 * — `bandLabelFor` resolves `skill:` through the skill namer and falls through
 * to the RAW KEY for anything it does not recognise. A producer that forgets the
 * prefix therefore does not throw: it silently prints "Normal:1" at the user.
 * That is exactly what the stun/SBA drill bands did before this was hoisted out
 * of the six places that spelled it by hand. */
const SKILL_PREFIX = "skill:";

/** A skill row/band key from its ability payload. Pair with [`skillKeyPayload`];
 * between them the `skill:` grammar has ONE author. */
export const skillKey = (payload: string): string => `${SKILL_PREFIX}${payload}`;

/** The ability payload inside a skill key, or null when the key is not one. */
export const skillKeyPayload = (key: string): string | null =>
  key.startsWith(SKILL_PREFIX) ? key.slice(SKILL_PREFIX.length) : null;

/** Inverse of `abilityKey`. Returns null for anything unrecognised, so a stale
 * or hand-edited URL degrades to "All" instead of throwing. */
export const parseAbilityKey = (key: string): ActionType | null => {
  if ((BARE as readonly string[]).includes(key)) return key as ActionType;

  const split = key.indexOf(":");
  if (split < 0) return null;
  const name = key.slice(0, split);
  const payload = key.slice(split + 1);
  if (!(PAYLOAD as readonly string[]).includes(name)) return null;

  if (name === "Group") return { Group: payload } as ActionType;
  const id = Number(payload);
  if (!Number.isInteger(id)) return null;
  return { [name]: id } as ActionType;
};
