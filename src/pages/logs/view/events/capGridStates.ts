import type { CharacterType } from "@/types";

import type { CapHit } from "./capBreakdown";
import { capConsistent, gameLadderBase, ladderCurveFor } from "./capLadder";

/**
 * The per-actor grid-state registry behind the cap card's transition verdict.
 *
 * `capConsistent` judges one hit in isolation; a state-gated cap term EASES
 * between values over ~1.3s (plus a multi-second settling tail), so a hit
 * landed mid-ease fails the check while carrying the game's own arithmetic.
 * The residual scan (`cap_residual_scan.rs`) proved such hits sit strictly
 * between the actor's own on-grid states of the same attack class. This
 * module is that scan's frontend mirror: build the observed on-grid K set per
 * actor and bucket from the full event stream, then let an off-grid hit be
 * judged against its actor's own states — never anyone else's, and never
 * rationalized into a bracket that does not exist.
 */

/** Attack-class bucket. K is only comparable within one bucket (the record's
 * cap-up differs per class); the order mirrors the game builder and the
 * residual scan: the summon bit is tested first, then SBA, then skill. */
export type CapBucket = "normal" | "skill" | "sba" | "summon";

export const capBucketOf = (classFlags: number | null): CapBucket | null => {
  if (classFlags === null) return null;
  if (classFlags & 0x80) return "summon";
  if (classFlags & 0x40000) return "sba";
  if (classFlags & 0x10000) return "skill";
  return "normal";
};

/** K → count of on-grid hits observed at it. */
export type GridKStates = Map<number, number>;
export type GridStateMap = Map<number, Map<CapBucket, GridKStates>>;

/** What the registry needs from one event row — the Amount cell's own
 * `capHit` plus the acting player's index, so any surface that renders the
 * card can also feed the registry. */
export type GridSourceRow = { sourceIndex: number | null; hit: CapHit | null };

/** The ease tail parks within ~0.1 of its target for seconds (measured
 * 69.93 → 69.999); 0.15 is the residual scan's own tolerance. */
const SETTLING_TOLERANCE = 0.15;

export const buildGridStates = (
  rows: readonly GridSourceRow[],
  characterOf: (actorIndex: number) => CharacterType | undefined
): GridStateMap => {
  const states: GridStateMap = new Map();
  for (const { sourceIndex, hit } of rows) {
    if (sourceIndex === null || hit === null) continue;
    const { damage_cap: cap, attack_rate: rate, class_flags: flags } = hit;
    const bucket = capBucketOf(flags);
    if (cap === null || cap <= 0 || rate === null || bucket === null) continue;
    const curve = ladderCurveFor(characterOf(sourceIndex), flags);
    if (curve === null) continue;
    const base = gameLadderBase(curve, rate);
    if (base <= 0 || !capConsistent(cap, base)) continue;
    const k = Math.round((100 * cap) / base);
    const buckets = states.get(sourceIndex) ?? new Map<CapBucket, GridKStates>();
    const ks = buckets.get(bucket) ?? new Map<number, number>();
    ks.set(k, (ks.get(k) ?? 0) + 1);
    buckets.set(bucket, ks);
    states.set(sourceIndex, buckets);
  }
  return states;
};

/** Why an off-grid K is still the game's own arithmetic — or `null` when the
 * actor's observed states cannot vouch for it (which keeps today's ✗).
 * `transition` requires a real bracket: at least two distinct states, with
 * the K STRICTLY between the extremes. `settling` is the asymptotic tail,
 * within tolerance of any single observed state. */
export const classifyOffGrid = (kFloat: number, states: GridKStates | undefined): "transition" | "settling" | null => {
  if (states === undefined || states.size === 0) return null;
  const ks = [...states.keys()];
  const lo = Math.min(...ks);
  const hi = Math.max(...ks);
  if (lo < hi && kFloat > lo && kFloat < hi) return "transition";
  if (ks.some((k) => Math.abs(kFloat - k) <= SETTLING_TOLERANCE)) return "settling";
  return null;
};
