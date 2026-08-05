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
};

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
  },

  taken: {
    dataPath: "groups",
    supportsHostility: true,
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
  },

  stun: {
    dataPath: "derived",
    supportsHostility: false,
    dimensionOrder: ["source", "ability"],
    dimensions: {
      source: SUPPORTED("ui.logs.groupby-stun-source", "ui.logs.groupby-stun-source"),
      ability: SUPPORTED("ui.logs.groupby-stun-ability", "ui.logs.groupby-stun-ability"),
      target: UNSUPPORTED("ui.logs.stun-no-target-dimension"),
    },
    columnKeys: (dim) => stun.columnKeys(levelFor(dim)),
    cardKind: (dim) => (dim === "target" ? "none" : "skill"),
    chartFromGroups: false,
  },

  sba: {
    dataPath: "derived",
    supportsHostility: false,
    dimensionOrder: ["source"],
    dimensions: {
      source: SUPPORTED("ui.logs.groupby-sba-source", "ui.logs.groupby-sba-source"),
      ability: UNSUPPORTED("ui.logs.sba-no-breakdown"),
      target: UNSUPPORTED("ui.logs.sba-no-breakdown"),
    },
    columnKeys: (dim) => sba.columnKeys(levelFor(dim)),
    // A gauge reading has nothing to decompose.
    cardKind: () => "none",
    chartFromGroups: false,
  },

  buffs: {
    dataPath: "intervals",
    supportsHostility: true,
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
  },

  debuffs: {
    dataPath: "intervals",
    supportsHostility: true,
    dimensionOrder: ["ability", "source"],
    dimensions: {
      source: SUPPORTED("ui.logs.groupby-status-holder", "ui.logs.groupby-status-holder-enemy"),
      ability: SUPPORTED("ui.logs.groupby-status-effect", "ui.logs.groupby-status-effect"),
      target: UNSUPPORTED("ui.logs.status-no-target-dimension"),
    },
    columnKeys: (dim) => debuffs.columnKeys(levelFor(dim)),
    cardKind: () => "none",
    chartFromGroups: false,
  },
};
