import characterIdHashes from "@/assets/character-id-hashes.json";
import overmasteryCategories from "@/assets/overmastery-categories.json";
import { useOvermasterySelectionsStore } from "@/stores/useOvermasterySelectionsStore";
import { OvermasteryMastery, OvermasteryPrediction, OvermasteryStatus } from "@/types";
import { invoke } from "@tauri-apps/api";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

const CHARACTER_BY_HASH = characterIdHashes as Record<string, string>;
const CATEGORIES = overmasteryCategories as Record<string, { kind: number; key: string; count: number }[]>;

/** The protagonist's roster index is always 0, whichever of the two ids the
 * save uses; offer them as one entry keyed by Gran's id. */
const PROTAGONIST_HEX = "2a26b1b2";

/** One of the four wanted-overmastery slots in the form. */
export type WantedSlot = {
  /** Effect kind as string (select value), or null for "Any". */
  kind: string | null;
  /** Minimum level (1-10) this effect must reach, or null for "Any". */
  minLevel: number | null;
};

export type OvermasteryForm = {
  /** Character id hash as 8-hex string, or null. */
  character: string | null;
  /** Overmastery level tier 0/1/2 (Lvl 1/2/3; "meditation size" in game data). */
  tier: string;
  /** One slot per possible overmastery on a roll. */
  wanted: WantedSlot[];
  /** How many future rolls to simulate. */
  rolls: number;
};

export const emptySlots = (): WantedSlot[] => Array.from({ length: 4 }, () => ({ kind: null, minLevel: null }));

export const initialForm: OvermasteryForm = {
  character: null,
  tier: "2",
  wanted: emptySlots(),
  rolls: 50,
};

/** Numeric filter for one slot; null means "Any" on that axis. */
export type WantedFilter = { kind: number | null; minLevel: number | null };

/** Slots with at least one non-Any axis -> numeric filters; fully-Any slots are ignored. */
export const activeFilters = (slots: WantedSlot[]): WantedFilter[] =>
  slots
    .filter((s) => s.kind !== null || s.minLevel !== null)
    .map((s) => ({ kind: s.kind === null ? null : parseInt(s.kind, 10), minLevel: s.minLevel }));

/** True when each filter can be assigned its own distinct rolled effect
 * accepted by `ok` (backtracking assignment; rolls and filters are <= 4). */
const assignable = (
  roll: OvermasteryMastery[],
  filters: WantedFilter[],
  ok: (f: WantedFilter, m: OvermasteryMastery) => boolean
): boolean => {
  const used = new Array<boolean>(roll.length).fill(false);
  const assign = (fi: number): boolean => {
    if (fi === filters.length) return true;
    for (let ri = 0; ri < roll.length; ri++) {
      if (used[ri] || !ok(filters[fi], roll[ri])) continue;
      used[ri] = true;
      if (assign(fi + 1)) return true;
      used[ri] = false;
    }
    return false;
  };
  return assign(0);
};

/** True when every filter is met by a distinct rolled effect at its min level or higher. */
export const rollMatches = (roll: OvermasteryMastery[], filters: WantedFilter[]): boolean =>
  assignable(
    roll,
    filters,
    (f, m) => (f.kind === null || m.kind === f.kind) && (f.minLevel === null || m.level >= f.minLevel)
  );

/** True when every filter's trait is present (distinct effects), levels ignored. */
export const rollMatchesKinds = (roll: OvermasteryMastery[], filters: WantedFilter[]): boolean =>
  assignable(roll, filters, (f, m) => f.kind === null || m.kind === f.kind);

/** The specifically wanted kinds; Any-trait filters name none. */
export const wantedKindSet = (filters: WantedFilter[]): Set<number> =>
  new Set(filters.map((f) => f.kind).filter((k): k is number => k !== null));

/** Display order for one roll's effects: the wanted ones first, then the
 * rest, each group by level descending (matching itself is order-blind). */
export const sortRollForDisplay = (roll: OvermasteryMastery[], filters: WantedFilter[]): OvermasteryMastery[] => {
  const wanted = wantedKindSet(filters);
  return [...roll].sort((a, b) => {
    const aWanted = wanted.has(a.kind) ? 0 : 1;
    const bWanted = wanted.has(b.kind) ? 0 : 1;
    return aWanted - bWanted || b.level - a.level;
  });
};

/** Options for slot `index`: a trait can only roll as often as it exists in
 * the tier's pool (`count`, default 1 — only the tier-1 pool has duplicates),
 * so it is hidden once that many other slots picked it. */
export const slotOptions = <T extends { value: string; count?: number }>(
  options: T[],
  slots: WantedSlot[],
  index: number
): T[] => {
  const taken = new Map<string, number>();
  for (const [i, s] of slots.entries()) {
    if (i !== index && s.kind !== null) taken.set(s.kind, (taken.get(s.kind) ?? 0) + 1);
  }
  return options.filter((o) => (taken.get(o.value) ?? 0) < (o.count ?? 1));
};

/** What is persisted per character: the tier and the four wanted slots. */
export type SavedSelection = { tier: string; wanted: WantedSlot[] };

type CategoryPools = Record<string, { kind: number; count: number }[]>;

/** Validate a per-character selection loaded from localStorage. Returns null
 * when unusable; otherwise coerces to 4 slots, nulling kinds the tier's pool
 * doesn't offer (or offers fewer copies of) and out-of-range levels. */
export const sanitizeSelection = (value: unknown, categories: CategoryPools = CATEGORIES): SavedSelection | null => {
  if (typeof value !== "object" || value === null) return null;
  const { tier, wanted } = value as { tier?: unknown; wanted?: unknown };
  if (typeof tier !== "string" || !(tier in categories) || !Array.isArray(wanted)) return null;
  const pool = new Map(categories[tier].map((c) => [String(c.kind), c.count]));
  const used = new Map<string, number>();
  const slots = Array.from({ length: 4 }, (_, i): WantedSlot => {
    const raw = wanted[i];
    const s = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    let kind = typeof s.kind === "string" && pool.has(s.kind) ? s.kind : null;
    if (kind !== null) {
      const already = used.get(kind) ?? 0;
      if (already >= (pool.get(kind) ?? 1)) kind = null;
      else used.set(kind, already + 1);
    }
    const level = s.minLevel;
    const minLevel = typeof level === "number" && Number.isInteger(level) && level >= 1 && level <= 10 ? level : null;
    return { kind, minLevel };
  });
  return { tier, wanted: slots };
};

/** Startup form: restore the last-worked-on character and their saved
 * selections (falling back to defaults for whatever is missing/invalid). */
export const restoreForm = (lastCharacter: string | null, selections: Record<string, unknown>): OvermasteryForm => {
  if (!lastCharacter) return initialForm;
  const saved = sanitizeSelection(selections[lastCharacter]);
  return saved
    ? { ...initialForm, character: lastCharacter, tier: saved.tier, wanted: saved.wanted }
    : { ...initialForm, character: lastCharacter };
};

export type CharacterOption = { value: string; label: string };

/** Roster hashes -> select options. The protagonist entry is always offered
 * first (either protagonist id maps to roster index 0); hashes the baked map
 * doesn't know (future characters) are dropped rather than shown raw. */
export const buildCharacterOptions = (roster: number[], translate: (plCode: string) => string): CharacterOption[] => {
  const options: CharacterOption[] = [{ value: PROTAGONIST_HEX, label: translate(CHARACTER_BY_HASH[PROTAGONIST_HEX]) }];
  for (const id of roster) {
    const hex = id.toString(16).padStart(8, "0");
    const plCode = CHARACTER_BY_HASH[hex];
    if (!plCode || hex === PROTAGONIST_HEX || plCode === "Pl0100") continue;
    options.push({ value: hex, label: translate(plCode) });
  }
  return options;
};

/**
 * State + handlers for the Overmastery Predictor tool: character/size/goal
 * form, live game status (roster), and the simulated upcoming rolls.
 */
export default function useOvermasteryPredictor() {
  const { t, i18n } = useTranslation();
  const [form, setForm] = useState<OvermasteryForm>(() => {
    const { lastCharacter, selections } = useOvermasterySelectionsStore.getState();
    return restoreForm(lastCharacter, selections);
  });
  const [status, setStatus] = useState<OvermasteryStatus | null>(null);
  const [prediction, setPrediction] = useState<OvermasteryPrediction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [predicting, setPredicting] = useState(false);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const selections = useOvermasterySelectionsStore((s) => s.selections);
  const saveSelection = useOvermasterySelectionsStore((s) => s.save);

  /** Selecting a character restores their saved tier + wanted slots (empty
   * slots when nothing usable is stored) and drops the previous character's
   * results. */
  const selectCharacter = (character: string | null) => {
    setPrediction(null);
    setError(null);
    setStale(false);
    setForm((f) => {
      if (!character) return { ...f, character: null };
      const saved = sanitizeSelection(selections[character]);
      return saved
        ? { ...f, character, tier: saved.tier, wanted: saved.wanted }
        : { ...f, character, wanted: emptySlots() };
    });
  };

  useEffect(() => {
    if (form.character) saveSelection(form.character, { tier: form.tier, wanted: form.wanted });
  }, [form.character, form.tier, form.wanted, saveSelection]);

  useEffect(() => {
    invoke<OvermasteryStatus>("fetch_overmastery_status")
      .then(setStatus)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const characterOptions = useMemo(
    () => buildCharacterOptions(status?.roster ?? [], (plCode) => t(`characters:${plCode}`, plCode)),
    [status, i18n.language]
  );

  const categoryOptions = useMemo(
    () =>
      (CATEGORIES[form.tier] ?? []).map((c) => ({
        value: String(c.kind),
        label: t(`overmasteries:${c.key}.text`, c.key),
        count: c.count,
      })),
    [form.tier, i18n.language]
  );

  /** While results are shown, watch the prediction's RNG slot: if the live
   * state moves off the one the rolls were computed from (the character
   * rolled, or a quest reshuffled the stream), the list is stale. */
  useEffect(() => {
    if (!prediction || prediction.unpredictable || stale) return;
    let cancelled = false;
    const check = async () => {
      try {
        const current = await invoke<number | null>("fetch_overmastery_seed", { slot: prediction.slot });
        if (!cancelled && current !== null && current !== prediction.slotState) setStale(true);
      } catch {
        // Game gone or state unreadable — staleness unknowable; don't flag.
      }
    };
    const id = setInterval(check, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [prediction, stale]);

  const predict = async () => {
    if (!form.character) return;
    setPredicting(true);
    setError(null);
    setStale(false);
    try {
      setPrediction(
        await invoke<OvermasteryPrediction>("predict_overmastery", {
          query: {
            charId: parseInt(form.character, 16),
            tier: parseInt(form.tier, 10),
            rolls: form.rolls,
          },
        })
      );
    } catch (e) {
      setPrediction(null);
      setError(String(e));
    } finally {
      setPredicting(false);
    }
  };

  const filters = activeFilters(form.wanted);

  return {
    form,
    setForm,
    selectCharacter,
    status,
    prediction,
    error,
    predicting,
    stale,
    loading,
    characterOptions,
    categoryOptions,
    filters,
    predict,
  };
}
