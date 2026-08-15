import type { PaneRaw, SharedRaw } from "./state";

/** The URL fields that belong to ONE pane: the three pins, the grouping
 * override and the aura filter. Each pane holds its own, because comparing two
 * logs is comparing two selections — see the spec's "independent pins". */
export const PANE_FIELDS = ["src", "tgt", "abil", "by", "aura"] as const satisfies readonly (keyof PaneRaw)[];

/** The URL fields every pane shares: which metric, which side, the committed
 * zoom, and the battle-window filter. One of each across the whole view. */
export const SHARED_FIELDS = ["metric", "side", "from", "to", "win"] as const satisfies readonly (keyof SharedRaw)[];

/** What a pane field is called in the URL. Pane 0 keeps the BARE key so every
 * link written before compare existed still opens what it opened; later panes
 * suffix their index. */
export const paneParamName = (field: keyof PaneRaw, index: number): string =>
  index === 0 ? field : `${field}${index}`;
