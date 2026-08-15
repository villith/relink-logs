import { PANE_FIELDS, SHARED_FIELDS, clearablePaneParamNames, paneParamName } from "./paneParams";
import { decodeState, encodeState, type AnalysisState, type RawState } from "./state";

/** One URL param, as the frame's bulk reader hands it over: absent is null. */
export type ParamReader = (key: string) => string | null;

/** A batch of URL writes, keyed by param name. Null removes the param. */
export type ParamWrites = Record<string, string | null>;

/** One pane's whole raw state, gathered from the shared keys and that pane's
 * own suffixed ones. */
const rawStateFor = (index: number, read: ParamReader): RawState =>
  ({
    ...Object.fromEntries(SHARED_FIELDS.map((field) => [field, read(field)])),
    ...Object.fromEntries(PANE_FIELDS.map((field) => [field, read(paneParamName(field, index))])),
  }) as RawState;

/** Every URL write a SHARED control makes — the metric tabs and the side
 * toggle, which live in the frame because there is one of each for the view.
 *
 * Applied to EVERY pane, not just pane 0, because both shared transitions also
 * clear pane fields: a side swap invalidates every pane's actor pins (they name
 * the universe just left), and a metric change drops every pane's grouping
 * override. Rewriting only pane 0 would leave the others pinned to actors that
 * no longer exist on the side they are now showing.
 *
 * The shared half is taken from pane 0's result and written once, unsuffixed.
 * Every pane sees the same shared inputs and the same transition, so their
 * shared halves are identical by construction — writing one is not a choice
 * between disagreeing answers. */
export const sharedControlWrites = (
  paneCount: number,
  read: ParamReader,
  transition: (state: AnalysisState) => AnalysisState
): ParamWrites => {
  const writes: ParamWrites = {};

  for (let index = 0; index < paneCount; index += 1) {
    const next = encodeState(transition(decodeState(rawStateFor(index, read))));
    if (index === 0) SHARED_FIELDS.forEach((field) => (writes[field] = next[field]));
    PANE_FIELDS.forEach((field) => (writes[paneParamName(field, index)] = next[field]));
  }

  return writes;
};

/** Every URL write that closing pane `removedIndex` makes.
 *
 * The suffixed keys are POSITIONAL, so a removal is a shift and not a delete:
 * every pane above the removed one moves down onto the keys below it, and the
 * index left vacant at the top is then cleared. Both halves are needed — the
 * shift alone would leave the top pane's state duplicated, and the clear alone
 * would throw away the panes that outlived the removal.
 *
 * The vacated index is `paneCount - 1`, counted BEFORE the removal. Computing it
 * afterwards is the natural slip and yields 0 exactly when the last comparison
 * closes, which is why the clear goes through `clearablePaneParamNames`.
 *
 * Nothing at all is written for an index that names no removable pane, so a
 * caller cannot wipe a live pane's keys with a no-op removal. */
export const paneRemovalWrites = (paneCount: number, removedIndex: number, read: ParamReader): ParamWrites => {
  if (removedIndex <= 0 || removedIndex >= paneCount) return {};

  const writes: ParamWrites = {};
  for (let target = removedIndex; target < paneCount - 1; target += 1) {
    PANE_FIELDS.forEach((field) => {
      writes[paneParamName(field, target)] = read(paneParamName(field, target + 1));
    });
  }
  clearablePaneParamNames(paneCount - 1).forEach((key) => (writes[key] = null));

  return writes;
};
