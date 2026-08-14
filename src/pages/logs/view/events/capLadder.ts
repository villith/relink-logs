import characterIdHashes from "@/assets/character-id-hashes.json";
import type { CharacterType } from "@/types";
import capTables from "../../../../../src-tauri/assets/damage-cap-tables.json";

/** One ladder row, as extracted: x is the attack rate, y the base cap. */
export type LadderPoint = { x: number; y: number };

/** `xxhash32("SO0000")` — the curve the builder uses for any hit whose class
 * flags carry bit 7 (summons), looked up in the NORMAL map regardless of the
 * attack class. Verified against the runtime map, which holds this key. */
const SUMMON_CURVE_KEY = "58f4dbd4";

const CURVES = capTables.curves as Record<"normal" | "arts", Record<string, LadderPoint[]>>;

/** `"Pl0300"` -> `"079df0cc"`, inverted once from the hash->name table the
 * frontend already ships. The ladder maps are keyed by the hash. */
const HASH_BY_CHARACTER: Map<string, string> = new Map(
  Object.entries(characterIdHashes as Record<string, string>).map(([hash, name]) => [name, hash])
);

const f = Math.fround;

/** Which arm of the ladder walk produced the base — what the debug panel prints
 * instead of a lerp expression it never evaluated.
 *
 * `below`/`above` are the flat holds outside the table, `empty` a curve with no
 * rows at all. There is deliberately no zero-span arm: the walk advances `lo`
 * only while `rate >= lo.x` and stops at the first `rate < hi.x`, so any
 * bracket it returns spans a positive width. */
export type LadderBranch = "empty" | "below" | "lerp" | "above";

/** A row and where it sits in the curve — the index is what lets the panel say
 * "rows 8→9 of 14" rather than quoting two anonymous coordinate pairs. */
export type LadderRow = { index: number; point: LadderPoint };

/**
 * The ladder walk with its working shown: which rows bracketed the rate, which
 * arm ran, and the operands of the lerp it evaluated.
 *
 * `rise`/`span`/`offset`/`lerped` are the pieces of the builder's own
 * expression, each already rounded to f32 exactly as the game holds it, so the
 * panel can print the arithmetic rather than assert it. They are 0 on every arm
 * but `lerp`, which ran no arithmetic to show.
 *
 * Single precision is load-bearing, not pedantry. The rows are f32 and the
 * builder lerps in f32; a double-precision mirror of the same expression lands
 * one integer LOW at every exact row rate (0.2 -> 1998 instead of 1999),
 * because the decimal rate is not representable and the f64 lerp preserves the
 * shortfall that f32 rounds away. A wrong-by-one base poisons the integer
 * consistency check downstream.
 */
export const gameLadderTrace = (points: LadderPoint[], rate: number): LadderTrace => {
  const empty: LadderTrace = { branch: "empty", lo: null, hi: null, rise: 0, span: 0, offset: 0, lerped: 0, base: 0 };
  if (points.length === 0) return empty;

  const r = f(rate);
  let lo: LadderRow | null = null;
  for (const [index, point] of points.entries()) {
    // Walk to the first row whose x STRICTLY exceeds the rate, in f32 — the
    // strictness is why a rate sitting exactly on a row takes that row's value
    // through the lerp below rather than holding its predecessor.
    if (r < f(point.x)) {
      const hi: LadderRow = { index, point };
      // No predecessor: the rate sits before the first row, which holds flat.
      if (lo === null) return { ...empty, branch: "below", hi, base: Math.trunc(f(point.y)) };
      const span = f(f(point.x) - f(lo.point.x));
      const rise = f(f(point.y) - f(lo.point.y));
      const offset = f(r - f(lo.point.x));
      // The builder's own expression shape: ((hi.y - lo.y) * (rate - lo.x)) / span + lo.y.
      const lerped = f(f(f(rise * offset) / span) + f(lo.point.y));
      return { branch: "lerp", lo, hi, rise, span, offset, lerped, base: Math.trunc(lerped) };
    }
    lo = { index, point };
  }
  return { ...empty, branch: "above", lo, base: Math.trunc(f(points[points.length - 1].y)) };
};

export type LadderTrace = {
  branch: LadderBranch;
  /** The bracketing rows. `lo` is absent below the table, `hi` past its end. */
  lo: LadderRow | null;
  hi: LadderRow | null;
  rise: number;
  span: number;
  offset: number;
  /** The interpolated value BEFORE truncation — the fractional part is what
   * `base` drops, and seeing it is how a reader tells a near-miss from a hit. */
  lerped: number;
  base: number;
};

/** The game's own base-cap lookup. The walk itself lives in [`gameLadderTrace`]
 * — one f32 implementation, so the number the tooltip shows and the arithmetic
 * the debug panel prints cannot disagree. */
export const gameLadderBase = (points: LadderPoint[], rate: number): number => gameLadderTrace(points, rate).base;

/**
 * The ladder a hit's base cap comes from, or `null` when the log cannot say.
 *
 * The selection order is the builder's own: the summon bit is tested FIRST (the
 * sign of the flag byte), so a summon hit reads the shared `SO0000` curve even
 * when the arts bit is also set; only then does `0x40000` choose the arts map,
 * keyed by the attacker's character.
 */
/** The builder's summon test — the sign of the class-flag byte. A summon-class
 * hit reads the shared `SO0000` curve AND takes none of the player's cap-up
 * terms: the additive terms are the ATTACKER's, and the summon actor carries no
 * store, traits or channel. Every summon-class capped hit in the capture-era
 * corpus logs `cap == trunc(base)` exactly (57 hits, log 2654, three distinct
 * rates — one character so far; the blind sweep re-verifies as more land). */
export const isSummonClass = (classFlags: number | null): boolean => classFlags !== null && (classFlags & 0x80) !== 0;

export const ladderCurveFor = (
  characterType: CharacterType | undefined,
  classFlags: number | null
): LadderPoint[] | null => {
  if (classFlags === null) return null;
  if (isSummonClass(classFlags)) return CURVES.normal[SUMMON_CURVE_KEY] ?? null;
  if (typeof characterType !== "string") return null;
  const hash = HASH_BY_CHARACTER.get(characterType);
  if (hash === undefined) return null;
  const table = classFlags & 0x40000 ? CURVES.arts : CURVES.normal;
  return table[hash] ?? null;
};

/** The game's own fused cap-up for one hit — `cap / base − 1`, the number every
 * derived source must reconcile against. Per hit, so it tracks mid-fight
 * changes the load-time capture cannot. */
export const gameCapUp = (cap: number, base: number): number | null => {
  if (cap <= 0 || base <= 0) return null;
  return cap / base - 1;
};

/**
 * Whether the logged cap is one the game's formula can produce from this base:
 * `cap = trunc(base x K/100)` for some integer K, since every cap-up source is
 * an integer percent count.
 *
 * The tolerance is there for the formula's own arithmetic, not for us: the
 * multiplier is a SUM of many f32 terms, so at large bases the product drifts
 * off the exact integer grid by up to ~1e-5 relative. Below that scale the
 * check is exact, and a cap between grid points is one the formula cannot have
 * produced for this character and rate.
 */
export const capConsistent = (cap: number, base: number): boolean => {
  if (cap <= 0 || base <= 0) return false;
  const k = Math.round((100 * cap) / base);
  if (k < 100) return false;
  const predicted = (base * k) / 100;
  const tolerance = Math.max(1, predicted * 1e-5);
  // trunc(predicted) == cap within drift: the truncation makes the acceptable
  // band [cap, cap + 1), widened by the tolerance on both sides.
  return cap >= Math.trunc(predicted - tolerance) && cap <= Math.trunc(predicted + tolerance);
};
