import { buffs } from "../../metrics/buffs";
import { damageDone } from "../../metrics/damageDone";
import { damageTaken } from "../../metrics/damageTaken";
import { debuffs } from "../../metrics/debuffs";
import { sba } from "../../metrics/sba";
import { stun } from "../../metrics/stun";
import type { Hostility, RowLevel } from "../../metrics/types";
import type { Dimension, MetricKey } from "./state";

export type DataPath = "groups" | "derived" | "intervals";

/** Which hover-card builder explains a row under a given grouping — the
 * existing builders, chosen by declaration instead of the view's metric/side
 * ternaries. `"none"` is a real answer (a gauge reading or an interval row
 * has nothing a skill walk can decompose, and the enemy side has builders
 * for its source grouping's rows only), declared rather than discovered as a
 * null at runtime. */
export type CardKind = "skill" | "taken" | "enemyDealt" | "enemyReceived" | "none";

/** Which bucketed series a metric plots when nothing overlays it, and how that
 * series is read.
 *
 * `series` NAMES the store field rather than carrying values, so the
 * declaration stays a constant: the view resolves it against the encounter
 * store, which is where the buckets live.
 *
 * `smoothing` is "rate" or "none" rather than a number, because the number is
 * the user's chosen window (DpsChart's control) and only a RATE may use it — a
 * level averaged over a trailing window reads as something it never was. */
export type ChartDecl = {
  labelKey: string;
  series: "dps" | "stun" | "taken" | "sba";
  smoothing: "rate" | "none";
  /** Multiplier onto the stored values. SBA is stored in tenths of a percent. */
  scale: number;
  format: "amount" | "percent";
};

export type DimensionDecl = {
  supported: boolean;
  /** i18next key stating WHY, where supported is false. */
  disabledReasonKey?: string;
  /** Regroup-tab label per hostility ("Done By Player" / "Done By Enemy"). */
  groupLabelKey: Record<Hostility, string>;
};

export type MetricCapabilities = {
  /** Which machinery produces rows: the GroupQuery aggregation, the derived
   * meter state (stun/SBA — their reconciled capture paths cannot be re-derived
   * from a raw event walk), or the status intervals (aura tabs). */
  dataPath: DataPath;
  supportsHostility: boolean;
  /** Whether the aura chip strips (and the windows mask on the group query)
   * operate on this tab. True only for the groups path: the mask is an event
   * filter, and only damage/taken answer from an event walk. */
  supportsAuraFilter: boolean;
  /** Default-grouping priority. The derivation rule picks the first unpinned
   * supported entry; all pinned → the last entry (one-row table). */
  dimensionOrder: Dimension[];
  dimensions: Record<Dimension, DimensionDecl>;
  /** Header keys for the numeric columns when grouped by `dim`. */
  columnKeys: (dim: Dimension) => string[];
  /** Which hover card explains a row under this grouping and side. */
  cardKind: (dim: Dimension, hostility: Hostility) => CardKind;
  /** Whether the chart stacks the fetched groups' series. False = the metric's
   * base chart keeps drawing (stun/SBA gauges, aura stacks/bands). */
  chartFromGroups: boolean;
  /** The metric's OWN plot — what is drawn when nothing overlays it. Declared
   * rather than branched on `metricKey` in the view, which is what made adding
   * a metric with its own series a view edit rather than a declaration. */
  chart: ChartDecl;
  /** Whether this metric records supplementary (echo) damage.
   *
   * Only Damage Done does, so the collapse toggle is inert everywhere else —
   * including on a shared link that arrives with it already switched on. The
   * toggle is disabled rather than hidden for the same reason the side switch
   * is: a control that came and went with the tab would shift everything under
   * it. */
  recordsSupplementary: boolean;
};

/** The three rate metrics share one shape: their own series, smoothed like DPS
 * because all three are per-second rates off the same buckets. Spelled once
 * rather than three times, so a change to the shared reading is one edit. */
const RATE_CHART = (labelKey: string, series: ChartDecl["series"]): ChartDecl => ({
  labelKey,
  series,
  smoothing: "rate",
  scale: 1,
  format: "amount",
});

// `groupLabelKey` here is a placeholder (empty strings, no ui.json entry) —
// consumers MUST check `supported` before reading it.
const UNSUPPORTED = (reasonKey: string): DimensionDecl => ({
  supported: false,
  disabledReasonKey: reasonKey,
  groupLabelKey: { friendly: "", enemy: "" },
});

const SUPPORTED = (friendly: string, enemy: string): DimensionDecl => ({
  supported: true,
  groupLabelKey: { friendly, enemy },
});

/** The legacy `RowLevel` a dimension corresponds to, for descriptors whose
 * `columnKeys` still speak the old players/abilities/skills vocabulary — see
 * the analysis-machine plan's mapping (source→players, ability→abilities,
 * target→skills). Column headers do not change in this phase. Exported for
 * the view, whose legacy row/card builders still take a level. */
export const levelFor = (dim: Dimension): RowLevel =>
  dim === "source" ? "players" : dim === "ability" ? "abilities" : "skills";

export const CAPABILITIES: Record<MetricKey, MetricCapabilities> = {
  damage: {
    dataPath: "groups",
    supportsHostility: true,
    supportsAuraFilter: true,
    dimensionOrder: ["source", "ability", "target"],
    dimensions: {
      source: SUPPORTED("ui.logs.groupby-damage-source", "ui.logs.groupby-damage-source-enemy"),
      ability: SUPPORTED("ui.logs.groupby-damage-ability", "ui.logs.groupby-damage-ability"),
      target: SUPPORTED("ui.logs.groupby-damage-target", "ui.logs.groupby-damage-target-enemy"),
    },
    columnKeys: (dim) => damageDone.columnKeys(levelFor(dim)),
    // Friendly rows decompose at every grouping — a target row still leaves
    // ability and source free (see targetCardSectionsFor). The enemy side
    // has a builder only for its attacker rows.
    cardKind: (dim, hostility) => (hostility === "enemy" ? (dim === "source" ? "enemyDealt" : "none") : "skill"),
    chartFromGroups: true,
    // The same trailing moving average the classic view smooths with, so the
    // same fight draws the same line in both.
    chart: RATE_CHART("ui.logs.chart-dps-label", "dps"),
    recordsSupplementary: true,
  },

  taken: {
    dataPath: "groups",
    supportsHostility: true,
    supportsAuraFilter: true,
    dimensionOrder: ["source", "ability", "target"],
    dimensions: {
      source: SUPPORTED("ui.logs.groupby-taken-source", "ui.logs.groupby-taken-source-enemy"),
      ability: SUPPORTED("ui.logs.groupby-taken-ability", "ui.logs.groupby-taken-ability"),
      target: SUPPORTED("ui.logs.groupby-taken-target", "ui.logs.groupby-taken-target-enemy"),
    },
    columnKeys: (dim) => damageTaken.columnKeys(levelFor(dim)),
    // A victim row decomposes (attacks and attackers), and a drilled attack
    // row decomposes across its victims. The target grouping's rows are
    // attacker TYPES with no per-spawn data behind them, and the enemy side
    // has a builder only for its victim rows.
    cardKind: (dim, hostility) =>
      hostility === "enemy" ? (dim === "source" ? "enemyReceived" : "none") : dim === "target" ? "none" : "taken",
    chartFromGroups: true,
    // Incoming damage per second, off the same buckets as DPS.
    chart: RATE_CHART("ui.logs.chart-taken-label", "taken"),
    recordsSupplementary: false,
  },

  stun: {
    dataPath: "derived",
    supportsHostility: false,
    supportsAuraFilter: false,
    dimensionOrder: ["source", "ability"],
    dimensions: {
      source: SUPPORTED("ui.logs.groupby-stun-source", "ui.logs.groupby-stun-source"),
      ability: SUPPORTED("ui.logs.groupby-stun-ability", "ui.logs.groupby-stun-ability"),
      target: UNSUPPORTED("ui.logs.stun-no-target-dimension"),
    },
    columnKeys: (dim) => stun.columnKeys(levelFor(dim)),
    cardKind: (dim) => (dim === "target" ? "none" : "skill"),
    chartFromGroups: false,
    chart: RATE_CHART("ui.logs.chart-stun-label", "stun"),
    recordsSupplementary: false,
  },

  sba: {
    dataPath: "derived",
    supportsHostility: false,
    supportsAuraFilter: false,
    dimensionOrder: ["source", "ability"],
    dimensions: {
      source: SUPPORTED("ui.logs.groupby-sba-source", "ui.logs.groupby-sba-source"),
      // The per-ability split the descriptor already builds (see metrics/sba.ts):
      // pinning a player descends into what generated THEIR gauge — attributed
      // skill rows plus the named non-hit causes. Local player only in practice;
      // a remote member's empty split shows the honest empty-state
      // (`ui.logs.sba-no-breakdown`, applied by emptyKeyFor in resolve.ts).
      ability: SUPPORTED("ui.logs.groupby-sba-ability", "ui.logs.groupby-sba-ability"),
      target: UNSUPPORTED("ui.logs.sba-no-target-dimension"),
    },
    columnKeys: (dim) => sba.columnKeys(levelFor(dim)),
    // A gauge reading has nothing a skill walk can decompose — the ability
    // rows are already the finest grain the capture has.
    cardKind: () => "none",
    chartFromGroups: false,
    // A gauge LEVEL, not a rate: smoothing would round off the discharge that
    // IS the reading. Stored in tenths of a percent.
    chart: { labelKey: "ui.logs.chart-sba-label", series: "sba", smoothing: "none", scale: 0.1, format: "percent" },
    recordsSupplementary: false,
  },

  buffs: {
    dataPath: "intervals",
    supportsHostility: true,
    supportsAuraFilter: false,
    dimensionOrder: ["ability", "source"],
    dimensions: {
      source: SUPPORTED("ui.logs.groupby-status-holder", "ui.logs.groupby-status-holder-enemy"),
      ability: SUPPORTED("ui.logs.groupby-status-effect", "ui.logs.groupby-status-effect"),
      target: UNSUPPORTED("ui.logs.status-no-target-dimension"),
    },
    columnKeys: (dim) => buffs.columnKeys(levelFor(dim)),
    // Effect and holder rows are windows, not sums over skills.
    cardKind: () => "none",
    chartFromGroups: false,
    // Actually drawn, and the tab's resting plot: the party's damage, as the
    // context the effects are read against — Warcraft Logs keeps its own
    // damage chart above the Buffs timeline for the same reason. Only a
    // PINNED effect overlays it, with that effect's per-holder stack depths.
    chart: RATE_CHART("ui.logs.chart-dps-label", "dps"),
    recordsSupplementary: false,
  },

  debuffs: {
    dataPath: "intervals",
    supportsHostility: true,
    supportsAuraFilter: false,
    dimensionOrder: ["ability", "source"],
    dimensions: {
      source: SUPPORTED("ui.logs.groupby-status-holder", "ui.logs.groupby-status-holder-enemy"),
      ability: SUPPORTED("ui.logs.groupby-status-effect", "ui.logs.groupby-status-effect"),
      target: UNSUPPORTED("ui.logs.status-no-target-dimension"),
    },
    columnKeys: (dim) => debuffs.columnKeys(levelFor(dim)),
    cardKind: () => "none",
    chartFromGroups: false,
    // As buffs: the damage plot at rest, overlaid by stack depths once an
    // effect is pinned.
    chart: RATE_CHART("ui.logs.chart-dps-label", "dps"),
    recordsSupplementary: false,
  },
};
