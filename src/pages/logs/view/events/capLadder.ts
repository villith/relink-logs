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

/**
 * The game's own base-cap lookup, arithmetic included: walk to the first row
 * whose x strictly exceeds the rate (f32 compare), lerp against its
 * predecessor in f32, hold flat at both ends, truncate.
 *
 * Single precision is load-bearing, not pedantry. The rows are f32 and the
 * builder lerps in f32; a double-precision mirror of the same expression lands
 * one integer LOW at every exact row rate (0.2 -> 1998 instead of 1999),
 * because the decimal rate is not representable and the f64 lerp preserves the
 * shortfall that f32 rounds away. A wrong-by-one base poisons the integer
 * consistency check downstream.
 */
export const gameLadderBase = (points: LadderPoint[], rate: number): number => {
  if (points.length === 0) return 0;
  const r = f(rate);
  let lo: LadderPoint | null = null;
  for (const p of points) {
    if (r < f(p.x)) {
      // No predecessor: the rate sits before the first row, which holds flat.
      if (lo === null) return Math.trunc(f(p.y));
      const span = f(f(p.x) - f(lo.x));
      if (span <= 0) return Math.trunc(f(lo.y));
      // The builder's own expression shape: ((hi.y - lo.y) * (rate - lo.x)) / span + lo.y.
      const lerped = f(f(f(f(p.y) - f(lo.y)) * f(r - f(lo.x))) / span);
      return Math.trunc(f(lerped + f(lo.y)));
    }
    lo = p;
  }
  return Math.trunc(f(points[points.length - 1].y));
};

/**
 * The ladder a hit's base cap comes from, or `null` when the log cannot say.
 *
 * The selection order is the builder's own: the summon bit is tested FIRST (the
 * sign of the flag byte), so a summon hit reads the shared `SO0000` curve even
 * when the arts bit is also set; only then does `0x40000` choose the arts map,
 * keyed by the attacker's character.
 */
export const ladderCurveFor = (
  characterType: CharacterType | undefined,
  classFlags: number | null
): LadderPoint[] | null => {
  if (classFlags === null) return null;
  if (classFlags & 0x80) return CURVES.normal[SUMMON_CURVE_KEY] ?? null;
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
