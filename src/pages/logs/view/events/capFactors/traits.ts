import { computeCombinedTraits, toHashString } from "@/utils";

import type { CapClass, CapLoadout } from "../capSources";
import { conditionalTraitTable, traitInput, traitRow, traitRowValue, traitTable } from "./tables";
import {
  activeResult,
  inactiveResult,
  notApplicableResult,
  unknownResult,
  type CapConditions,
  type CapFactor,
  type CapFactorResult,
  type CapParamKey,
} from "./types";

/**
 * Every equipped trait as a factor that can value itself.
 *
 * An unconditional trait declares no params and reads its table row. A
 * conditional one declares the runtime state its own effect text names — the
 * HP fraction Celestial Lumen gates on, the crit rate Cobalt ramps across, the
 * charge grade Thunderwolf's picks a column by — and evaluates against it. The
 * thresholds are not written here: they are shipped columns of the same table
 * the magnitudes come from (see `gen-cap-up-sources.py`), so a game patch that
 * moves a gate moves it here too.
 */

/** The plain DMG Cap trait. The one unconditional cap trait the game does NOT
 * fuse into the per-player record — the builder reads it through a second
 * lookup keyed by this hash, so it attributes as its own term. */
export const DMG_CAP_TRAIT = 0xdc584f60;

/** Cardinal V / Sage V — the only stack count either trait's text quotes. */
const MAX_STACK = 5;

/** "DMG Cap +15% per active pet". The 15 is literal in the game's own text, not
 * a table column, which is why Phantasm's Harmony ships no magnitude. */
const PHANTASM_PER_PET = 15;

/** What a conditional trait needs to know, given its combined level and the
 * maximum it would reach. */
type Evaluator = { params: readonly CapParamKey[]; evaluate: (level: number, max: number) => CapFactor["evaluate"] };

/** A band: nothing below `minInput`, the low value there, ramping to the
 * trait's maximum at `maxInput`, and holding past it. */
const banded =
  (param: CapParamKey, minInput: string, maxInput: string, read: (c: CapConditions) => number | undefined) =>
  (id: number): Evaluator => ({
    params: [param],
    evaluate: (level, max) => (conditions) => {
      const value = read(conditions);
      if (value === undefined) return unknownResult(max, [param]);
      const low = traitInput(id, level, minInput);
      const high = traitInput(id, level, maxInput);
      const capMin = traitInput(id, level, "capMin");
      if (low === null || high === null || capMin === null) return unknownResult(max, [], "scaling-unknown");
      if (value < low) return inactiveResult(max);
      if (value >= high) return activeResult(max);
      // Linear between the two quoted ends. The band's ends are integers and
      // the game sums cap-up terms in f32, so an intermediate is a real value
      // rather than a rounding artefact.
      const span = high - low;
      return activeResult(span === 0 ? max : capMin + ((max - capMin) * (value - low)) / span);
    },
  });

/** A gate whose threshold is one of the trait's own shipped columns. */
const threshold =
  (
    param: CapParamKey,
    input: string,
    read: (c: CapConditions) => number | undefined,
    passes: (value: number, threshold: number) => boolean
  ) =>
  (id: number): Evaluator => ({
    params: [param],
    evaluate: (level, max) => (conditions) => {
      const value = read(conditions);
      if (value === undefined) return unknownResult(max, [param]);
      const gate = traitInput(id, level, input);
      if (gate === null) return unknownResult(max, [], "scaling-unknown");
      return passes(value, gate) ? activeResult(max) : inactiveResult(max);
    },
  });

/** A timed buff. The magnitude is known; which status id carries it is not, so
 * even a caller that supplies the active buff list cannot settle it yet. */
const timedBuff = () => (): Evaluator => ({
  params: ["buffs"],
  evaluate: (_level, max) => (conditions) =>
    conditions.buffs === undefined ? unknownResult(max, ["buffs"]) : unknownResult(max, [], "no-status-mapping"),
});

/** Stack-gated, with only the full-stack value quoted anywhere. */
const stackGated =
  () =>
  (id: number): Evaluator => ({
    params: ["stacks"],
    evaluate: (_level, max) => (conditions) => {
      const stacks = conditions.stacks;
      if (stacks === undefined) return unknownResult(max, ["stacks"]);
      const count = stacks[toHashString(id)] ?? 0;
      if (count >= MAX_STACK) return activeResult(max);
      if (count <= 0) return inactiveResult(max);
      // Between 1 and 4 the game quotes no number, and interpolating one would
      // put a value on screen the game never stated.
      return unknownResult(max, [], "stack-curve-unknown");
    },
  });

/** Per-charge-grade columns: the two lower grades are shipped as inputs, the
 * top grade IS the emitted maximum. */
const chargeGraded =
  () =>
  (id: number): Evaluator => ({
    params: ["chargeGrade"],
    evaluate: (level, max) => (conditions) => {
      const grade = conditions.chargeGrade;
      if (grade === undefined) return unknownResult(max, ["chargeGrade"]);
      if (grade >= 4) return activeResult(max);
      const column = grade === 3 ? "gradeIII" : grade === 2 ? "gradeII" : null;
      if (column === null) return inactiveResult(max);
      const value = traitInput(id, level, column);
      return value === null || value === 0 ? inactiveResult(max) : activeResult(value);
    },
  });

/** A flat per-unit rate the text states literally rather than tabling. */
const perUnit =
  (param: CapParamKey, rate: number, read: (c: CapConditions) => number | undefined) => (): Evaluator => ({
    params: [param],
    evaluate: () => (conditions) => {
      const count = read(conditions);
      if (count === undefined) return unknownResult(rate, [param]);
      return count > 0 ? activeResult(rate * count) : inactiveResult(rate);
    },
  });

/** The magnitude is known; what it scales with is not stated anywhere. */
const unstatedScaling = () => (): Evaluator => ({
  params: ["questAccum"],
  evaluate: (_level, max) => () => unknownResult(max, [], "scaling-unknown"),
});

/** One evaluator per conditional cap trait, keyed by trait id.
 *
 * Every entry corresponds to a line of the trait's own effect text; the
 * comments quote it, because the text IS the specification. */
const CONDITIONAL_EVALUATORS: Record<number, (id: number) => Evaluator> = {
  // "While at {2}% HP or more: ATK +{0}% / DMG Cap+{1}%"
  0xa7726190: threshold(
    "hpRatio",
    "hpPercentAtLeast",
    (c) => c.hpRatio,
    (hp, gate) => hp * 100 >= gate
  ),
  // "While at {2}% HP or less: ..."
  0x0de887a0: threshold(
    "hpRatio",
    "hpPercentAtMost",
    (c) => c.hpRatio,
    (hp, gate) => hp * 100 <= gate
  ),
  // "When at {4} max HP or less: ..." — a FLAT HP threshold, not a fraction.
  0x40223c28: threshold(
    "hp",
    "hpAtMost",
    (c) => c.hp,
    (hp, gate) => hp <= gate
  ),
  0x1e1cecce: threshold(
    "hp",
    "hpAtMost",
    (c) => c.hp,
    (hp, gate) => hp <= gate
  ),
  // "Min boost: ... (At Crit. Hit Rate {4}%+) / Max boost: ... (At {5}%+)"
  0xaefeb1bc: banded("critRate", "critMin", "critMax", (c) => c.critRate),
  // "Min boost: ... (At {4} max HP or more) / Max boost: ... (At {5} or more)"
  0x3b71af12: banded("maxHp", "maxHpMin", "maxHpMax", (c) => c.maxHp),
  // "Max boost: ... (At Cardinal V)" / "(At Sage V)"
  0x0151cf9e: stackGated(),
  0xfff8cf64: stackGated(),
  // "DMG Cap↑ ({0}%) for {1} sec."
  0x30773197: timedBuff(),
  0xed8d8ad8: timedBuff(),
  // "On recovery: ... / DMG Cap +{3}%"
  0x46ee3116: timedBuff(),
  // "DMG Cap +{0}% during Invincibility from a perfect dodge"
  0x51c115d2: timedBuff(),
  // "Boosts DMG Cap by a max of +{0}%" — no basis stated.
  0x461a8e07: unstatedScaling(),
  // "Grade II Shot DMG Cap +{0}% / Grade III +{1}% / Grade IV +{2}%"
  0xbe3404b9: chargeGraded(),
  // "DMG Cap +15% per active pet"
  0x7351d602: perUnit("petCount", PHANTASM_PER_PET, (c) => c.petCount),
};

/** The traits that gate but ship no magnitude of their own, so they never
 * appear in the conditional value table. */
const MAGNITUDE_IN_TEXT: Record<number, number> = { 0x7351d602: PHANTASM_PER_PET };

const unconditionalFactor = (id: number, level: number, capClass: CapClass): CapFactorResult => {
  const row = traitRow(traitTable, id, level);
  if (row === null) return notApplicableResult("not-a-cap-source");
  const percent = row[{ normal: 0, skill: 1, sba: 2 }[capClass]];
  if (percent !== 0) return activeResult(percent);
  // A zero means one of two different things and the reader needs to know
  // which: a cap trait for another class, or one that has not scaled in yet.
  return notApplicableResult(row.some((value) => value !== 0) ? "other-class" : "zero-at-level");
};

/**
 * Every combined trait the player carries, as a factor.
 *
 * One entry per trait, never filtered — a source that was weighed and dismissed
 * has to stay visible, or it is indistinguishable from one the model never knew
 * about.
 */
export const traitFactors = (player: CapLoadout | undefined, capClass: CapClass | null): CapFactor[] => {
  if (player === undefined || capClass === null) return [];

  return computeCombinedTraits(player).map(({ id, level }): CapFactor => {
    const base = { key: `trait-${toHashString(id)}`, kind: "trait" as const, id, label: null, level };

    const conditional = CONDITIONAL_EVALUATORS[id];
    if (conditional !== undefined) {
      const max = MAGNITUDE_IN_TEXT[id] ?? traitRowValue(conditionalTraitTable, id, level, capClass);
      const { params, evaluate } = conditional(id);
      // A conditional trait whose row is all zeroes at this level cannot fire
      // whatever the runtime state is, so it is rejected outright rather than
      // rendered as forever-unresolved.
      if (max === 0) return { ...base, params: [], evaluate: () => notApplicableResult("zero-at-level") };
      return { ...base, params, evaluate: evaluate(level, max) };
    }

    const result = unconditionalFactor(id, level, capClass);
    return { ...base, params: [], evaluate: () => result };
  });
};
