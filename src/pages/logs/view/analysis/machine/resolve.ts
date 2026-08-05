import type { Hostility } from "../../metrics/types";
import { isStatusPin } from "../../statusUptime";
import type { MetricCapabilities } from "./capabilities";
import { DIMENSIONS, isPinned, type AnalysisState, type Dimension } from "./state";

/** A universe-typed actor reference — which side's population an index names.
 * Mirrors the Rust `ActorRef` in parser/v1/groups.rs; the two must agree. */
export type ActorRef = { kind: "player"; index: number } | { kind: "enemySpawn"; segment: number };

/** The generic aggregation request. Mirrors Rust `GroupQuery` (camelCase serde). */
export type GroupQuery = {
  metric: "damage" | "taken";
  hostility: Hostility;
  groupBy: Dimension;
  source: ActorRef | null;
  target: ActorRef | null;
  /** The raw ability pin. The view expands a friendly pin into action ids with
   * `actionsForPin` at fetch time (it needs the fight's skill list); the
   * resolver only decides whether the pin belongs in the query at all. */
  ability: string | null;
  topN: number;
};

export type RegroupTab = { dim: Dimension; labelKey: string; active: boolean; disabledReason?: string };

export type ViewSpec = {
  groupBy: Dimension;
  regroupTabs: RegroupTab[];
  table: { columnKeys: string[]; rowsLabelKey: string; emptyKey?: string };
  chart: { source: "groups" | "base" | "stacks"; titleKey: string; format: "amount" | "percent" | "count" };
  selectors: { dim: Dimension; enabled: boolean }[];
  fetch: GroupQuery | null;
};

/** Chart band cap — same rationale as the enemy-series cap (palette size). */
export const GROUP_TOP_N = 8;

export const resolveGroupBy = (state: AnalysisState, caps: MetricCapabilities): Dimension => {
  if (state.by !== null && caps.dimensions[state.by].supported) return state.by;
  const supported = caps.dimensionOrder.filter((dim) => caps.dimensions[dim].supported);
  return supported.find((dim) => !isPinned(state, dim)) ?? supported[supported.length - 1];
};

/** Which universe each dimension's actors come from, under the hostility
 * role-mapping: on the friendly side sources are players and targets are enemy
 * spawns; the enemy side swaps them. One function so the query and the row
 * naming can never disagree about what an index means. */
export const universeOf = (dim: "source" | "target", hostility: Hostility): "player" | "enemySpawn" =>
  (dim === "source") === (hostility === "friendly") ? "player" : "enemySpawn";

const actorRef = (dim: "source" | "target", index: number | null, hostility: Hostility): ActorRef | null => {
  if (index === null) return null;
  return universeOf(dim, hostility) === "player" ? { kind: "player", index } : { kind: "enemySpawn", segment: index };
};

export const resolveViewSpec = (state: AnalysisState, caps: MetricCapabilities): ViewSpec => {
  const groupBy = resolveGroupBy(state, caps);

  const regroupTabs: RegroupTab[] = DIMENSIONS.map((dim) => {
    const decl = caps.dimensions[dim];
    return {
      dim,
      labelKey: decl.supported ? decl.groupLabelKey[caps.supportsHostility ? state.hostility : "friendly"] : "",
      active: dim === groupBy,
      ...(decl.supported ? {} : { disabledReason: decl.disabledReasonKey }),
    };
  });

  const fetch: GroupQuery | null =
    caps.dataPath !== "groups"
      ? null
      : {
          metric: state.metric as "damage" | "taken",
          hostility: caps.supportsHostility ? state.hostility : "friendly",
          groupBy,
          source: actorRef("source", state.source, state.hostility),
          target: actorRef("target", state.target, state.hostility),
          // A status pin names an effect; no event query can narrow by it.
          ability: state.ability !== null && !isStatusPin(state.ability) ? state.ability : null,
          topN: GROUP_TOP_N,
        };

  return {
    groupBy,
    regroupTabs,
    table: {
      columnKeys: caps.columnKeys(groupBy),
      rowsLabelKey: rowsLabelKeyFor(groupBy, state.hostility, caps),
      // emptyKey wiring lands with the view integration (Task 14) — the
      // resolver's field exists now so the shape is stable.
    },
    chart: {
      source:
        caps.dataPath === "groups" && caps.chartFromGroups
          ? "groups"
          : caps.dataPath === "intervals"
            ? "stacks"
            : "base",
      titleKey: chartTitleKeyFor(state, groupBy, caps),
      format: state.metric === "sba" ? "percent" : caps.dataPath === "intervals" ? "count" : "amount",
    },
    selectors: DIMENSIONS.map((dim) => ({ dim, enabled: caps.dimensions[dim].supported })),
    fetch,
  };
};

/** i18next key naming what a row IS under this grouping. Reuses the existing
 * rows-by-* keys (see KIND_ROWS_LABEL_KEY in AnalysisView.tsx). */
const rowsLabelKeyFor = (groupBy: Dimension, hostility: Hostility, caps: MetricCapabilities): string => {
  const enemySide = caps.supportsHostility && hostility === "enemy";
  if (groupBy === "source") return enemySide ? "ui.logs.rows-by-enemy" : "ui.logs.rows-by-player";
  if (groupBy === "target") return enemySide ? "ui.logs.rows-by-player" : "ui.logs.rows-by-enemy";
  return "ui.logs.rows-by-ability";
};

/** Existing chart-title keys, chosen by what is DRAWN. */
const chartTitleKeyFor = (state: AnalysisState, groupBy: Dimension, caps: MetricCapabilities): string => {
  if (caps.dataPath === "intervals") return "ui.logs.chart-stacks-label";
  if (state.metric === "stun") return "ui.logs.chart-stun-label";
  if (state.metric === "sba") return "ui.logs.chart-sba-label";
  if (state.metric === "taken")
    return groupBy === "source" ? "ui.logs.chart-taken-label" : "ui.logs.chart-taken-drill-label";
  if (groupBy === "ability") return "ui.logs.chart-drill-ability-label";
  if (groupBy === "target") return "ui.logs.chart-drill-target-label";
  return "ui.logs.chart-dps-label";
};
