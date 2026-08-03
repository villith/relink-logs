import pool from "@/assets/transmarvel-pool.json";
import useGameStatus from "@/pages/toolbox/useGameStatus";
import useRngSlotStaleness from "@/pages/toolbox/useRngSlotStaleness";
import { DEFAULT_ROLLS, useTransmarvelWishlistStore } from "@/stores/useTransmarvelWishlistStore";
import type { TransmarvelOutcome, TransmarvelPrediction, TransmarvelRoll, TransmarvelStatus } from "@/types";
import { invoke } from "@tauri-apps/api";
import { useEffect, useMemo, useRef, useState } from "react";

/** A wished-for sigil: the sigil (by its trait1) plus an optional 2nd trait.
 * `trait2: null` means any 2nd trait is fine. Matching is by trait content —
 * a hit needs the rolled trait1 to match and, when specified, the rolled
 * trait2 too. */
export type SigilEntry = { trait: string; trait2: string | null };

/** Most rolls one prediction may simulate (mirrored by the backend clamp in
 * predict_transmarvel). */
export const MAX_ROLLS = 50000;

/** Validate a stored roll count. The field itself only ever stores 1..MAX, so
 * anything else came from a hand-edited settings.db or a lowered MAX; the
 * default is the safe answer. 0 is what the input holds while the user has
 * cleared it, and is never persisted — treat it as absent here too, or the
 * tool reopens with an empty field, a disabled Predict, and no auto-run. */
export const sanitizeRolls = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_ROLLS ? value : DEFAULT_ROLLS;

/** A wished-for wrightstone: the type (family = its fixed trait-1 hash), a
 * minimum rarity tier (that tier or better hits), and optional per-position
 * 2nd/3rd traits (`null` = any; position matters — levels are determined by
 * rarity + position, so there is nothing else to specify). */
export type WrightstoneEntry = { family: string; minTier: number; slot2: string | null; slot3: string | null };

/** The shape of the generated pool asset (src/assets/transmarvel-pool.json) —
 * an explicit interface rather than `typeof pool` so test doubles built to
 * the same shape type-check without fighting JSON's inferred literal types. */
export interface TransmarvelPool {
  /** `fixedPairs` are the items that ship both traits fixed — the sigil the
   * game names in its own right ("Rose's Awakening+"), carrying its own item
   * hash so the picker can offer it by name. */
  sigils: {
    trait: string;
    sigilId: string;
    trait2Lot: string;
    fixedPairs: { trait2: string; sigilId: string }[];
  }[];
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

/** Valid 2nd traits for a sigil: its rolled lot plus the traits its
 * fixed-pair items ship (a pair can repeat a lot trait, hence the dedupe). */
export const sigilTrait2Options = (trait: string, p: TransmarvelPool = POOL): string[] => {
  const sigil = p.sigils.find((s) => s.trait === trait);
  if (!sigil) return [];
  return [...new Set([...(p.trait2Lots[sigil.trait2Lot] ?? []), ...sigil.fixedPairs.map((f) => f.trait2)])];
};

/** Sigil-picker option values: a bare trait1 for a normal sigil, `t1:t2` for
 * a fixed-pair sigil (which pins the 2nd trait along with the first). */
const PAIR_SEP = ":";

export const sigilPickerValue = (trait: string, trait2: string) => `${trait}${PAIR_SEP}${trait2}`;

export const parseSigilPickerValue = (value: string): { trait: string; trait2: string | null } => {
  const [trait, trait2] = value.split(PAIR_SEP);
  return { trait, trait2: trait2 ?? null };
};

/**
 * The sigil picker's options: every rollable sigil by name, plus the
 * fixed-pair sigils that carry a name of their own. The generic pairs (e.g.
 * "Health V+" with a fixed Stamina) reuse their plain sigil's name, so
 * listing them would show the same label twice — they stay reachable by
 * picking the plain sigil and that 2nd trait, which is the same wish.
 */
export const sigilPickerOptions = (
  translate: (sigilId: string) => string,
  p: TransmarvelPool = POOL
): { value: string; label: string }[] =>
  p.sigils
    .flatMap((s) => {
      const label = translate(s.sigilId);
      return [
        { value: s.trait, label },
        ...s.fixedPairs
          .map((f) => ({ value: sigilPickerValue(s.trait, f.trait2), label: translate(f.sigilId) }))
          .filter((o) => o.label !== label),
      ];
    })
    .sort((a, b) => a.label.localeCompare(b.label));

/** Highest tier a wishlist entry can name. The fully-fixed top tier (0.1%)
 * shares tier 1's levels, and `minTier` already means "this tier or better",
 * so wishing for it is never distinct from wishing for tier 1 — the picker
 * stops here and stored entries clamp into range. */
export const MAX_WISHED_TIER = 1;

/** A family's combos in tier order (worst -> best). */
export const familyCombos = (family: string, p: TransmarvelPool = POOL) =>
  p.wrightstones.combos.filter((c) => c.family === family).sort((a, b) => a.tier - b.tier);

/** Traits a stone position (1 = 2nd slot, 2 = 3rd slot) can carry across
 * every tier at or above the minimum — at the 0.1% tier this collapses to
 * that tier's fixed trait. */
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

/** One combo row of the generated pool. */
type WrightstoneCombo = TransmarvelPool["wrightstones"]["combos"][number];

/** Pool traits/items are lowercase hex strings; rolled outcomes carry them as
 * numbers. Entries parse their keys once (below) rather than re-deriving a
 * hex string per roll. */
const hexNum = (h: string) => parseInt(h, 16);

/** Item hash -> combo, built once per pool. A stone match has to resolve a
 * roll's item to its family and tier, and a linear scan of the combo list per
 * roll is most of the cost of matching a 50,000-roll prediction. */
const comboIndexes = new WeakMap<TransmarvelPool, Map<number, WrightstoneCombo>>();

const comboIndex = (p: TransmarvelPool): Map<number, WrightstoneCombo> => {
  const cached = comboIndexes.get(p);
  if (cached) return cached;
  const index = new Map(p.wrightstones.combos.map((c) => [hexNum(c.item), c] as const));
  comboIndexes.set(p, index);
  return index;
};

const slotHit = (want: number | null, rolled: [number, number] | undefined): boolean =>
  want === null || (rolled !== undefined && rolled[0] === want);

/** A wishlist entry compiled to a predicate over a rolled outcome, with its
 * hex keys and combo lookup resolved up front so matching a roll is a handful
 * of integer compares. Levels are never checked — a stone's levels follow
 * from its item (rarity) and position. */
const compileEntry = (
  entry: SigilEntry | WrightstoneEntry,
  p: TransmarvelPool
): ((outcome: TransmarvelOutcome) => boolean) => {
  if ("trait" in entry) {
    const trait1 = hexNum(entry.trait);
    const trait2 = entry.trait2 === null ? null : hexNum(entry.trait2);
    return (outcome) =>
      outcome.type === "sigil" && outcome.trait1 === trait1 && (trait2 === null || outcome.trait2 === trait2);
  }
  const combos = comboIndex(p);
  const { family, minTier } = entry;
  const slot2 = entry.slot2 === null ? null : hexNum(entry.slot2);
  const slot3 = entry.slot3 === null ? null : hexNum(entry.slot3);
  return (outcome) => {
    if (outcome.type === "sigil") return false;
    const combo = combos.get(outcome.item);
    return (
      combo !== undefined &&
      combo.family === family &&
      combo.tier >= minTier &&
      slotHit(slot2, outcome.traits[1]) &&
      slotHit(slot3, outcome.traits[2])
    );
  };
};

/** Most hit rolls listed under one wishlist entry. A wildcard entry ("any"
 * 2nd trait / slot) can match hundreds of rolls; the rest are counted only,
 * and the Full Results tab still carries every roll. */
export const MAX_ENTRY_HITS = 10;

/** One entry's hits: the first `MAX_ENTRY_HITS` roll indices (0-based) that
 * entry ALONE matches, plus how many it matches overall. */
export type EntryHits = { indices: number[]; total: number };

export type MatchedRoll = { roll: TransmarvelRoll; index: number; hit: boolean };

/**
 * Everything the page reads off one prediction, in a single pass over the
 * rolls: each roll's hit flag (OR across both wishlists — "things I'd be
 * happy to get") and, per wishlist entry in wishlist order, the rolls that
 * entry ALONE matches.
 *
 * One fused pass rather than a pass per entry: this re-runs on every wishlist
 * edit, and at the 50,000-roll ceiling a pass-per-entry walk costs ~90ms of
 * blocked UI per keystroke.
 */
export const matchRolls = (
  rolls: TransmarvelRoll[],
  sigils: SigilEntry[],
  stones: WrightstoneEntry[],
  p: TransmarvelPool = POOL
): { results: MatchedRoll[]; hasHits: boolean; sigilHits: EntryHits[]; stoneHits: EntryHits[] } => {
  const matchers = [...sigils, ...stones].map((entry) => compileEntry(entry, p));
  const hits: EntryHits[] = matchers.map(() => ({ indices: [], total: 0 }));
  let hasHits = false;
  const results = rolls.map((roll, index) => {
    let hit = false;
    matchers.forEach((matches, entry) => {
      if (!matches(roll.outcome)) return;
      hit = true;
      const entryHits = hits[entry];
      entryHits.total += 1;
      if (entryHits.indices.length < MAX_ENTRY_HITS) entryHits.indices.push(index);
    });
    hasHits ||= hit;
    return { roll, index, hit };
  });
  return {
    results,
    hasHits,
    sigilHits: hits.slice(0, sigils.length),
    stoneHits: hits.slice(sigils.length),
  };
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
      const { family, minTier: rawMinTier, slot2: rawSlot2, slot3: rawSlot3 } = raw as Record<string, unknown>;
      if (typeof family !== "string" || typeof rawMinTier !== "number" || !Number.isInteger(rawMinTier)) continue;
      if (!familyCombos(family, p).some((c) => c.tier === rawMinTier)) continue;
      const minTier = Math.min(rawMinTier, MAX_WISHED_TIER);
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
 * State + handlers for the Transmarvel Wishlist: persistent wishlists, live
 * game status, prediction fetch, and staleness. Wishlist matching stays
 * client-side so edits re-highlight without re-invoking the backend.
 */
export default function useTransmarvelSearcher() {
  const { status, error, setError, loading } = useGameStatus<TransmarvelStatus>("fetch_transmarvel_status");
  const [prediction, setPrediction] = useState<TransmarvelPrediction | null>(null);
  const [predicting, setPredicting] = useState(false);
  const [matchesOnly, setMatchesOnly] = useState(false);

  const rawSigils = useTransmarvelWishlistStore((s) => s.sigils);
  const rawStones = useTransmarvelWishlistStore((s) => s.stones);
  const setSigils = useTransmarvelWishlistStore((s) => s.setSigils);
  const setStones = useTransmarvelWishlistStore((s) => s.setStones);
  const saveRolls = useTransmarvelWishlistStore((s) => s.setRolls);

  // The roll count is edited, not picked: it passes through 0 whenever the
  // user clears the field, which is an editing state and not a count anyone
  // chose. So the field's value lives here and only valid counts reach the
  // store, where the wishlists' own writes go straight through.
  const [rolls, setRolls] = useState(() => sanitizeRolls(useTransmarvelWishlistStore.getState().rolls));

  useEffect(() => {
    if (rolls >= 1) saveRolls(rolls);
  }, [rolls, saveRolls]);

  // Stored entries can predate a game patch; validate on read, like
  // overmastery's sanitizeSelection. Writes go through the setters unchanged
  // (the pickers only offer valid values).
  const { sigils, stones } = useMemo(
    () => sanitizeWishlists({ sigils: rawSigils, stones: rawStones }),
    [rawSigils, rawStones]
  );

  const [stale, setStale] = useRngSlotStaleness(prediction);

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

  /** One automatic prediction per mount, as soon as the status confirms the
   * game is running with predictable RNG — the wishlist badges appear with
   * zero clicks. Focus-driven status re-reads never re-fire it. */
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || prediction !== null || rolls < 1) return;
    if (!status?.gameRunning || status.rngUnpredictable) return;
    autoRan.current = true;
    void predict();
  }, [status]); // deliberately status-only: fires on status arrival, not on edits

  /** Roll list with hit flags plus each entry's own hits; the page renders
   * these directly. */
  const { results, hasHits, sigilHits, stoneHits } = useMemo(
    () => matchRolls(prediction?.rolls ?? [], sigils, stones),
    [prediction, sigils, stones]
  );

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
    hasHits,
    sigilHits,
    stoneHits,
    predict,
  };
}
