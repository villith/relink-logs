import type { Hostility } from "../../metrics/types";
import { isStatusPin } from "../../statusUptime";
import type { MetricCapabilities } from "./capabilities";
import { resolveGroupBy } from "./resolve";
import type { AnalysisState, Dimension, MetricKey } from "./state";

export type PinValue = { dim: "source" | "target"; value: number } | { dim: "ability"; value: string };

/** Row click: pin the row's dimension. Drops the `by` override so the derived
 * default advances to the next free dimension — WCL's exact behavior. */
export const pinRow = (state: AnalysisState, pin: PinValue): AnalysisState => ({
  ...state,
  [pin.dim]: pin.value,
  by: null,
});

export const clearPin = (state: AnalysisState, dim: Dimension): AnalysisState => ({
  ...state,
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
