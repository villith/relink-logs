import { iconsByName } from "./iconMap";

/**
 * Resolves a character id to its menu icon.
 *
 * The icons are the `mini` set sliced out of the game's `common_icon_mini`
 * atlas and named by character id, so the lookup is a straight filename match —
 * see `src/assets/character-icons/README.md`.
 *
 * `import.meta.glob` rather than 32 hand-written imports: the set changes when
 * the game adds a character, and a list that has to be edited by hand is a list
 * that will silently miss one.
 */
const ICONS = import.meta.glob<string>("./assets/character-icons/mini/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

const BY_ID = iconsByName(ICONS);

/**
 * Ids that share another character's art.
 *
 * `Pl2000` is what the hook reports for recruited Id, which the parser already
 * remaps to `Pl1900`; the atlas has no art under it. Kept here rather than at
 * the call site so a caller cannot forget it and quietly show a real party
 * member with no icon.
 */
const ALIASES: Record<string, string> = { Pl2000: "Pl1900" };

/** The icon URL for a character id, or `undefined` when there is no art for it. */
export const characterIconUrl = (characterId: string): string | undefined =>
  BY_ID.get(ALIASES[characterId] ?? characterId);
