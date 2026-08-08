import type { Hostility } from "../../metrics/types";
import { isStatusPin } from "../../statusUptime";
import type { MetricCapabilities } from "./capabilities";
import { resolveGroupBy } from "./resolve";
import { auraAnchorOf, type AnalysisState, type Dimension, type MetricKey } from "./state";

export type PinValue = { dim: "source" | "target"; value: number } | { dim: "ability"; value: string };

/** Drops the auras anchored to an actor pin that is about to change or clear —
 * those chips belong to that actor, and a window mask computed for the old one
 * would silently filter by the wrong holder.
 *
 * Only the anchored ones: the source and target strips select into one list and
 * apply together, so re-pinning a target must leave the source strip's picks
 * alone. Returns the state unchanged when nothing is dropped, so a pin change
 * that touches no aura does not hand every consumer a fresh identity. */
const withoutAuraOn = (state: AnalysisState, dim: Dimension): AnalysisState => {
  const kept = state.aura.filter((aura) => auraAnchorOf(aura) !== dim);
  return kept.length === state.aura.length ? state : { ...state, aura: kept };
};

/** Row click: pin the row's dimension. Drops the `by` override so the derived
 * default advances to the next free dimension — WCL's exact behavior. An aura
 * anchored to the dimension dies with a CHANGE of actor (its chips were the
 * old actor's); re-pinning the same value keeps it. */
export const pinRow = (state: AnalysisState, pin: PinValue): AnalysisState => {
  const current = pin.dim === "source" ? state.source : pin.dim === "target" ? state.target : state.ability;
  const base = current === pin.value ? state : withoutAuraOn(state, pin.dim);
  return { ...base, [pin.dim]: pin.value, by: null };
};

export const clearPin = (state: AnalysisState, dim: Dimension): AnalysisState => ({
  ...withoutAuraOn(state, dim),
  [dim]: null,
});

/** Whether an ability pin's grammar still names something on `metric`.
 * Status pins live on the aura tabs; action/attack pins live on the tab whose
 * events they came from — a Damage skill key means nothing on Taken. */
const abilityCrosses = (ability: string, from: MetricKey, to: MetricKey): boolean => {
  if (isStatusPin(ability)) return to === "buffs" || to === "debuffs";
  return from === to;
};

export const setMetric = (state: AnalysisState, metric: MetricKey): AnalysisState => {
  if (metric === state.metric) return state;
  return {
    ...state,
    metric,
    ability: state.ability !== null && abilityCrosses(state.ability, state.metric, metric) ? state.ability : null,
    by: null,
  };
};

/** The sides swap which universe source/target draw from, so actor pins from
 * the old side name nobody on the new one. Ability clears for the same reason
 * UNLESS it is a status pin, whose effect names the same thing on both sides. */
export const setHostility = (state: AnalysisState, hostility: Hostility): AnalysisState => ({
  ...state,
  hostility,
  source: null,
  target: null,
  ability: state.ability !== null && isStatusPin(state.ability) ? state.ability : null,
  // Every aura is anchored to an actor pin, and both just cleared.
  aura: [],
  by: null,
});

export const setWindow = (state: AnalysisState, window: [number, number] | null): AnalysisState => ({
  ...state,
  window,
});

/** Explicit regroup. Choosing what the rule already derives clears the
 * override, so the URL stays canonical and pinning resumes advancing. */
export const regroup = (state: AnalysisState, dim: Dimension, caps: MetricCapabilities): AnalysisState => {
  const derived = resolveGroupBy({ ...state, by: null }, caps);
  return { ...state, by: dim === derived ? null : dim };
};

/** Adds or removes ONE value from a filter list, preserving selection order.
 *
 * The strips are made of independent toggles, so this is the shape both filter
 * transitions want: a tile or a menu item reports itself, and the list decides
 * whether that was a select or a deselect. */
const toggleIn = (values: string[], value: string): string[] =>
  values.includes(value) ? values.filter((held) => held !== value) : [...values, value];

/** Toggles one effect in the Auras Filter. No `by` reset: a filter narrows the
 * data, it does not advance the drill the way a pin does.
 *
 * Source and target auras share ONE list and all apply together — selecting on
 * either strip no longer replaces the other's picks, because two strips whose
 * selections silently erase each other is the behaviour that made the filter
 * read as broken. */
export const toggleAura = (state: AnalysisState, aura: string): AnalysisState => ({
  ...state,
  aura: toggleIn(state.aura, aura),
});

/** Clears every aura at once — the strips' shared ✕. */
export const clearAuras = (state: AnalysisState): AnalysisState =>
  state.aura.length === 0 ? state : { ...state, aura: [] };

/** Toggles one battle window (or one whole kind) in the window filter. Like
 * the aura filter, a filter narrows rather than drills, so no `by` reset — and
 * unlike it, a battle window is a property of the fight, not of any pin, so
 * nothing else clears it. */
export const toggleWindowFilter = (state: AnalysisState, win: string): AnalysisState => ({
  ...state,
  win: toggleIn(state.win, win),
});

/** Toggles a whole KIND of battle window — the "All <kind> windows" row.
 *
 * Turning a kind on drops that kind's individual entries with it: the kind
 * already admits every one of them, and leaving them behind would make
 * unticking the kind row silently fall back to whichever windows happened to be
 * ticked before it, rather than to nothing. */
export const toggleWindowKind = (state: AnalysisState, kind: string): AnalysisState => ({
  ...state,
  win: state.win.includes(kind)
    ? state.win.filter((value) => value !== kind)
    : [...state.win.filter((value) => !value.startsWith(`${kind}:`)), kind],
});

/** Clears every window filter at once — the strip's ✕. */
export const clearWindowFilters = (state: AnalysisState): AnalysisState =>
  state.win.length === 0 ? state : { ...state, win: [] };
