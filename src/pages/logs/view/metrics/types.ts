import type { ComputedPlayerState, EncounterState, PlayerData, SkillState, StatusInterval } from "@/types";

import type { RowKeying } from "../abilitySkills";
import type { SelectorPins } from "../selectorOptions";

/** What a row represents at the current pin state — the legacy descriptors'
 * level vocabulary, a projection of the machine's grouping dimension
 * (source→players, ability→abilities, target→skills; see `levelFor`).
 *
 * `"skills"` and not `"hits"`: the parser cannot produce per-hit rows, and this
 * level lists the pinned ability's MEMBER SKILLS — what a condensed group is
 * made of — so a name promising hits misleads. */
export type RowLevel = "players" | "abilities" | "skills";

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
  /** The part of `value` that is supplementary (echo) damage, drawn as a
   * fainter segment at the bar's right end. Absent when the row has none or
   * the collapse toggle is off — never 0, which would mount an empty segment. */
  subValue?: number;
  /** Right-hand numeric columns, already formatted. */
  columns: string[];
  /** What clicking this row pins, or null if the row is a leaf. */
  pinOnClick: Partial<SelectorPins> | null;
  /** Party slot this row's colour comes from, or -1 when it has none (a hit, an
   * enemy). The table resolves the slot to a colour, so descriptors stay pure
   * functions with no reach into the settings store. */
  colorSlot: number;
  /** i18next key naming this row directly, for a row that names no ability,
   * player or effect at all — today only the SBA table's unattributed
   * remainder. Where it is set the table draws `t(labelKey)` and no icon,
   * bypassing the `kind` resolution entirely: there is nothing to resolve, and
   * putting a sentinel through the ability join would print whatever that join
   * makes of a name it has never seen. */
  labelKey?: string;
  /** Interpolation values for `labelKey`, for a self-naming row whose text
   * carries a discriminator ("Effect 4242"). Ignored without `labelKey`. */
  labelParams?: Record<string, string | number>;
  /** What this row is, where the level alone cannot say.
   *
   * `MetricDescriptor.labelKind` answers per LEVEL, which holds until one level
   * can produce more than one shape of row: the deepest damage level decomposes
   * a pinned ability into its group's member skills, the enemies it hit, or the
   * players who used it, depending on which of those the pins have left free.
   * Absent, the level's own kind stands. */
  kind?: LabelKind;
  /** Member rows behind a skill-group parent on the groups path, each
   * pinnable by its raw action. The table renders them indented behind an
   * expand control; a row without them has nothing to expand. */
  children?: MetricRow[];
  /** Contiguous windows this row's effect was up, in MILLISECONDS FROM THE
   * START OF THE MEASURED WINDOW, overlaps merged.
   *
   * Present only on the status tables. Where it is set the table draws a
   * timeline instead of a magnitude bar: Warcraft Logs' uptime bar is
   * positional, and against a `%` column that already states the magnitude a
   * second reading of the same number says nothing. */
  timeline?: { startMs: number; endMs: number }[];
};

/** What `label` should be resolved against before it is drawn.
 *
 * `"status"` is the buff/debuff row: a `status:<effect>:<cause>` key that reads
 * as "Attack Up (Signo Drive)" — the effect first so shared effects sort
 * together, the cause in parentheses because two abilities granting one effect
 * are two rows.
 *
 * `"target"` is the debuff holder row: a `target:<segment>` or `actor:<id>` key
 * naming the enemy SPAWN that held the effect.
 *
 * `"enemy"` is an enemy TYPE, as the JSON of an `EnemyType`. Distinct from
 * `"target"` because it names something coarser: the per-skill damage breakdown
 * (`SkillState.targets`) records a type and merges same-type spawns, so a row
 * built from it cannot point at one spawn and must not pretend to.
 *
 * `"takenAttack"` is one enemy ATTACK on the damage-taken tab: a JSON
 * `{enemyType, actionId}` pair (see `takenAttackRowParts`), named as the enemy
 * plus its attack id — the game data carries no names for enemy actions. */
export type LabelKind = "player" | "ability" | "status" | "target" | "enemy" | "takenAttack";

/** Which side's holders the status tables are about — WCL's
 * Friendlies/Enemies switch. Polarity (buff vs debuff) is fixed per tab; this
 * picks the holders, so all four quadrants are reachable. */
export type Hostility = "friendly" | "enemy";

/** What the row hover card measures, for the metrics that have a breakdown
 * behind their rows.
 *
 * The card used to read `SkillState.totalDamage` unconditionally and head its
 * amount column "DMG", so every tab's tooltip reported damage — the Stun tab
 * explained a stun bar with damage figures, and the SBA tab explained a gauge
 * with them. What a card measures follows the metric, so the metric says. */
export type MetricCard = {
  /** i18next key for the card's amount column — what the figures ARE. */
  amountKey: string;
  /** This metric's figure on one breakdown row. */
  valueOf: (skill: SkillState) => number;
  /** How that figure is written. Damage humanizes to "1.5m"; stun is a small
   * number where a suffix would only lose precision. */
  format: (value: number) => string;
  /** Whether the parser records this metric PER ENEMY. Damage does
   * (`SkillTargetState.totalDamage`); stun does not, and a by-target section
   * built from what is there would print damage under a stun heading — the
   * original defect, one level down. */
  perTarget: boolean;
};

/** Everything a metric needs to turn encounter state into rows. */
export type MetricDescriptor = {
  /** i18next key for the switcher label. */
  labelKey: string;
  /** Whether the Friendlies/Enemies toggle operates on this tab. Absent =
   * disabled (SBA is a per-player gauge and stun has no honest enemy-side
   * decomposition — its two capture paths reconcile with max()). */
  supportsHostility?: boolean;
  /** i18next keys for the numeric column headers at a given level.
   *
   * A function of the level, not a fixed list: descending from players to
   * abilities swaps DPS for a hit count, and a header that keeps saying DPS
   * over a column of hit counts is worse than no header at all. */
  columnKeys: (level: RowLevel) => string[];
  /** How the table should resolve each row's `label` at this level. */
  labelKind: (level: RowLevel) => LabelKind;
  /** What a row's hover card decomposes, or absent where the metric has
   * nothing to decompose: SBA is a gauge reading, and the status tables' rows
   * are effects and their holders rather than sums over skills. Absent, rows
   * carry no card at all — which is what "no breakdown" should look like. */
  card?: MetricCard;
  /** Rows for the current pin state. */
  rows: (input: {
    encounter: EncounterState;
    partyData: Array<PlayerData | null>;
    players: ComputedPlayerState[];
    level: RowLevel;
    pins: SelectorPins;
    /** Every status window in the fight, players and enemies alike. The Buffs
     * and Debuffs descriptors split them by polarity (which tab) and holder
     * side (the `hostility` input below); optional because a log recorded
     * before status capture has none. */
    statusIntervals?: StatusInterval[];
    /** Denominator for an uptime percentage. Optional for the same reason. */
    fightDurationMs?: number;
    /** The FULL party, unnarrowed by any pin — identity, not figures.
     * `players` is the scoped party, which a source pin shrinks to one; a
     * descriptor that uses it as a ROSTER (the status tables, deciding buff
     * from debuff) would file the rest of the party's effects as enemy-held. */
    roster?: ComputedPlayerState[];
    /** The window the status tables measure, in milliseconds from the fight's
     * start. Needed to rebase `MetricRow.timeline` onto the chart's own first
     * bucket — `fightDurationMs` gives its length but not where it begins, and
     * a scrubbed table would otherwise draw every band at absolute fight time
     * over a chart that starts somewhere else. */
    statusWindow?: { startMs: number; endMs: number };
    /** Which side's holders the status descriptors select. Absent, each tab
     * uses its natural side: Buffs → friendly, Debuffs → enemy. */
    hostility?: Hostility;
    /** How the view keys its rows — today, whether echo damage rides the skill
     * that caused it. Passed in rather than rebuilt per descriptor: the table,
     * the chart and the timeline must agree about which row an echo is on, and
     * deriving it three times is how they would come to differ. */
    keying?: RowKeying;
  }) => MetricRow[];
  /** Child rows behind ONE row at the current level, or null where it has
   * none — the table's in-place nesting. Party-wide ability rows split per
   * SOURCE out of the derived state, synchronously (the same data the hover
   * cards decompose — no fetch); with a source pinned the groups-path parent
   * already carries its member variants on `MetricRow.children`, so the
   * accessor answers null and the table falls back to those. Optional
   * because only the damage tabs have nesting semantics — stun/SBA and the
   * aura tables have nothing honest to nest. */
  children?: (input: {
    row: MetricRow;
    players: ComputedPlayerState[];
    level: RowLevel;
    pins: SelectorPins;
    hostility?: Hostility;
    fightDurationMs?: number;
  }) => MetricRow[] | null;
};
