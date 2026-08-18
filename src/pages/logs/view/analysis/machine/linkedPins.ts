import type { SelectorPins } from "../../selectorOptions";

import type { AnalysisState, Dimension } from "./state";
import { clearPin, pinRow } from "./transitions";

/** The pin dimensions a SINGLE-CHART comparison shares across its panes.
 *
 * Source is deliberately not one: each pane picks a source from its own log, in
 * the selector under that log's own picker, and one player read against another
 * is a comparison the overlay exists to draw. A target and an ability name the
 * same thing in either fight, and two lines on one axis answering two different
 * questions is not a comparison at all — it is two charts sharing an axis. */
export const LINKED_DIMS: ReadonlySet<Dimension> = new Set<Dimension>(["target", "ability"]);

/** One dimension's next value: an actor index, an ability key, or null to
 * clear it. The pin transitions come in two shapes (`pinRow` takes a value,
 * `clearPin` takes none), and every caller here holds "the new value, possibly
 * absent" — this is that, named once. */
export type PinChange = { dim: "source" | "target"; value: number | null } | { dim: "ability"; value: string | null };

export const applyPinChange = (state: AnalysisState, change: PinChange): AnalysisState => {
  if (change.dim === "ability") {
    return change.value === null ? clearPin(state, "ability") : pinRow(state, { dim: "ability", value: change.value });
  }
  return change.value === null ? clearPin(state, change.dim) : pinRow(state, { dim: change.dim, value: change.value });
};

/** What a selector bar's report actually CHANGES, in dimension order.
 *
 * The bars hand back the whole `SelectorPins` shape with one field edited, so
 * the diff is what says which dimension moved — and it has to be a diff rather
 * than "whatever the bar sent", or re-selecting the value already pinned would
 * run a transition that drops the auras anchored to it. */
export const pinChangesOf = (state: AnalysisState, next: SelectorPins): PinChange[] => {
  const target = next.targets.length > 0 ? next.targets[0] : null;
  const changes: PinChange[] = [];
  if (next.source !== state.source) changes.push({ dim: "source", value: next.source });
  if (target !== state.target) changes.push({ dim: "target", value: target });
  if (next.ability !== state.ability) changes.push({ dim: "ability", value: next.ability });
  return changes;
};

/** Which of those changes stay with this pane's log and which travel to every
 * pane. Split rather than routed one at a time: several dimensions changing in
 * one report must still be ONE write per destination, or the second would be
 * computed from a URL the first has not landed in yet. */
export const splitPinChanges = (changes: PinChange[], linked: boolean): { own: PinChange[]; shared: PinChange[] } =>
  linked
    ? {
        own: changes.filter((change) => !LINKED_DIMS.has(change.dim)),
        shared: changes.filter((change) => LINKED_DIMS.has(change.dim)),
      }
    : { own: changes, shared: [] };
