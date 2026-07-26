import pool from "@/assets/transmarvel-pool.json";
import useGameStatus from "@/pages/toolbox/useGameStatus";
import useStalenessWatch from "@/pages/toolbox/useStalenessWatch";
import { useTransmarvelWishlistStore } from "@/stores/useTransmarvelWishlistStore";
import type { TransmarvelPrediction, TransmarvelRoll, TransmarvelStatus } from "@/types";
import { toHashString } from "@/utils";
import { invoke } from "@tauri-apps/api";
import { useMemo, useState } from "react";

/** A wished-for sigil: the sigil (by its trait1) plus an optional 2nd trait.
 * `trait2: null` means any 2nd trait is fine. Matching is by trait content —
 * a hit needs the rolled trait1 to match and, when specified, the rolled
 * trait2 too. */
export type SigilEntry = { trait: string; trait2: string | null };

/** A wished-for wrightstone: the type (family = its fixed trait-1 hash), a
 * minimum rarity tier (that tier or better hits), and optional per-position
 * 2nd/3rd traits (`null` = any; position matters — levels are determined by
 * rarity + position, so there is nothing else to specify). */
export type WrightstoneEntry = { family: string; minTier: number; slot2: string | null; slot3: string | null };

/** The shape of the generated pool asset (src/assets/transmarvel-pool.json) —
 * an explicit interface rather than `typeof pool` so test doubles built to
 * the same shape type-check without fighting JSON's inferred literal types. */
export interface TransmarvelPool {
  sigils: { trait: string; sigilId: string; trait2Lot: string; extraTrait2: string[] }[];
  trait2Lots: Record<string, string[]>;
  wrightstones: {
    combos: {
      item: string;
      family: string;
      tier: number;
      chancePercent: number;
      slots: { traits: string[]; levels: number[] }[];
    }[];
  };
}

export const POOL = pool as TransmarvelPool;

/** Valid 2nd traits for a sigil: its rolled lot plus fixed-pair extras. */
export const sigilTrait2Options = (trait: string, p: TransmarvelPool = POOL): string[] => {
  const sigil = p.sigils.find((s) => s.trait === trait);
  if (!sigil) return [];
  return [...(p.trait2Lots[sigil.trait2Lot] ?? []), ...sigil.extraTrait2];
};

/** A family's combos in tier order (worst -> best). */
export const familyCombos = (family: string, p: TransmarvelPool = POOL) =>
  p.wrightstones.combos.filter((c) => c.family === family).sort((a, b) => a.tier - b.tier);

/** Traits a stone position (1 = 2nd slot, 2 = 3rd slot) can carry across
 * every tier at or above the minimum — at min rarity 0.1% this collapses to
 * the tier's fixed trait. */
export const slotTraitOptions = (
  family: string,
  minTier: number,
  position: 1 | 2,
  p: TransmarvelPool = POOL
): string[] => {
  const traits = new Set<string>();
  for (const combo of familyCombos(family, p))
    if (combo.tier >= minTier) for (const trait of combo.slots[position].traits) traits.add(trait);
  return [...traits].sort();
};

const slotHit = (want: string | null, rolled: [number, number] | undefined): boolean =>
  want === null || (rolled !== undefined && toHashString(rolled[0]) === want);

/** OR across both wishlists ("things I'd be happy to get"); levels are never
 * checked — a stone's levels follow from its item (rarity) and position. */
export const rollHits = (
  roll: TransmarvelRoll,
  sigils: SigilEntry[],
  stones: WrightstoneEntry[],
  p: TransmarvelPool = POOL
): boolean => {
  if (roll.outcome.type === "sigil") {
    const trait1 = toHashString(roll.outcome.trait1);
    const trait2 = roll.outcome.trait2 !== null ? toHashString(roll.outcome.trait2) : null;
    return sigils.some((e) => e.trait === trait1 && (e.trait2 === null || e.trait2 === trait2));
  }
  const item = toHashString(roll.outcome.item);
  const combo = p.wrightstones.combos.find((c) => c.item === item);
  if (!combo) return false;
  const traits = roll.outcome.traits;
  return stones.some(
    (e) =>
      combo.family === e.family && combo.tier >= e.minTier && slotHit(e.slot2, traits[1]) && slotHit(e.slot3, traits[2])
  );
};

/** Validate a wishlist blob loaded from localStorage against the current pool
 * (a game patch may have regenerated the pool and invalidated stored
 * entries): keeps only entries whose shape and traits/tiers are still valid,
 * silently dropping the rest — no error, no partial-fix UI, it just stops
 * offering what can no longer come up. Legacy shapes: trait-only sigil
 * entries upgrade to "any 2nd trait"; pre-rework slots-shaped stone entries
 * are dropped. */
export const sanitizeWishlists = (
  value: unknown,
  p: TransmarvelPool = POOL
): { sigils: SigilEntry[]; stones: WrightstoneEntry[] } => {
  if (typeof value !== "object" || value === null) return { sigils: [], stones: [] };
  const { sigils: rawSigils, stones: rawStones } = value as { sigils?: unknown; stones?: unknown };

  const sigils: SigilEntry[] = [];
  const seenPairs = new Set<string>();
  if (Array.isArray(rawSigils)) {
    for (const raw of rawSigils) {
      if (typeof raw !== "object" || raw === null) continue;
      const { trait, trait2: rawTrait2 } = raw as Record<string, unknown>;
      if (typeof trait !== "string" || !p.sigils.some((s) => s.trait === trait)) continue;
      const trait2 = typeof rawTrait2 === "string" ? rawTrait2 : null;
      if (trait2 !== null && !sigilTrait2Options(trait, p).includes(trait2)) continue;
      const key = `${trait}|${trait2}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      sigils.push({ trait, trait2 });
    }
  }

  const stones: WrightstoneEntry[] = [];
  if (Array.isArray(rawStones)) {
    for (const raw of rawStones) {
      if (typeof raw !== "object" || raw === null) continue;
      const { family, minTier, slot2: rawSlot2, slot3: rawSlot3 } = raw as Record<string, unknown>;
      if (typeof family !== "string" || typeof minTier !== "number" || !Number.isInteger(minTier)) continue;
      if (!familyCombos(family, p).some((c) => c.tier === minTier)) continue;
      const slot2 = typeof rawSlot2 === "string" ? rawSlot2 : null;
      const slot3 = typeof rawSlot3 === "string" ? rawSlot3 : null;
      if (slot2 !== null && !slotTraitOptions(family, minTier, 1, p).includes(slot2)) continue;
      if (slot3 !== null && !slotTraitOptions(family, minTier, 2, p).includes(slot3)) continue;
      stones.push({ family, minTier, slot2, slot3 });
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
  const { sigils, stones } = useMemo(
    () => sanitizeWishlists({ sigils: rawSigils, stones: rawStones }),
    [rawSigils, rawStones]
  );

  /** While results are shown, watch the prediction's RNG slot; once the live
   * state moves off the predicted one (the user rolled, or a quest reshuffled
   * the stream), the list is stale. */
  const [stale, setStale] = useStalenessWatch(
    prediction && !prediction.unpredictable ? prediction : null,
    async (watched) => {
      const current = await invoke<number | null>("fetch_overmastery_seed", { slot: watched.slot });
      return current !== null && current !== watched.slotState;
    }
  );

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
    status,
    error,
    loading,
    prediction,
    predicting,
    stale,
    rolls,
    setRolls,
    matchesOnly,
    setMatchesOnly,
    sigils,
    setSigils,
    stones,
    setStones,
    results,
    firstHit,
    predict,
  };
}
