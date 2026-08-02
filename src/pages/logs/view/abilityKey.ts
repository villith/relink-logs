import type { ActionType } from "@/types";

const BARE = ["LinkAttack", "SBA", "PerfectGuard", "PerfectGuardQuickening"] as const;
const PAYLOAD = ["StunEffect", "SupplementaryDamage", "DamageOverTime", "Normal", "Group"] as const;

/** A stable string for one `ActionType`, safe to put in a URL. */
export const abilityKey = (action: ActionType): string => {
  if (typeof action === "string") return action;
  const [name, payload] = Object.entries(action)[0];
  return `${name}:${payload}`;
};

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

