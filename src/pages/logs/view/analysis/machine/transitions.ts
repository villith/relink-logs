import type { Hostility } from "../../metrics/types";
import { isStatusPin } from "../../statusUptime";
import type { MetricCapabilities } from "./capabilities";
import { resolveGroupBy } from "./resolve";
import { auraAnchorOf, type AnalysisState, type Dimension, type MetricKey } from "./state";

export type PinValue = { dim: "source" | "target"; value: number } | { dim: "ability"; value: string };

/** Drops the aura filter when the actor pin it is anchored to is about to
 * change or clear — the chips belong to that actor, and a window mask computed
 * for the old one would silently filter by the wrong holder. */
const withoutAuraOn = (state: AnalysisState, dim: Dimension): AnalysisState =>
  auraAnchorOf(state.aura) === dim ? { ...state, aura: null } : state;

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
  // The aura is anchored to an actor pin, and both just cleared.
  aura: null,
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

/** Selects (or clears) the Auras Filter. No `by` reset: a filter narrows the
 * data, it does not advance the drill the way a pin does. */
export const setAura = (state: AnalysisState, aura: string | null): AnalysisState => ({ ...state, aura });
