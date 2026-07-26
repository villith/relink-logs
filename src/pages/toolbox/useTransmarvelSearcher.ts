import pool from "@/assets/transmarvel-pool.json";
import { assignable } from "@/pages/toolbox/matching";
import useGameStatus from "@/pages/toolbox/useGameStatus";
import useStalenessWatch from "@/pages/toolbox/useStalenessWatch";
import { useTransmarvelWishlistStore } from "@/stores/useTransmarvelWishlistStore";
import type { TransmarvelPrediction, TransmarvelRoll, TransmarvelStatus } from "@/types";
import { toHashString } from "@/utils";
import { invoke } from "@tauri-apps/api";
import { useMemo, useState } from "react";

/** A wished-for sigil, by trait only (any sigil rolling that trait, any
 * level). The wishlist means "traits I'd be happy to get": matching keys on
 * the sigil's trait1 OR its rolled trait2 — a gem carrying the wished trait
 * as its 2nd trait counts as a hit too. */
export type SigilEntry = { trait: string };

/** One position a wished-for wrightstone entry needs filled. */
export type WrightstoneSlot = { trait: string; minLevel: number };

/** A wished-for wrightstone: every slot must land on its own distinct rolled
 * position (see `stoneEntryMatches`/`comboSatisfies`). */
export type WrightstoneEntry = { slots: WrightstoneSlot[] };

/** The shape of the generated pool asset (src/assets/transmarvel-pool.json) —
 * an explicit interface rather than `typeof pool` so test doubles built to
 * the same shape type-check without fighting JSON's inferred literal types. */
export interface TransmarvelPool {
  sigils: { trait: string; sigilId: string }[];
  wrightstones: {
    levels: number[];
    combos: { slots: { traits: string[]; levels: number[] }[] }[];
  };
}

export const POOL = pool as TransmarvelPool;

/** Max slots a wishlist entry may specify — a gacha stone never has more than
 * three trait positions. */
const MAX_STONE_SLOTS = 3;

/** True when each entry slot is satisfied by a DISTINCT rolled trait at or
 * above its min level. `traits` are (trait hash, level) pairs off the roll. */
export const stoneEntryMatches = (traits: [number, number][], entry: WrightstoneEntry): boolean =>
  assignable(traits, entry.slots, (s, [trait, level]) => toHashString(trait) === s.trait && level >= s.minLevel);

/** OR across both lists, and for sigils OR across trait1/trait2: the
 * wishlists are "things I'd be happy to get". */
export const rollHits = (roll: TransmarvelRoll, sigils: SigilEntry[], stones: WrightstoneEntry[]): boolean => {
  if (roll.outcome.type === "sigil") {
    const trait1 = toHashString(roll.outcome.trait1);
    const trait2 = roll.outcome.trait2 !== null ? toHashString(roll.outcome.trait2) : null;
    return sigils.some((e) => e.trait === trait1 || e.trait === trait2);
  }
  const traits = roll.outcome.traits;
  return stones.some((e) => stoneEntryMatches(traits, e));
};

/** True when some valid combo offers every slot's trait (distinct positions)
 * with the slot's min level reachable. Same backtracking matcher: combo
 * positions are the items, entry slots the filters. */
export const comboSatisfies = (combo: TransmarvelPool["wrightstones"]["combos"][number], entry: WrightstoneEntry): boolean =>
  assignable(combo.slots, entry.slots, (s, pos) => pos.traits.includes(s.trait) && pos.levels.some((l) => l >= s.minLevel));

/** Validate a wishlist blob loaded from localStorage against the current pool
 * (a game patch may have regenerated the pool and invalidated stored
 * entries): keeps only entries whose shape and traits/levels are still valid,
 * silently dropping the rest — no error, no partial-fix UI, it just stops
 * offering what can no longer come up. */
export const sanitizeWishlists = (
  value: unknown,
  p: TransmarvelPool = POOL
): { sigils: SigilEntry[]; stones: WrightstoneEntry[] } => {
  if (typeof value !== "object" || value === null) return { sigils: [], stones: [] };
  const { sigils: rawSigils, stones: rawStones } = value as { sigils?: unknown; stones?: unknown };

  const knownSigilTraits = new Set(p.sigils.map((s) => s.trait));
  const seenSigilTraits = new Set<string>();
  const sigils: SigilEntry[] = [];
  if (Array.isArray(rawSigils)) {
    for (const raw of rawSigils) {
      if (typeof raw !== "object" || raw === null) continue;
      const { trait } = raw as Record<string, unknown>;
      if (typeof trait !== "string" || !knownSigilTraits.has(trait)) continue;
      if (seenSigilTraits.has(trait)) continue;
      seenSigilTraits.add(trait);
      sigils.push({ trait });
    }
  }

  const levelSet = new Set(p.wrightstones.levels);
  const knownStoneTraits = new Set(p.wrightstones.combos.flatMap((c) => c.slots.flatMap((s) => s.traits)));
  const stones: WrightstoneEntry[] = [];
  if (Array.isArray(rawStones)) {
    for (const raw of rawStones) {
      if (typeof raw !== "object" || raw === null) continue;
      const { slots: rawSlots } = raw as Record<string, unknown>;
      if (!Array.isArray(rawSlots) || rawSlots.length === 0 || rawSlots.length > MAX_STONE_SLOTS) continue;

      let valid = true;
      const slots: WrightstoneSlot[] = [];
      for (const rawSlot of rawSlots) {
        if (typeof rawSlot !== "object" || rawSlot === null) {
          valid = false;
          break;
        }
        const { trait, minLevel } = rawSlot as Record<string, unknown>;
        if (typeof trait !== "string" || !knownStoneTraits.has(trait)) {
          valid = false;
          break;
        }
        if (typeof minLevel !== "number" || !levelSet.has(minLevel)) {
          valid = false;
          break;
        }
        slots.push({ trait, minLevel });
      }
      if (!valid) continue;

      const entry: WrightstoneEntry = { slots };
      if (p.wrightstones.combos.some((c) => comboSatisfies(c, entry))) stones.push(entry);
    }
  }

  return { sigils, stones };
};

/**
 * State + handlers for the Transmarvel Searcher: persistent wishlists, live
 * game status, prediction fetch, and staleness. Wishlist matching stays
 * client-side so edits re-highlight without re-invoking the backend.
 */
export default function useTransmarvelSearcher() {
  const { status, error, setError, loading } = useGameStatus<TransmarvelStatus>("fetch_transmarvel_status");
  const [prediction, setPrediction] = useState<TransmarvelPrediction | null>(null);
  const [predicting, setPredicting] = useState(false);
  const [rolls, setRolls] = useState(50);
  const [matchesOnly, setMatchesOnly] = useState(false);

  const rawSigils = useTransmarvelWishlistStore((s) => s.sigils);
  const rawStones = useTransmarvelWishlistStore((s) => s.stones);
  const setSigils = useTransmarvelWishlistStore((s) => s.setSigils);
  const setStones = useTransmarvelWishlistStore((s) => s.setStones);

  // Stored entries can predate a game patch; validate on read, like
  // overmastery's sanitizeSelection. Writes go through the setters unchanged
  // (the pickers only offer valid values).
  const { sigils, stones } = useMemo(() => sanitizeWishlists({ sigils: rawSigils, stones: rawStones }), [rawSigils, rawStones]);

  /** While results are shown, watch the prediction's RNG slot; once the live
   * state moves off the predicted one (the user rolled, or a quest reshuffled
   * the stream), the list is stale. */
  const [stale, setStale] = useStalenessWatch(prediction && !prediction.unpredictable ? prediction : null, async (watched) => {
    const current = await invoke<number | null>("fetch_overmastery_seed", { slot: watched.slot });
    return current !== null && current !== watched.slotState;
  });

  const predict = async () => {
    setPredicting(true);
    setError(null);
    setStale(false);
    try {
      setPrediction(await invoke<TransmarvelPrediction>("predict_transmarvel", { query: { rolls } }));
    } catch (e) {
      setPrediction(null);
      setError(String(e));
    } finally {
      setPredicting(false);
    }
  };

  /** Roll list with hit flags; the page renders this directly. */
  const results = useMemo(
    () => (prediction?.rolls ?? []).map((roll, index) => ({ roll, index, hit: rollHits(roll, sigils, stones) })),
    [prediction, sigils, stones]
  );
  const firstHit = useMemo(() => results.find((r) => r.hit)?.index ?? null, [results]);

  return {
    status, error, loading, prediction, predicting, stale,
    rolls, setRolls, matchesOnly, setMatchesOnly,
    sigils, setSigils, stones, setStones,
    results, firstHit, predict,
  };
}
