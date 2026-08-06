import type { Hostility } from "../../metrics/types";

export type MetricKey = "damage" | "taken" | "stun" | "sba" | "buffs" | "debuffs";
export type Dimension = "source" | "ability" | "target";

/** The analysis view's whole state — every axis, nothing else. URL-encoded via
 * the codec below, so a view is a shareable address and reload is a no-op.
 * The reference machine is Warcraft Logs'; see the spec. */
export type AnalysisState = {
  metric: MetricKey;
  hostility: Hostility;
  /** Actor index in the side's universe (player index on the friendly side). */
  source: number | null;
  /** ONE targetEntries segment, or null. Single like WCL's target axis. */
  target: number | null;
  /** Three grammars, one axis: abilityKey, takenAttack JSON, or status:… */
  ability: string | null;
  /** Committed scrub window as [start, end] bucket indexes. */
  window: [number, number] | null;
  /** Explicit grouping override — WCL's `by`. Null = derived default. */
  by: Dimension | null;
  /** The active Auras Filter: `src:`/`tgt:` (which actor pin anchors it) plus
   * the status pin key of the chosen effect, or null. A FILTER, not a grouping
   * dimension — `resolveGroupBy` never reads it (like `window`). Cleared
   * whenever the anchoring pin clears or changes (see transitions.ts). */
  aura: string | null;
};

export const METRIC_KEYS: MetricKey[] = ["damage", "taken", "stun", "sba", "buffs", "debuffs"];
export const DIMENSIONS: Dimension[] = ["source", "ability", "target"];

export const DEFAULT_STATE: AnalysisState = {
  metric: "damage",
  hostility: "friendly",
  source: null,
  target: null,
  ability: null,
  window: null,
  by: null,
  aura: null,
};

export const isPinned = (state: AnalysisState, dim: Dimension): boolean =>
  dim === "source" ? state.source !== null : dim === "ability" ? state.ability !== null : state.target !== null;

/** The raw query-string fields, one per URL param. */
export type RawState = {
  metric: string | null;
  side: string | null;
  src: string | null;
  tgt: string | null;
  abil: string | null;
  from: string | null;
  to: string | null;
  by: string | null;
  aura: string | null;
};

export const encodeState = (state: AnalysisState): RawState => ({
  metric: state.metric === DEFAULT_STATE.metric ? null : state.metric,
  side: state.hostility === "friendly" ? null : state.hostility,
  src: state.source === null ? null : String(state.source),
  tgt: state.target === null ? null : String(state.target),
  abil: state.ability,
  from: state.window === null ? null : String(state.window[0]),
  to: state.window === null ? null : String(state.window[1]),
  by: state.by,
  aura: state.aura,
});

const nonNegativeInt = (raw: string | null): number | null => {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
};

/** How an aura filter is spelled: which actor pin anchors it, then the status
 * pin key of the chosen effect. The anchor is in the value because with BOTH
 * actors pinned a bare status key cannot say whose windows to mask by — and
 * the clearing rule ("the aura dies with its pin") needs to know too.
 *
 * THREE segments after `status:`, because that is what `statusPinKey` spells:
 * effect, cause, applying class (`statusUptime.statusKey`). This regex is the
 * gate every aura value passes through on the way back out of the URL, so a
 * grammar it does not admit makes the whole filter inert — the class segment
 * was added to the key without being added here, and the chips silently
 * stopped selecting. Keep the two in step. */
const AURA_KEY = /^(src|tgt):status:\d+:(\d+|unknown):(\d+|unknown)$/;

/** The dimension an aura filter is anchored to, or null for no/invalid aura. */
export const auraAnchorOf = (aura: string | null): "source" | "target" | null =>
  aura === null || !AURA_KEY.test(aura) ? null : aura.startsWith("src:") ? "source" : "target";

/** The `status:…` pin key inside an aura value — both anchors are 4 chars.
 * Only call on a value `AURA_KEY` admits (the codec guarantees state.aura is). */
export const auraPinKey = (aura: string): string => aura.slice(4);

/** Every field degrades to its default on its own — one bad value must not
 * discard the others. There is deliberately NO legacy decoding: the old
 * multi-target `tgt` grammar and un-namespaced pins are dead (spec decision). */
export const decodeState = (raw: RawState): AnalysisState => {
  const from = nonNegativeInt(raw.from);
  const to = nonNegativeInt(raw.to);
  return {
    metric: METRIC_KEYS.includes(raw.metric as MetricKey) ? (raw.metric as MetricKey) : DEFAULT_STATE.metric,
    hostility: raw.side === "enemy" ? "enemy" : "friendly",
    source: nonNegativeInt(raw.src),
    target: nonNegativeInt(raw.tgt),
    ability: raw.abil === "" ? null : raw.abil,
    window: from !== null && to !== null && from <= to ? [from, to] : null,
    by: DIMENSIONS.includes(raw.by as Dimension) ? (raw.by as Dimension) : null,
    aura: raw.aura !== null && AURA_KEY.test(raw.aura) ? raw.aura : null,
  };
};
