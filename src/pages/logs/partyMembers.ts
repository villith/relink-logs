import { TFunction } from "i18next";

import { CharacterType, Log } from "@/types";
import { translateCharacterType } from "@/utils";

/** One person in a listed encounter's party, as the quest list draws them. */
export type PartyMember = {
  /** The party slot this member occupied, which is also the index the backend
   * stamped their legality verdicts with — so a finding can be attributed to
   * the person it was computed from. `null` on legacy version-0 logs, which
   * stored a joined name string and no slots at all: there is nothing to
   * attribute to, and `null` can never match an index. */
  slot: number | null;
  label: string;
};

type Options = {
  showDisplayNames: boolean;
  streamerMode: boolean;
  t: TFunction;
};

/** How one slot reads: the character, plus who was playing them when that is
 * both known and allowed to be shown. */
const label = (
  name: string | null,
  type: string | null,
  imported: boolean,
  { showDisplayNames, streamerMode, t }: Options
): string => {
  const characterName = translateCharacterType(type as CharacterType);

  // A slot with a character but no player name is an AI companion — except in
  // an imported log, where the character may be backfilled from damage events
  // and the name simply never recorded: whether a human played it is unknown,
  // so the bare character is all that can honestly be said.
  if (!name) return imported ? characterName : `${characterName} (${t("ui.logs.ai-companion")})`;
  if (!showDisplayNames || streamerMode) return characterName;

  return `${characterName} (${name})`;
};

/**
 * A listed log's party, one entry per occupied slot.
 *
 * Split out of the quest list's row because the row no longer renders one
 * joined string: each member is drawn separately so a flagged build can colour
 * exactly the person it belongs to. That attribution is the whole risk here —
 * hence a pure function with the slot arithmetic under test.
 */
export const partyMembers = (log: Log, options: Options): PartyMember[] => {
  // Legacy logs stored the party as one comma-joined string of character types.
  if (log.version === 0) {
    return log.name
      .split(", ")
      .filter(Boolean)
      .map((name) => ({
        slot: null,
        label: options.t(`characters:${name}`, `ui:characters.${name}`),
      }));
  }

  return (
    [
      { name: log.p1Name, type: log.p1Type },
      { name: log.p2Name, type: log.p2Type },
      { name: log.p3Name, type: log.p3Type },
      { name: log.p4Name, type: log.p4Type },
    ]
      // Numbered before filtering: an empty slot drops out of the list without
      // renumbering the ones after it, or a three-person party would attribute
      // every verdict one slot early.
      .map((player, slot) => ({ ...player, slot }))
      .filter((player) => player.name || player.type)
      .map((player) => ({
        slot: player.slot,
        label: label(player.name, player.type, log.imported ?? false, options),
      }))
  );
};
