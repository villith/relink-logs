import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OvermasteryMastery, OvermasteryStatus } from "@/types";

vi.mock("@tauri-apps/api", () => ({ invoke: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === "string" ? fallback : key),
    i18n: { language: "en" },
  }),
}));

import { invoke } from "@tauri-apps/api";

import useOvermasteryPredictor, {
  activeFilters,
  buildCharacterOptions,
  initialForm,
  restoreForm,
  rollMatches,
  rollMatchesKinds,
  sanitizeSelection,
  slotOptions,
  sortRollForDisplay,
  wantedKindSet,
  WantedSlot,
} from "./useOvermasteryPredictor";

const mastery = (kind: number, level: number): OvermasteryMastery => ({
  category: 0x1000 + kind,
  level,
  kind,
  value: level * 10,
});

const slot = (kind: string | null, minLevel: number | null = null): WantedSlot => ({ kind, minLevel });

const invokeMock = vi.mocked(invoke);

describe("useOvermasteryPredictor loading", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("is loading until the game status fetch resolves", async () => {
    let resolveStatus!: (s: OvermasteryStatus) => void;
    invokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        })
    );
    const { result } = renderHook(() => useOvermasteryPredictor());
    expect(result.current.loading).toBe(true);
    await act(async () => resolveStatus({ gameRunning: true, roster: [] }));
    expect(result.current.loading).toBe(false);
    expect(result.current.status?.gameRunning).toBe(true);
  });

  it("stops loading when the status fetch fails", async () => {
    invokeMock.mockRejectedValue("game-not-running");
    const { result } = renderHook(() => useOvermasteryPredictor());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("game-not-running");
  });
});

describe("activeFilters", () => {
  it("keeps slots with a trait, a level, or both; drops fully-Any slots", () => {
    const slots = [slot("0", 8), slot(null, 5), slot("100"), slot(null)];
    expect(activeFilters(slots)).toEqual([
      { kind: 0, minLevel: 8 },
      { kind: null, minLevel: 5 },
      { kind: 100, minLevel: null },
    ]);
  });
});

describe("rollMatches", () => {
  it("requires every wanted effect at or above its own minimum level", () => {
    const roll = [mastery(0, 8), mastery(1, 5), mastery(2, 10), mastery(100, 3)];
    expect(rollMatches(roll, [{ kind: 0, minLevel: 1 }])).toBe(true);
    expect(
      rollMatches(roll, [
        { kind: 0, minLevel: 8 },
        { kind: 1, minLevel: 5 },
      ])
    ).toBe(true);
    // per-slot levels: ATK needs 8 (ok) but HP needs 8 (only rolled 5)
    expect(
      rollMatches(roll, [
        { kind: 0, minLevel: 8 },
        { kind: 1, minLevel: 8 },
      ])
    ).toBe(false);
    expect(rollMatches(roll, [{ kind: 3, minLevel: 1 }])).toBe(false); // BREAK not present
  });

  it("matches any roll when nothing is wanted", () => {
    expect(rollMatches([mastery(0, 1)], [])).toBe(true);
  });

  it("an Any-level filter only needs the trait present", () => {
    expect(rollMatches([mastery(0, 1)], [{ kind: 0, minLevel: null }])).toBe(true);
  });

  it("an Any-trait filter matches any effect at or above the level", () => {
    const roll = [mastery(0, 3), mastery(1, 9)];
    expect(rollMatches(roll, [{ kind: null, minLevel: 9 }])).toBe(true);
    expect(rollMatches(roll, [{ kind: null, minLevel: 10 }])).toBe(false);
  });

  it("each filter must be satisfied by a distinct rolled effect", () => {
    // One HP 9 can't satisfy two "Any >= 9" slots...
    const roll = [mastery(0, 3), mastery(1, 9)];
    const twoNines = [
      { kind: null, minLevel: 9 },
      { kind: null, minLevel: 9 },
    ];
    expect(rollMatches(roll, twoNines)).toBe(false);
    // ...and the ATK 8 that satisfies "ATK >= 8" can't double as "Any >= 8".
    expect(
      rollMatches(
        [mastery(0, 8), mastery(1, 5)],
        [
          { kind: 0, minLevel: 8 },
          { kind: null, minLevel: 8 },
        ]
      )
    ).toBe(false);
    expect(
      rollMatches(
        [mastery(0, 8), mastery(1, 8)],
        [
          { kind: 0, minLevel: 8 },
          { kind: null, minLevel: 8 },
        ]
      )
    ).toBe(true);
  });

  it("a duplicated effect matches on its best level", () => {
    // The small pool can roll the same effect twice at different levels.
    const roll = [mastery(0, 3), mastery(0, 9)];
    expect(rollMatches(roll, [{ kind: 0, minLevel: 9 }])).toBe(true);
  });

  it("ignores the order of both the roll and the wanted slots", () => {
    const roll = [mastery(2, 10), mastery(0, 8), mastery(1, 5)];
    const filters = [
      { kind: 1, minLevel: 5 },
      { kind: 0, minLevel: 8 },
    ];
    expect(rollMatches(roll, filters)).toBe(true);
    expect(rollMatches(roll, [...filters].reverse())).toBe(true);
    // greedy pitfall: the wildcard must not grab ATK 9 before the ATK filter needs it
    const tricky = [mastery(0, 9), mastery(1, 2)];
    expect(
      rollMatches(tricky, [
        { kind: null, minLevel: 1 },
        { kind: 0, minLevel: 9 },
      ])
    ).toBe(true);
  });
});

describe("slotOptions", () => {
  // Counts mirror the tier-1 pool: some stats exist multiple times and can
  // roll (and so be wanted) more than once.
  const atk = { value: "0", label: "ATK", count: 5 };
  const hp = { value: "1", label: "HP", count: 5 };
  const crit = { value: "2", label: "Crit", count: 2 };
  const skillDmg = { value: "100", label: "Skill DMG", count: 1 };
  const options = [atk, hp, crit, skillDmg];

  it("hides single-copy traits picked in other slots but keeps the slot's own pick", () => {
    const slots: WantedSlot[] = [slot("100"), slot(null), slot(null), slot(null)];
    expect(slotOptions(options, slots, 0)).toEqual(options);
    expect(slotOptions(options, slots, 1)).toEqual([atk, hp, crit]);
  });

  it("offers multi-copy traits until their pool count is used up", () => {
    const slots: WantedSlot[] = [slot("2"), slot("2"), slot(null), slot(null)];
    // Crit exists twice in the pool: both picks are legal, a third is not.
    expect(slotOptions(options, slots, 1)).toEqual(options);
    expect(slotOptions(options, slots, 2)).toEqual([atk, hp, skillDmg]);
  });

  it("treats options without a count as single-copy", () => {
    const bare = [
      { value: "0", label: "ATK" },
      { value: "1", label: "HP" },
    ];
    const slots: WantedSlot[] = [slot("0"), slot(null), slot(null), slot(null)];
    expect(slotOptions(bare, slots, 1)).toEqual([{ value: "1", label: "HP" }]);
  });

  it("offers everything when no other slot has a pick", () => {
    const slots: WantedSlot[] = [slot(null), slot(null), slot(null), slot(null)];
    expect(slotOptions(options, slots, 1)).toEqual(options);
  });
});

describe("rollMatchesKinds", () => {
  it("requires every wanted effect to be present, ignoring levels", () => {
    const roll = [mastery(0, 2), mastery(1, 1)];
    expect(
      rollMatchesKinds(roll, [
        { kind: 0, minLevel: 10 },
        { kind: 1, minLevel: 10 },
      ])
    ).toBe(true);
    expect(rollMatchesKinds(roll, [{ kind: 3, minLevel: 1 }])).toBe(false);
  });

  it("Any-trait filters count against distinct effects, levels ignored", () => {
    const roll = [mastery(0, 1), mastery(1, 1)];
    const anyTen = { kind: null, minLevel: 10 };
    expect(rollMatchesKinds(roll, [anyTen, anyTen])).toBe(true);
    expect(rollMatchesKinds(roll, [anyTen, anyTen, anyTen])).toBe(false); // only 2 effects rolled
  });
});

describe("sanitizeSelection", () => {
  // Minimal stand-in for the baked categories: tier "0" allows ATK twice,
  // tier "2" is all single-copy.
  const cats = {
    "0": [
      { kind: 0, key: "a", count: 2 },
      { kind: 100, key: "b", count: 1 },
    ],
    "2": [
      { kind: 0, key: "a", count: 1 },
      { kind: 100, key: "b", count: 1 },
    ],
  };

  it("passes a valid saved selection through unchanged", () => {
    const entry = {
      tier: "2",
      wanted: [slot("0", 5), slot(null), slot(null, 9), slot("100")],
    };
    expect(sanitizeSelection(entry, cats)).toEqual(entry);
  });

  it("rejects non-objects, unknown tiers, and non-array slot lists", () => {
    expect(sanitizeSelection(null, cats)).toBeNull();
    expect(sanitizeSelection("x", cats)).toBeNull();
    expect(sanitizeSelection({ tier: "9", wanted: [] }, cats)).toBeNull();
    expect(sanitizeSelection({ tier: "2", wanted: "x" }, cats)).toBeNull();
  });

  it("nulls kinds the tier's pool doesn't offer", () => {
    const entry = { tier: "2", wanted: [slot("999", 5), slot("0"), slot(null), slot(null)] };
    expect(sanitizeSelection(entry, cats)).toEqual({
      tier: "2",
      wanted: [slot(null, 5), slot("0"), slot(null), slot(null)],
    });
  });

  it("enforces the per-kind pool count", () => {
    const twice = { tier: "0", wanted: [slot("0", 1), slot("0", 2), slot("0", 3), slot(null)] };
    // ATK exists twice on tier 0: first two picks survive, the third is nulled.
    expect(sanitizeSelection(twice, cats)?.wanted).toEqual([slot("0", 1), slot("0", 2), slot(null, 3), slot(null)]);
    const dupOnSingle = { tier: "2", wanted: [slot("0"), slot("0"), slot(null), slot(null)] };
    expect(sanitizeSelection(dupOnSingle, cats)?.wanted).toEqual([slot("0"), slot(null), slot(null), slot(null)]);
  });

  it("nulls out-of-range or non-integer levels and normalizes to 4 slots", () => {
    const messy = {
      tier: "2",
      wanted: [
        { kind: "0", minLevel: 0 },
        { kind: null, minLevel: 11 },
        { kind: null, minLevel: 2.5 },
      ],
    };
    expect(sanitizeSelection(messy, cats)).toEqual({
      tier: "2",
      wanted: [slot("0"), slot(null), slot(null), slot(null)],
    });
    const long = { tier: "2", wanted: [slot("0", 10), slot(null), slot(null), slot(null), slot("100", 1)] };
    expect(sanitizeSelection(long, cats)?.wanted).toEqual([slot("0", 10), slot(null), slot(null), slot(null)]);
  });
});

describe("sortRollForDisplay", () => {
  it("puts wanted effects first, each group sorted by level descending", () => {
    const roll = [mastery(2, 5), mastery(0, 3), mastery(1, 9), mastery(3, 7)];
    const filters = [
      { kind: 1, minLevel: null },
      { kind: 0, minLevel: 5 },
    ];
    expect(sortRollForDisplay(roll, filters)).toEqual([mastery(1, 9), mastery(0, 3), mastery(3, 7), mastery(2, 5)]);
  });

  it("sorts purely by level when no specific trait is wanted", () => {
    const roll = [mastery(0, 2), mastery(1, 8)];
    expect(sortRollForDisplay(roll, [])).toEqual([mastery(1, 8), mastery(0, 2)]);
    // An Any-trait filter names no kind, so nothing is pinned to the top.
    expect(sortRollForDisplay(roll, [{ kind: null, minLevel: 9 }])).toEqual([mastery(1, 8), mastery(0, 2)]);
  });
});

describe("wantedKindSet", () => {
  it("collects the specifically wanted kinds, ignoring Any-trait filters", () => {
    const filters = [
      { kind: 1, minLevel: null },
      { kind: null, minLevel: 9 },
      { kind: 100, minLevel: 5 },
    ];
    expect(wantedKindSet(filters)).toEqual(new Set([1, 100]));
  });
});

describe("restoreForm", () => {
  it("restores the last character's saved tier and slots on startup", () => {
    const saved = { tier: "0", wanted: [slot("0", 8), slot(null), slot(null), slot(null)] };
    expect(restoreForm("18e2f9f9", { "18e2f9f9": saved })).toEqual({
      ...initialForm,
      character: "18e2f9f9",
      tier: "0",
      wanted: saved.wanted,
    });
  });

  it("keeps the character but defaults the rest when their entry is missing or invalid", () => {
    expect(restoreForm("18e2f9f9", {})).toEqual({ ...initialForm, character: "18e2f9f9" });
    expect(restoreForm("18e2f9f9", { "18e2f9f9": { tier: "bogus", wanted: [] } })).toEqual({
      ...initialForm,
      character: "18e2f9f9",
    });
  });

  it("returns the plain initial form when no character was remembered", () => {
    expect(restoreForm(null, {})).toEqual(initialForm);
  });
});

describe("buildCharacterOptions", () => {
  it("maps known roster hashes to labelled options, protagonist first, and drops unknowns", () => {
    // 18e2f9f9 = PL0200 (Katalina), 079df0cc = PL0300 (Rackam) per the baked map.
    const roster = [0x18e2f9f9, 0x079df0cc, 0xdeadbeef];
    const options = buildCharacterOptions(roster, (pl) => `name:${pl}`);
    expect(options[0]).toEqual({ value: "2a26b1b2", label: "name:Pl0000" });
    expect(options).toContainEqual({ value: "18e2f9f9", label: "name:Pl0200" });
    expect(options).toContainEqual({ value: "079df0cc", label: "name:Pl0300" });
    expect(options.some((o) => o.value === "deadbeef")).toBe(false);
  });
});
