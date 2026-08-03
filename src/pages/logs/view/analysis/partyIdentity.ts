import type { ComputedPlayerState, EncounterState } from "@/types";
import { formatInPartyOrder } from "@/utils";

/** The party that decides IDENTITY — who each player is, what they are called
 * and which colour they own.
 *
 * Always the base load, never the scoped one. `formatInPartyOrder` assigns
 * `partyIndex` by array position, and the scoped fetch returns only the pinned
 * player, so slotting from it makes whoever is pinned slot 0 — inheriting slot
 * 0's name and colour. Figures still come from the scoped state; only identity
 * comes from here. */
export const identityPartyOf = (
  baseParty: EncounterState["party"] | null,
  scopedParty: EncounterState["party"] | null
): ComputedPlayerState[] => {
  const party = baseParty ?? scopedParty;
  return party ? formatInPartyOrder(party) : [];
};
