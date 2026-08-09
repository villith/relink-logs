/**
 * The contract every damage-cap contributor is modelled through.
 *
 * The game fuses every cap-up source into one number per attack class before
 * the hook can see it, so the breakdown reconstructs the sources independently.
 * This module makes each source its OWN unit: a factor that knows what it is
 * worth, and — when that depends on runtime state — what it would need to be
 * told in order to say.
 *
 * Pure: no React, no i18n, no formatting. A factor returns numbers and a state;
 * naming and rendering belong to the caller.
 */

/** A piece of runtime state a conditional factor may need.
 *
 * Deliberately a closed union rather than a free-form bag: a factor that asks
 * for a param nobody can supply is a factor that will always read `unknown`,
 * and the type is what makes that visible at the call site instead of at
 * runtime. */
export type CapParamKey =
  | "hp"
  | "hpRatio"
  | "critRate"
  | "maxHp"
  | "stacks"
  | "buffs"
  | "chargeGrade"
  | "petCount"
  | "stance"
  | "questAccum"
  | "actionId";

/** What the caller knows about the moment a hit landed. Every field is optional
 * — the log carries none of them today, and a factor handed nothing must say
 * `unknown` rather than assume. */
export type CapConditions = Partial<{
  /** Current HP, flat. Catastrophe's gate is a flat 45000, not a fraction. */
  hp: number;
  /** Current HP as a fraction of max, 0..1. */
  hpRatio: number;
  /** Critical hit rate, percent — the same units the trait tables use. */
  critRate: number;
  /** Max HP, flat. */
  maxHp: number;
  /** Effect level per stacking buff, keyed by the buff's own id as a string. */
  stacks: Readonly<Record<string, number>>;
  /** Status ids active on the attacker at the moment of the hit. */
  buffs: readonly number[];
  /** Charge grade of the shot that landed (Thunderwolf's Acuity: II, III, IV). */
  chargeGrade: number;
  /** Pets active on the field. */
  petCount: number;
  /** Character-specific stance name, lower case. */
  stance: string;
  /** Run-scoped accumulators ("damage taken this quest", "times summoned"). */
  questAccum: Readonly<Record<string, number>>;
  /** The action id of the hit, for board nodes scoped to one move. */
  actionId: number;
}>;

/**
 * Whether a factor applied, and if not, why not.
 *
 * `unknown` is the load-bearing one. A conditional factor the caller could not
 * resolve is neither zero nor its maximum: valued at zero it vanishes from the
 * breakdown, valued at its maximum it shrinks Unaccounted by a number the
 * formula did not necessarily use. It contributes 0 and carries its potential
 * separately, so the residual can be NAMED without being claimed.
 */
export type CapFactorState = "active" | "inactive" | "unknown" | "not-applicable";

/**
 * Why a factor gave nothing, beyond what its state already says.
 *
 * A rejected contributor has to name its own reason: in a breakdown, a source
 * that was weighed and dismissed is indistinguishable from one the model never
 * knew about unless it says which it is.
 */
export type CapFactorReason =
  /** No row in any cap table — an ATK or HP trait, a non-cap overmastery roll. */
  | "not-a-cap-source"
  /** A cap source, but one that raises a different attack class. */
  | "other-class"
  /** In the table, but its row is all zeroes at the level reached. */
  | "zero-at-level"
  /** A magnitude the log never captured (a v2.0.2 town-loadout recovery). */
  | "value-unrecorded"
  /** Stack-gated, and only the value at full stacks is in the game's text — an
   * intermediate stack has no quoted number to report. */
  | "stack-curve-unknown"
  /** The magnitude is known but what it scales with is not. */
  | "scaling-unknown"
  /** A timed buff whose status id this model cannot yet name, so an active
   * buff list cannot settle it. */
  | "no-status-mapping"
  /** A board node scoped to a move named only in prose, so the hit's action id
   * cannot be matched against it yet. */
  | "no-action-mapping"
  /** A board node whose effect text the generator could not classify. */
  | "unparsed";

export type CapFactorResult = {
  /** What this factor contributed to THIS hit, in table units (30 = +30%).
   * Non-zero only when `state` is `active`. */
  percent: number;
  /** What it would contribute with its conditions fully met. Equal to `percent`
   * when active; the reason an unresolved row is still worth rendering. */
  potential: number;
  state: CapFactorState;
  /** The params it needed and was not given. Empty unless `state` is `unknown`. */
  missing: readonly CapParamKey[];
  /** Present when the state alone does not explain the outcome. */
  reason?: CapFactorReason;
};

const NO_PARAMS: readonly CapParamKey[] = [];

/** A factor that applied, at its full value. */
export const activeResult = (percent: number): CapFactorResult => ({
  percent,
  potential: percent,
  state: "active",
  missing: NO_PARAMS,
});

/** A factor whose gate was evaluated and not met. The potential is kept: what a
 * trait WOULD have given is the reason its row is on screen. */
export const inactiveResult = (potential: number): CapFactorResult => ({
  percent: 0,
  potential,
  state: "inactive",
  missing: NO_PARAMS,
});

/** A factor whose gate could not be evaluated, naming what was missing.
 *
 * `missing` empty with a `reason` set is the case where the caller supplied
 * everything and the MODEL still cannot say — an unmapped status id, an
 * unknown scaling basis. Those are the rows that mark where this reconstruction
 * ends, and they must not read as "you forgot to pass something". */
export const unknownResult = (
  potential: number,
  missing: readonly CapParamKey[],
  reason?: CapFactorReason
): CapFactorResult => ({
  percent: 0,
  potential,
  state: "unknown",
  missing,
  ...(reason === undefined ? {} : { reason }),
});

/** A factor that raises a different attack class, or is not a cap source at
 * all. No potential: it could not contribute to this hit under any state. */
export const notApplicableResult = (reason: CapFactorReason): CapFactorResult => ({
  percent: 0,
  potential: 0,
  state: "not-applicable",
  missing: NO_PARAMS,
  reason,
});

export type CapFactorKind = "trait" | "overmastery" | "summon-bonus" | "board-node" | "account";

/**
 * One cap-up contributor, evaluable on its own.
 *
 * `params` is the declaration the whole design turns on: an unconditional
 * factor declares `[]` and its `evaluate` ignores its argument, while a
 * conditional one lists exactly what it needs — so a caller can ask "what
 * would I have to know to resolve this row?" without evaluating anything.
 */
export type CapFactor = {
  /** Stable, unique across the whole set — this is the React key. */
  key: string;
  kind: CapFactorKind;
  /** Trait id, overmastery id, summon bonus id, or board node id. */
  id: number;
  /** For contributors with no translatable game id of their own (board nodes,
   * account terms): the text to show. `null` when `id` names it. */
  label: string | null;
  /** Combined trait level or summon bonus level; `null` where there is none. */
  level: number | null;
  /** An i18n key naming what this factor IS, when its own name is not enough to
   * tell it apart from a sibling. A boundary trait contributes two rows under
   * one translated name, and two rows that read identically but hold different
   * numbers are the exact failure this breakdown exists to prevent. */
  sourceKey?: string;
  params: readonly CapParamKey[];
  evaluate: (conditions: CapConditions) => CapFactorResult;
};
