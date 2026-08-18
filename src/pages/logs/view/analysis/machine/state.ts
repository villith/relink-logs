import type { ChartWindow } from "@/types";

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
  /** The active Auras Filter: each entry is `src:`/`tgt:` (which actor pin
   * anchors it) plus the status pin key of the chosen effect. A FILTER, not a
   * grouping dimension — `resolveGroupBy` never reads it (like `window`).
   * Entries anchored to a pin are dropped when that pin clears or changes (see
   * transitions.ts); entries anchored to the OTHER pin survive.
   *
   * Several at once compose by INTERSECTION: the view shows time when every
   * selected effect was up together. Union would answer a different question
   * ("either buff was running"), and the one the strip is for — "what did we do
   * under the full stack" — has no other spelling. Empty = no aura filter. */
  aura: string[];
  /** The active window filter: each entry is a battle-window kind (`sba`) or
   * one individual window of a kind (`sba:1`, 0-based within that kind's
   * windows sorted by start — the order `assemble_chart_windows` returns).
   *
   * Several at once compose by UNION, which is the opposite of `aura` and not
   * an inconsistency: two battle windows never overlap in time, so intersecting
   * them would resolve to nothing every time. A FILTER like `aura` —
   * `resolveGroupBy` never reads it — but with no anchoring pin, so no
   * transition clears it besides its own. Empty = no window filter. */
  win: string[];
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
  aura: [],
  win: [],
};

export const isPinned = (state: AnalysisState, dim: Dimension): boolean =>
  dim === "source" ? state.source !== null : dim === "ability" ? state.ability !== null : state.target !== null;

/** The raw query-string fields every pane shares.
 *
 * Every one of them means the same thing in any log: a metric, a side, and a
 * zoom expressed in elapsed-time buckets. That is the test for belonging here —
 * a field whose value is an index into one log's OWN data is pane-scoped, or
 * one pane's selection resolves to a different thing in the other. */
export type SharedRaw = {
  metric: string | null;
  side: string | null;
  from: string | null;
  to: string | null;
};

/** The raw query-string fields scoped to ONE pane. */
export type PaneRaw = {
  src: string | null;
  tgt: string | null;
  abil: string | null;
  by: string | null;
  aura: string | null;
  /** Per-pane because a `win` entry can name ONE window by ordinal
   * (`sba:1` = that log's second SBA window, in start order), which is an index
   * into this log's own `chartWindows`. Shared, pane B resolves pane A's chip
   * against its own windows — a different span of a different fight — and a
   * chip with no counterpart there resolves to NO windows, which
   * `useFilterWindows` hands on as an EMPTY mask rather than as no filter, so
   * pane B's chart, table and every uptime denominator go blank with its own
   * strip showing the chip as selected and nothing on screen saying why. */
  win: string | null;
};

/** One pane's whole raw state. Unchanged in shape — `decodeState` and
 * `encodeState` still take and return exactly this. */
export type RawState = SharedRaw & PaneRaw;

export const encodeState = (state: AnalysisState): RawState => ({
  metric: state.metric === DEFAULT_STATE.metric ? null : state.metric,
  side: state.hostility === "friendly" ? null : state.hostility,
  src: state.source === null ? null : String(state.source),
  tgt: state.target === null ? null : String(state.target),
  abil: state.ability,
  from: state.window === null ? null : String(state.window[0]),
  to: state.window === null ? null : String(state.window[1]),
  by: state.by,
  aura: encodeList(state.aura),
  win: encodeList(state.win),
});

/** A filter list as ONE query param. Empty encodes as null (the param drops out
 * of the URL) rather than as an empty string, so a cleared filter leaves the
 * same address a never-set one does. Comma-separated because neither grammar
 * admits a comma — `AURA_KEY` and `WIN_KEY` below are the proof. */
export const encodeList = (values: string[]): string | null => (values.length === 0 ? null : values.join(","));

/** The inverse, gating each entry through its own grammar and dropping
 * duplicates.
 *
 * Per ENTRY, not per list: one bad segment in a hand-edited URL discards itself
 * and leaves the rest standing — the same "every field degrades on its own"
 * rule `decodeState` applies across fields, one level down. A list that
 * degrades wholesale would let a single stale index silently drop a filter the
 * user can see three other chips for. */
const decodeList = (raw: string | null, grammar: RegExp): string[] =>
  raw === null ? [] : [...new Set(raw.split(",").filter((value) => grammar.test(value)))];

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

/** How a window filter is spelled: the kind, optionally `:index` for one
 * individual window. The gate every `win` value passes on the way out of the
 * URL — a value it rejects makes the filter inert, exactly like `AURA_KEY`. */
const WIN_KEY = /^(sba|link|overdrive|break)(:\d+)?$/;

/** The kind and 0-based per-kind index a `win` value names; null index = the
 * whole kind. Only call on a value `WIN_KEY` admits. */
export const winFilterParts = (win: string): { kind: ChartWindow["kind"]; index: number | null } => {
  const [kind, index] = win.split(":");
  return { kind: kind as ChartWindow["kind"], index: index === undefined ? null : Number(index) };
};

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
    aura: decodeList(raw.aura, AURA_KEY),
    win: decodeList(raw.win, WIN_KEY),
  };
};
