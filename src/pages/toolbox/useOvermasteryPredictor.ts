import characterIdHashes from "@/assets/character-id-hashes.json";
import overmasteryCategories from "@/assets/overmastery-categories.json";
import { assignable } from "@/pages/toolbox/matching";
import { sanitizeRollCount } from "@/pages/toolbox/rollCount";
import { ANY } from "@/pages/toolbox/traitOptions";
import useGameStatus from "@/pages/toolbox/useGameStatus";
import useRngSlotStaleness from "@/pages/toolbox/useRngSlotStaleness";
import { DEFAULT_ROLLS, useOvermasterySelectionsStore } from "@/stores/useOvermasterySelectionsStore";
import {
  CharacterType,
  OvermasteryCharacterPrediction,
  OvermasteryMastery,
  OvermasteryPrediction,
  OvermasteryStatus,
} from "@/types";
import { toHashString, translateCharacterType, translateOvermasteryId } from "@/utils";
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
  /** Characters to predict for: 8-hex id hashes, or the single `ANY`
   * wildcard standing for the whole roster. */
  characters: string[];
  /** Overmastery level tier 0/1/2 (Lvl 1/2/3; "meditation size" in game data). */
  tier: string;
  /** One slot per possible overmastery on a roll. */
  wanted: WantedSlot[];
  /** How many future rolls to simulate. */
  rolls: number;
};

export const emptySlots = (): WantedSlot[] => Array.from({ length: 4 }, () => ({ kind: null, minLevel: null }));

export const initialForm: OvermasteryForm = {
  characters: [],
  tier: "2",
  wanted: emptySlots(),
  rolls: DEFAULT_ROLLS,
};

/** Most rolls a prediction will simulate: the game's own RNG stream is only
 * worth walking so far ahead, and each roll costs a chunk of MSP. */
export const MAX_ROLLS = 500;

/** Numeric filter for one slot; null means "Any" on that axis. */
export type WantedFilter = { kind: number | null; minLevel: number | null };

/** Slots with at least one non-Any axis -> numeric filters; fully-Any slots are ignored. */
export const activeFilters = (slots: WantedSlot[]): WantedFilter[] =>
  slots
    .filter((s) => s.kind !== null || s.minLevel !== null)
    .map((s) => ({ kind: s.kind === null ? null : parseInt(s.kind, 10), minLevel: s.minLevel }));

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
export const sortRollForDisplay = (
  roll: OvermasteryMastery[],
  filters: WantedFilter[],
  // Callers sorting many rolls under one filter set pass the set in rather
  // than rebuilding it per roll.
  wanted: Set<number> = wantedKindSet(filters)
): OvermasteryMastery[] => {
  return [...roll].sort((a, b) => {
    const aWanted = wanted.has(a.kind) ? 0 : 1;
    const bWanted = wanted.has(b.kind) ? 0 : 1;
    return aWanted - bWanted || b.level - a.level;
  });
};

/** One roll of a prediction, carrying the roll number it was found at so the
 * table can price it even after the non-matching rolls are dropped. */
export type IndexedRoll = { roll: OvermasteryMastery[]; index: number };

/** One character's rolls, split into the two tables the results show: rolls
 * that meet every filter outright, and rolls that hold the wanted traits but
 * not at the levels asked for. Rolls matching neither are dropped.
 *
 * One pass over the rolls: `rollMatches` is a backtracking search, so it runs
 * once per roll and only the rolls that survive get sorted. Empty filters
 * accept every roll, so `fullMatches` is all of them and `belowLevel` none.
 */
export const splitRollMatches = (
  rolls: OvermasteryMastery[][],
  filters: WantedFilter[],
  wanted: Set<number> = wantedKindSet(filters)
): { fullMatches: IndexedRoll[]; belowLevel: IndexedRoll[] } => {
  const fullMatches: IndexedRoll[] = [];
  const belowLevel: IndexedRoll[] = [];
  rolls.forEach((roll, index) => {
    if (rollMatches(roll, filters)) fullMatches.push({ roll: sortRollForDisplay(roll, filters, wanted), index });
    else if (rollMatchesKinds(roll, filters))
      belowLevel.push({ roll: sortRollForDisplay(roll, filters, wanted), index });
  });
  return { fullMatches, belowLevel };
};

/** Options for slot `index`: a trait can only roll as often as it exists in
 * the tier's pool (`count`, default 1 — only the tier-0 pool has duplicates:
 * ATK x5, HP x5, Crit x3, Stun x3),
 * so it is hidden once that many other slots picked it. */
export const slotOptions = (
  options: { value: string; label: string; count?: number }[],
  slots: WantedSlot[],
  index: number
) => {
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

/** This tool's roll-count guard — see `sanitizeRollCount`. */
export const sanitizeRolls = (value: unknown): number => sanitizeRollCount(value, MAX_ROLLS, DEFAULT_ROLLS);

/** Startup form: restore the last-worked-on character selection and its saved
 * goal, plus the account-wide roll count (falling back to defaults for
 * whatever is missing/invalid).
 *
 * The goal is shared across a selection and saved under every entry in it, so
 * the first entry is as good a source as any — and is the one the picker's
 * pills lead with. `Any` keys its own entry: reading the whole roster at once
 * is its own workspace, with a roster-wide goal that is nobody's in
 * particular. Its sentinel is not 8 hex digits, so it cannot collide with a
 * character hash.
 */
export const restoreForm = (
  lastCharacters: unknown,
  selections: Record<string, unknown>,
  rolls?: unknown
): OvermasteryForm => {
  const base = { ...initialForm, rolls: sanitizeRolls(rolls) };
  if (!Array.isArray(lastCharacters)) return base;
  const characters = lastCharacters.filter((c): c is string => typeof c === "string");
  if (characters.length === 0) return base;
  const saved = sanitizeSelection(selections[characters[0]]);
  return saved ? { ...base, characters, tier: saved.tier, wanted: saved.wanted } : { ...base, characters };
};

/**
 * The character picker's selection after a change, keeping `Any` exclusive:
 * it stands for "the whole roster", so it is meaningless beside a named pick.
 * Adding it clears the named picks; naming someone while it is on drops it.
 */
export const normalizeCharacterSelection = (previous: string[], next: string[]): string[] => {
  if (!next.includes(ANY)) return next;
  return previous.includes(ANY) ? next.filter((c) => c !== ANY) : [ANY];
};

/** The characters a selection actually predicts for: `Any` expands to the
 * whole roster, and named picks the roster no longer offers are dropped — a
 * remembered selection outlives the save it was made on. */
export const effectiveCharacters = (selection: string[], options: CharacterOption[]): string[] => {
  const offered = new Set(options.map((o) => o.value));
  return selection.includes(ANY) ? options.map((o) => o.value) : selection.filter((c) => offered.has(c));
};

export type CharacterOption = { value: string; label: string };

/** Roster hashes -> select options. The protagonist entry is always offered
 * first (either protagonist id maps to roster index 0); hashes the baked map
 * doesn't know (future characters) are dropped rather than shown raw. */
export const buildCharacterOptions = (roster: number[], translate: (plCode: string) => string): CharacterOption[] => {
  // No roster read at all (game not running, or the status call failed):
  // offer nothing rather than a protagonist we can't predict for. Keyed on
  // the raw roster, not on how many entries survived the filter below — a
  // roster of only-unrecognised hashes (characters added by a game patch)
  // still means the protagonist is selectable.
  if (roster.length === 0) return [];

  const options: CharacterOption[] = [{ value: PROTAGONIST_HEX, label: translate(CHARACTER_BY_HASH[PROTAGONIST_HEX]) }];
  for (const id of roster) {
    const hex = toHashString(id);
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
  // `i18n.language` only — labels go through the shared translate helpers,
  // which read the module-level i18n instance.
  const { i18n } = useTranslation();
  const [form, setForm] = useState<OvermasteryForm>(() => {
    const { lastCharacters, selections, rolls } = useOvermasterySelectionsStore.getState();
    return restoreForm(lastCharacters, selections, rolls);
  });
  // The character picker is built from `status.roster`, so a status read
  // taken before the game was up would leave the tool unusable — the shared
  // hook re-reads on visibility so the roster and banner recover on their own.
  const { status, error, setError, loading } = useGameStatus<OvermasteryStatus>("fetch_overmastery_status");
  const [results, setResults] = useState<OvermasteryCharacterPrediction[]>([]);
  const [predicting, setPredicting] = useState(false);
  const selections = useOvermasterySelectionsStore((s) => s.selections);
  const saveSelection = useOvermasterySelectionsStore((s) => s.save);
  const saveLastCharacters = useOvermasterySelectionsStore((s) => s.setLastCharacters);
  const saveRolls = useOvermasterySelectionsStore((s) => s.setRolls);

  // One watch over every predicted stream: the results are one batch off one
  // RNG snapshot, so any of their slots moving makes all of them stale.
  const watched = useMemo(
    () => results.map((r) => r.prediction).filter((p): p is OvermasteryPrediction => p !== null),
    [results]
  );
  const [stale, setStale] = useRngSlotStaleness(watched);

  /** Changing the picker drops the previous results. Narrowing to a single
   * pick — one character, or `Any` for the whole roster — also restores that
   * pick's saved tier + wanted slots (empty slots when nothing usable is
   * stored); with several picked the goal is shared, so there is no one saved
   * goal to restore and the current one carries over. */
  const selectCharacters = (picked: string[]) => {
    setResults([]);
    setError(null);
    setStale(false);
    setForm((f) => {
      const characters = normalizeCharacterSelection(f.characters, picked);
      if (characters.length !== 1) return { ...f, characters };
      const saved = sanitizeSelection(selections[characters[0]]);
      return saved
        ? { ...f, characters, tier: saved.tier, wanted: saved.wanted }
        : { ...f, characters, wanted: emptySlots() };
    });
  };

  // The goal is shared across the selection, so it is saved under every entry
  // in it: whichever of them is picked alone next restores it. `Any` keys its
  // own entry rather than writing through to the whole roster — reading
  // everyone at once must not overwrite what each character saved for
  // themselves.
  useEffect(() => {
    for (const character of form.characters) {
      saveSelection(character, { tier: form.tier, wanted: form.wanted });
    }
  }, [form.characters, form.tier, form.wanted, saveSelection]);

  useEffect(() => {
    saveLastCharacters(form.characters);
  }, [form.characters, saveLastCharacters]);

  // A cleared field reads as 0 and is not a count the user chose; keep the
  // stored one until they type a real number again.
  useEffect(() => {
    if (form.rolls >= 1) saveRolls(form.rolls);
  }, [form.rolls, saveRolls]);

  const characterOptions = useMemo(
    () => buildCharacterOptions(status?.roster ?? [], (plCode) => translateCharacterType(plCode as CharacterType)),
    [status, i18n.language]
  );

  const categoryOptions = useMemo(
    () =>
      (CATEGORIES[form.tier] ?? []).map((c) => ({
        value: String(c.kind),
        label: translateOvermasteryId(parseInt(c.key, 16)),
        count: c.count,
      })),
    [form.tier, i18n.language]
  );

  /** Who a Predict would actually run for — the picker's selection resolved
   * against this save's roster. */
  const characters = useMemo(
    () => effectiveCharacters(form.characters, characterOptions),
    [form.characters, characterOptions]
  );

  // The whole batch comes back off one RNG snapshot, so the per-character
  // tabs can never disagree about the state they were simulated from.
  const predict = async () => {
    if (characters.length === 0) return;
    setPredicting(true);
    setError(null);
    setStale(false);
    try {
      setResults(
        await invoke<OvermasteryCharacterPrediction[]>("predict_overmastery", {
          query: {
            charIds: characters.map((c) => parseInt(c, 16)),
            tier: parseInt(form.tier, 10),
            rolls: form.rolls,
          },
        })
      );
    } catch (e) {
      setResults([]);
      setError(String(e));
    } finally {
      setPredicting(false);
    }
  };

  const filters = useMemo(() => activeFilters(form.wanted), [form.wanted]);

  return {
    form,
    setForm,
    selectCharacters,
    characters,
    status,
    results,
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
