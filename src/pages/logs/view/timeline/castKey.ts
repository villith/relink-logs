import { abilityKey, supplementaryCause } from "../abilityKey";
import type { EventRow } from "../events/eventRows";

/** The identity two events must share to belong to one cast.
 *
 * The KIND is always part of it: a death, a stun and an SBA are their own
 * events, and a cast fold that crossed kinds would swallow a death marker that
 * happened to land mid-cast.
 *
 * With `collapseEchoes`, a supplementary hit answers with the skill that caused
 * it (`SupplementaryDamage(n)` carries that id — see the protocol), so echo
 * damage clusters into the cast that produced it rather than beside it. */
export const castKeyOf = (event: EventRow, collapseEchoes: boolean): string => {
  const named = event.abilityKey ?? event.statusKey ?? "";
  if (collapseEchoes && event.abilityKey !== null) {
    const cause = supplementaryCause(event.abilityKey);
    if (cause !== null) return `${event.kind}|${abilityKey({ Normal: cause })}`;
  }
  return `${event.kind}|${named}`;
};
