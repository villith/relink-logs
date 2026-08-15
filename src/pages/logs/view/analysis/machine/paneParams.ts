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

/** The compared log ids, pane 1 upward. Per ENTRY degradation, the same rule
 * `decodeList` follows one level down: a hand-edited id that cannot name a log
 * discards itself and leaves the rest standing.
 *
 * A REPEATED id is KEPT. Panes are positional, not deduped by log id, and each
 * pins independently (`PANE_FIELDS` above) — one log compared against itself
 * down two different drill paths is a real comparison, not the same pane
 * twice. Collapsing `2661,2661` to one pane would also orphan the second
 * pane's `src2`/`aura2`/etc. in the URL with no removal having run to clear
 * them, which is exactly the dormant-key hazard `clearablePaneParamNames`
 * exists to avoid. */
export const decodeCompare = (raw: string | null): number[] =>
  raw === null
    ? []
    : raw
        .split(",")
        .map((value) => Number(value))
        .filter((value) => Number.isSafeInteger(value) && value > 0);

/** Empty encodes as null so the param drops out of the URL — a closed
 * comparison leaves the same address a never-opened one does. */
export const encodeCompare = (ids: number[]): string | null => (ids.length === 0 ? null : ids.join(","));

/** Drop pane `index` from the comparison. Pane 0 is the log in the path and is
 * the page itself, so it is not removable here — closing it means navigating. */
export const removeCompareAt = (ids: number[], index: number): number[] =>
  index <= 0 ? ids : ids.filter((_, position) => position !== index - 1);

/** Every URL key belonging to one pane, including pane 0's bare keys.
 *
 * Derived from `PANE_FIELDS` rather than spelled out, so a field added to
 * `PaneRaw` cannot be left behind here. Includes pane 0 on purpose — this is
 * also what a frame-level bulk read/write over every pane's keys uses to
 * build its key set, and pane 0 is a pane for that purpose. It is NOT what a
 * pane removal should clear; see `clearablePaneParamNames` for that. */
export const paneParamNames = (index: number): string[] => PANE_FIELDS.map((field) => paneParamName(field, index));

/** The keys a pane REMOVAL may clear — empty for pane 0.
 *
 * Pane 0 is the log in the path, and its keys are the BARE ones, so clearing
 * them wipes the pins of the log still on screen rather than tidying up after a
 * closed pane. The vacated index a removal clears is `idsBefore.length`, and
 * the natural slip is to compute it from `idsAfter.length` — which is 0 exactly
 * when the last comparison closes. Returning nothing there makes that slip a
 * no-op instead of silent data loss. nuqs keeps a param it no longer reads, so
 * a suffixed key left standing after a removal is dormant rather than gone,
 * and reopening a pane at that index would revive someone else's old filter —
 * which is the failure this function exists to prevent. */
export const clearablePaneParamNames = (index: number): string[] => (index <= 0 ? [] : paneParamNames(index));
