import statusMap from "./assets/game-icons/status-map.json";
import { iconsByName } from "./iconMap";

/**
 * Resolves a numeric status effect id to its buff/debuff icon.
 *
 * Two hops rather than one because the game's own data is two hops: several
 * statuses share one piece of art (`status.tbl` maps each `StatusId` to an
 * `IconFileNameId` like `wkn_004`), so the icons are stored once under their
 * atlas name and `status-map.json` — generated from `status.tbl` by
 * `scripts/gen-game-icons.mjs` — carries the id → name edge. See
 * `src/assets/game-icons/README.md`.
 *
 * `import.meta.glob` rather than hand-written imports, for the same reason as
 * `characterIcon.ts`: the set changes on game patches, and a hand-edited list
 * is a list that will silently miss one.
 */
const ICONS = import.meta.glob<string>("./assets/game-icons/status/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

const BY_NAME = iconsByName(ICONS);

/** The icon URL for a status effect id, or `undefined` when there is no art for it. */
export const statusIconUrl = (statusId: number): string | undefined => {
  const name = (statusMap as Record<string, string>)[statusId];
  return name === undefined ? undefined : BY_NAME.get(name);
};
