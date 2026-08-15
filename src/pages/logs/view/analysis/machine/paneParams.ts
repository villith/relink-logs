import type { PaneRaw, SharedRaw } from "./state";

/** The URL fields that belong to ONE pane: the three pins, the grouping
 * override and the aura filter. Each pane holds its own, because comparing
 * two logs means comparing two independent selections — the same character
 * pinned in both panes is one useful comparison, but so is one player in
 * pane A against a different player in pane B. */
export const PANE_FIELDS = ["src", "tgt", "abil", "by", "aura"] as const satisfies readonly (keyof PaneRaw)[];

/** The URL fields every pane shares: which metric, which side, the committed
 * zoom, and the battle-window filter. One of each across the whole view. */
export const SHARED_FIELDS = ["metric", "side", "from", "to", "win"] as const satisfies readonly (keyof SharedRaw)[];

/** `[Key] extends [Listed[number]]` (tuple-wrapped so the check runs on the
 * whole union at once, not member-by-member) collapses to the field(s) still
 * missing when `Listed` falls short of `Key`, or to `true` when it covers
 * every one. The `satisfies` clauses above only stop a list from naming a
 * field that doesn't exist — they don't stop one from leaving a real field
 * out, which is the direction that actually bites: a field added to
 * `PaneRaw`/`SharedRaw` and forgotten here would just stop being read/written
 * for every pane, silently, in a view whose whole contract is "the URL IS the
 * state" — the same class of bug `state.ts` already paid for once, when a
 * segment was added to the status pin key without a matching change to
 * `AURA_KEY`. Assigning `true` below fails to compile, naming the field, the
 * moment `Listed` falls short. */
type Exhaustive<Key extends string, Listed extends readonly Key[]> = [Key] extends [Listed[number]]
  ? true
  : Exclude<Key, Listed[number]>;

// Exported so `noUnusedLocals`/`no-unused-vars` don't flag these as dead
// code — their only job is to fail `tsc` if a field ever goes missing.
export const _paneFieldsExhaustive: Exhaustive<keyof PaneRaw, typeof PANE_FIELDS> = true;
export const _sharedFieldsExhaustive: Exhaustive<keyof SharedRaw, typeof SHARED_FIELDS> = true;

/** What a pane field is called in the URL. Pane 0 keeps the BARE key so every
 * link written before compare existed still opens what it opened; later panes
 * suffix their index. */
export const paneParamName = (field: keyof PaneRaw, index: number): string =>
  index === 0 ? field : `${field}${index}`;
