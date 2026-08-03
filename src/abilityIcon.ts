import abilityMap from "./assets/game-icons/ability-map.json";

/**
 * Resolves ability art two ways: by equip slot, and by the meter's action id.
 *
 * The icons are named by the game's own key — character id + two-digit slot
 * number, exactly the `AB_PL####_NN` scheme `ability.tbl` uses — so the slot
 * lookup is a filename match like `characterIcon.ts`.
 *
 * Action ids live in a different id space (per-character action tables), so
 * that lookup goes through `ability-map.json`, generated from the game's
 * `pl####_action.msg` ability tags plus a name-join for the untagged variant
 * actions — the derivation and its two gotchas (junk tags, icon reuse via
 * ability.tbl) are documented in `scripts/gen-game-icons.mjs` and
 * `src/assets/game-icons/README.md`. An action with no entry is genuinely not
 * an ability cast (combos, link attacks, procs): `undefined` is data.
 */
const ICONS = import.meta.glob<string>("./assets/game-icons/ability/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

const BY_KEY = new Map(
  Object.entries(ICONS).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -".png".length), url])
);

/**
 * The icon URL for a character's ability slot (1-based, as the game numbers
 * them), or `undefined` when there is no art for it. Accepts the `Pl####`
 * spelling the rest of the app uses for character ids.
 */
export const abilityIconUrl = (characterId: string, slot: number): string | undefined =>
  BY_KEY.get(`${characterId.toLowerCase()}_${String(slot).padStart(2, "0")}`);

/**
 * The icon URL for an ACTION a character performed — the id space damage rows
 * and status causes are keyed by — or `undefined` for actions that are not
 * ability casts. `characterId` is the acting character (`Pl2000` for Id's
 * dragonform sub-actor, exactly as the meter attributes those actions).
 */
export const abilityIconForAction = (characterId: string, actionId: number): string | undefined => {
  const icon = (abilityMap as Record<string, Record<string, string>>)[characterId]?.[actionId];
  return icon === undefined ? undefined : BY_KEY.get(`pl${icon}`);
};
