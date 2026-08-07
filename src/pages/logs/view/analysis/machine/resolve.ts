import type { Hostility } from "../../metrics/types";
import { isStatusPin } from "../../statusUptime";
import type { MetricCapabilities } from "./capabilities";
import { DIMENSIONS, auraAnchorOf, isPinned, type AnalysisState, type Dimension } from "./state";

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
  /** The raw aura filter (`src:status:…`/`tgt:status:…`), or null. Like
   * `ability`, the view expands it at fetch time — into the effect's active
   * windows, which need the fight's status intervals — the resolver only
   * decides whether it belongs in the query at all: declared support AND its
   * anchoring pin present (a hand-edited URL can carry one without). */
  aura: string | null;
  topN: number;
};

export type RegroupTab = { dim: Dimension; labelKey: string; active: boolean; disabledReason?: string };

/** Fallback label for a disabled tab: `groupLabelKey` is a placeholder
 * ("", per-hostility) on an unsupported dimension (see UNSUPPORTED in
 * capabilities.ts), so a disabled tab still needs SOME visible name — a bare
 * "Source"/"Ability"/"Target", the one thing true regardless of hostility. */
const GENERIC_LABEL_KEY: Record<Dimension, string> = {
  source: "ui.logs.groupby-generic-source",
  ability: "ui.logs.groupby-generic-ability",
  target: "ui.logs.groupby-generic-target",
};

export type ViewSpec = {
  groupBy: Dimension;
  regroupTabs: RegroupTab[];
  table: { columnKeys: string[]; rowsLabelKey: string; emptyKey?: string };
  /** Which machinery feeds the plot — the dev readout's only field.
   *
   * The chart's TITLE and FORMAT are deliberately NOT here. Both are
   * `chartPresentation`'s, decided from the series that actually won rather
   * than from the state that requested them, which is the only way the heading
   * can be kept from disagreeing with what is on screen. A second answer here
   * was computed and snapshotted for a while but never rendered, and it had
   * drifted: it knew nothing of the drilled-SBA title. */
  chart: { source: "groups" | "base" | "stacks" };
  selectors: { dim: Dimension; enabled: boolean }[];
  fetch: GroupQuery | null;
};

/** Chart band cap — matches the analysis chart's own eight-entry band palette
 * (4 user colors + PLAYER_COLORS, built in AnalysisView.tsx). */
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
  // Effective hostility: `side=enemy` is reachable in the URL on any metric,
  // including one whose capabilities don't support it, so every field below
  // must resolve against this, never against state.hostility directly.
  const hostility = caps.supportsHostility ? state.hostility : "friendly";

  const regroupTabs: RegroupTab[] = DIMENSIONS.map((dim) => {
    const decl = caps.dimensions[dim];
    return {
      dim,
      labelKey: decl.supported ? decl.groupLabelKey[hostility] : GENERIC_LABEL_KEY[dim],
      active: dim === groupBy,
      ...(decl.supported ? {} : { disabledReason: decl.disabledReasonKey }),
    };
  });

  const fetch: GroupQuery | null =
    caps.dataPath !== "groups"
      ? null
      : {
          // Sound while dataPath "groups" is declared only by damage and
          // taken (see CAPABILITIES) — both share this metric union.
          metric: state.metric as "damage" | "taken",
          hostility,
          groupBy,
          source: actorRef("source", state.source, hostility),
          target: actorRef("target", state.target, hostility),
          // A status pin names an effect; no event query can narrow by it.
          ability: state.ability !== null && !isStatusPin(state.ability) ? state.ability : null,
          aura: auraInQuery(state, caps),
          topN: GROUP_TOP_N,
        };

  const emptyKey = emptyKeyFor(state, caps);

  return {
    groupBy,
    regroupTabs,
    table: {
      columnKeys: caps.columnKeys(groupBy),
      rowsLabelKey: rowsLabelKeyFor(groupBy, hostility, caps),
      ...(emptyKey === undefined ? {} : { emptyKey }),
    },
    chart: {
      source:
        caps.dataPath === "groups" && caps.chartFromGroups
          ? "groups"
          : caps.dataPath === "intervals"
            ? "stacks"
            : "base",
    },
    selectors: DIMENSIONS.map((dim) => ({ dim, enabled: caps.dimensions[dim].supported })),
    fetch,
  };
};

/** Whether the state's aura filter belongs in the group query: the tab
 * declares support and the pin the aura is anchored to is actually present.
 * Anything else (hand-edited URL, anchor cleared by an older app) is null —
 * the mask must never outlive the chips that explain it. */
const auraInQuery = (state: AnalysisState, caps: MetricCapabilities): string | null => {
  if (state.aura === null || !caps.supportsAuraFilter) return null;
  const anchor = auraAnchorOf(state.aura);
  if (anchor === "source") return state.source !== null ? state.aura : null;
  if (anchor === "target") return state.target !== null ? state.aura : null;
  return null;
};

/** i18next key naming what a row IS under this grouping. Reuses the existing
 * rows-by-* keys. `hostility` must already be the effective hostility (see
 * resolveViewSpec). The interval metrics' ability rows are EFFECTS, not
 * ability casts, and their header has always said so. */
const rowsLabelKeyFor = (groupBy: Dimension, hostility: Hostility, caps: MetricCapabilities): string => {
  const enemySide = hostility === "enemy";
  if (groupBy === "source") return enemySide ? "ui.logs.rows-by-enemy" : "ui.logs.rows-by-player";
  if (groupBy === "target") return enemySide ? "ui.logs.rows-by-player" : "ui.logs.rows-by-enemy";
  return caps.dataPath === "intervals" ? "ui.logs.rows-by-effect" : "ui.logs.rows-by-ability";
};

/** What an EMPTY table should say, where the honest reason is not "clear a
 * pin": the aura tabs are empty on any log recorded before status capture
 * (the view applies this only when the fight recorded no intervals at all);
 * a remote player's SBA breakdown is genuinely unattributable; and Damage
 * Done's enemy side reads the damage-taken stream, which logs recorded
 * before that capture simply lack. */
const emptyKeyFor = (state: AnalysisState, caps: MetricCapabilities): string | undefined => {
  if (caps.dataPath === "intervals") return "ui.logs.buffs-empty";
  if (state.metric === "sba" && state.source !== null) return "ui.logs.sba-no-breakdown";
  if (state.metric === "damage" && caps.supportsHostility && state.hostility === "enemy") {
    return "ui.logs.enemy-dealt-empty";
  }
  return undefined;
};
