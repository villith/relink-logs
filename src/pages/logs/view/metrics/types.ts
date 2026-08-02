import type { ComputedPlayerState, EncounterState, PlayerData, StatusInterval } from "@/types";

import type { RowLevel } from "../deriveRows";
import type { SelectorPins } from "../selectorOptions";

/** One row of the generic metric table, already reduced to what it renders. */
export type MetricRow = {
  /** Stable identity for React keys and row-click pinning. */
  key: string;
  /** Raw label, resolved to a display name by the table (see MetricTable):
   * a player index, or an `abilityKey()`. Descriptors stay free of i18n and
   * settings so they can be tested as pure functions. */
  label: string;
  /** Drives the bar width, as a percentage of the largest row. */
  value: number;
  /** Right-hand numeric columns, already formatted. */
  columns: string[];
  /** What clicking this row pins, or null if the row is a leaf. */
  pinOnClick: Partial<SelectorPins> | null;
  /** Party slot this row's colour comes from, or -1 when it has none (a hit, an
   * enemy). The table resolves the slot to a colour, so descriptors stay pure
   * functions with no reach into the settings store. */
  colorSlot: number;
};

/** What `label` should be resolved against before it is drawn.
 *
 * `"status"` is the buff/debuff row: a `status:<effect>:<cause>` key that reads
 * as "Attack Up (Signo Drive)" — the effect first so shared effects sort
 * together, the cause in parentheses because two abilities granting one effect
 * are two rows. */
export type LabelKind = "player" | "ability" | "status" | "raw";

/** Everything a metric needs to turn encounter state into rows. */
export type MetricDescriptor = {
  /** i18next key for the switcher label. */
  labelKey: string;
  /** i18next keys for the numeric column headers at a given level.
   *
   * A function of the level, not a fixed list: descending from players to
   * abilities swaps DPS for a hit count, and a header that keeps saying DPS
   * over a column of hit counts is worse than no header at all. */
  columnKeys: (level: RowLevel) => string[];
  /** How the table should resolve each row's `label` at this level. */
  labelKind: (level: RowLevel) => LabelKind;
  /** Rows for the current pin state. */
  rows: (input: {
    encounter: EncounterState;
    partyData: Array<PlayerData | null>;
    players: ComputedPlayerState[];
    level: RowLevel;
    pins: SelectorPins;
    /** Every status window in the fight, players and enemies alike. The Buffs
     * and Debuffs descriptors split them by holder; optional because a log
     * recorded before status capture has none. */
    statusIntervals?: StatusInterval[];
    /** Denominator for an uptime percentage. Optional for the same reason. */
    fightDurationMs?: number;
  }) => MetricRow[];
};
