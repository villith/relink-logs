import { describe, expect, it } from "vitest";

import type { TransmarvelRoll } from "@/types";

import {
  MAX_ENTRY_HITS,
  POOL,
  SigilEntry,
  TransmarvelPool,
  WrightstoneEntry,
  familyCombos,
  matchRolls,
  parseSigilPickerValue,
  sanitizeWishlists,
  sigilPickerOptions,
  sigilPickerValue,
  sigilTrait2Options,
  slotTraitOptions,
} from "./useTransmarvelSearcher";

/** Minimal pool double shaped like the real generated asset
 * (src/assets/transmarvel-pool.json): two sigil traits sharing a rolled
 * 2nd-trait lot (one with a fixed-pair extra), and one full stone family
 * ("f1") across all three tiers — rolled slots at tiers 0/1, the fixed
 * Aegis/ATK-style singletons ("ae"/"a7") at tier 2 — plus a second family
 * ("f2") for family-mismatch cases. */
const POOL_DOUBLE: TransmarvelPool = {
  sigils: [
    {
      trait: "000000aa",
      sigilId: "000001aa",
      trait2Lot: "5",
      fixedPairs: [
        // Own name ("Awakening"-style): reachable as its own picker option.
        { trait2: "000000ee", sigilId: "000009ee" },
        // Pairs a trait the rolled lot already offers.
        { trait2: "000000cc", sigilId: "000009cc" },
      ],
    },
    { trait: "000000bb", sigilId: "000001bb", trait2Lot: "5", fixedPairs: [] },
  ],
  trait2Lots: { "5": ["000000cc", "000000dd"] },
  wrightstones: {
    combos: [
      {
        item: "00000101",
        family: "000000f1",
        tier: 0,
        chancePercent: 74.9,
        slots: [
          { traits: ["000000f1"], levels: [10, 15] },
          { traits: ["000000cc", "000000dd"], levels: [7, 10] },
          { traits: ["000000cc", "000000dd"], levels: [5, 7] },
        ],
      },
      {
        item: "00000102",
        family: "000000f1",
        tier: 1,
        chancePercent: 25,
        slots: [
          { traits: ["000000f1"], levels: [20] },
          { traits: ["000000cc", "000000dd"], levels: [15] },
          { traits: ["000000cc", "000000dd"], levels: [10] },
        ],
      },
      {
        item: "00000103",
        family: "000000f1",
        tier: 2,
        chancePercent: 0.1,
        slots: [
          { traits: ["000000f1"], levels: [20] },
          { traits: ["000000ae"], levels: [15] },
          { traits: ["000000a7"], levels: [10] },
        ],
      },
      {
        item: "00000201",
        family: "000000f2",
        tier: 0,
        chancePercent: 74.9,
        slots: [
          { traits: ["000000f2"], levels: [10, 15] },
          { traits: ["000000cc"], levels: [7, 10] },
          { traits: ["000000cc"], levels: [5, 7] },
        ],
      },
    ],
  },
};

describe("sigilTrait2Options", () => {
  it("returns the rolled lot plus fixed-pair traits, without repeating an overlap", () => {
    expect(sigilTrait2Options("000000aa", POOL_DOUBLE)).toEqual(["000000cc", "000000dd", "000000ee"]);
    expect(sigilTrait2Options("000000bb", POOL_DOUBLE)).toEqual(["000000cc", "000000dd"]);
  });

  it("returns empty for an unknown trait", () => {
    expect(sigilTrait2Options("ffffffff", POOL_DOUBLE)).toEqual([]);
  });
});

describe("fixed-pair sigils", () => {
  it("encodes and parses a pair's picker value", () => {
    expect(sigilPickerValue("000000aa", "000000ee")).toBe("000000aa:000000ee");
    expect(parseSigilPickerValue("000000aa:000000ee")).toEqual({ trait: "000000aa", trait2: "000000ee" });
    expect(parseSigilPickerValue("000000aa")).toEqual({ trait: "000000aa", trait2: null });
  });

  it("offers each distinctly named pair its own option, sorted with the plain sigils by label", () => {
    // "cc"'s pair item shares the plain sigil's name, the way the generic
    // "Health V+" pairs do in the real pool; only the distinct one earns a row.
    const names: Record<string, string> = {
      "000001aa": "Attack",
      "000001bb": "Barrier",
      "000009ee": "Awakened Attack",
      "000009cc": "Attack",
    };
    expect(sigilPickerOptions((id) => names[id], POOL_DOUBLE)).toEqual([
      { value: "000000aa", label: "Attack" },
      { value: "000000aa:000000ee", label: "Awakened Attack" },
      { value: "000000bb", label: "Barrier" },
    ]);
  });
});

describe("slotTraitOptions", () => {
  it("unions a position's traits over every tier at or above the minimum", () => {
    expect(slotTraitOptions("000000f1", 0, 1, POOL_DOUBLE)).toEqual(["000000ae", "000000cc", "000000dd"]);
  });

  it("collapses to the fixed trait when the minimum is the top tier", () => {
    expect(slotTraitOptions("000000f1", 2, 1, POOL_DOUBLE)).toEqual(["000000ae"]);
    expect(slotTraitOptions("000000f1", 2, 2, POOL_DOUBLE)).toEqual(["000000a7"]);
  });
});

describe("roll matching", () => {
  const sigilRoll = (trait1: number, trait2: number | null = null): TransmarvelRoll => ({
    outcome: { type: "sigil", sigilId: 0x000001aa, traitLevel: 10, trait1, trait2 },
    draws: 5,
  });
  const stoneRoll = (item: number, traits: [number, number][]): TransmarvelRoll => ({
    outcome: { type: "wrightstone", item, traits },
    draws: 12,
  });
  // Rolled levels are deliberately nonsense: matching must never look at them.
  const f1Tier0 = (slot2 = 0x000000cc, slot3 = 0x000000dd) =>
    stoneRoll(0x00000101, [
      [0x000000f1, 99],
      [slot2, 99],
      [slot3, 99],
    ]);
  /** Does this single roll match the wishlists? (OR across both.) */
  const hits = (roll: TransmarvelRoll, sigils: SigilEntry[], stones: WrightstoneEntry[]) =>
    matchRolls([roll], sigils, stones, POOL_DOUBLE).results[0].hit;

  it("sigil entry with trait2 null hits any 2nd trait, including none", () => {
    const sigils: SigilEntry[] = [{ trait: "000000aa", trait2: null }];
    expect(hits(sigilRoll(0x000000aa), sigils, [])).toBe(true);
    expect(hits(sigilRoll(0x000000aa, 0x000000cc), sigils, [])).toBe(true);
    expect(hits(sigilRoll(0x000000bb), sigils, [])).toBe(false);
  });

  it("sigil entry with a specific trait2 hits only that exact pair", () => {
    const sigils: SigilEntry[] = [{ trait: "000000aa", trait2: "000000cc" }];
    expect(hits(sigilRoll(0x000000aa, 0x000000cc), sigils, [])).toBe(true);
    expect(hits(sigilRoll(0x000000aa, 0x000000dd), sigils, [])).toBe(false);
    expect(hits(sigilRoll(0x000000aa), sigils, [])).toBe(false);
  });

  it("a wished trait arriving only as another sigil's rolled trait2 does NOT hit", () => {
    const sigils: SigilEntry[] = [{ trait: "000000bb", trait2: null }];
    expect(hits(sigilRoll(0x000000aa, 0x000000bb), sigils, [])).toBe(false);
  });

  it("stone entry with both slots Any hits any roll of its family at or above the min tier", () => {
    const entry: WrightstoneEntry = { family: "000000f1", minTier: 0, slot2: null, slot3: null };
    expect(hits(f1Tier0(), [], [entry])).toBe(true);
  });

  it("stone entry misses a different family even with matching traits", () => {
    const entry: WrightstoneEntry = { family: "000000f2", minTier: 0, slot2: null, slot3: null };
    expect(hits(f1Tier0(), [], [entry])).toBe(false);
  });

  it("stone entry misses below its min tier and hits above it", () => {
    const entry: WrightstoneEntry = { family: "000000f1", minTier: 1, slot2: null, slot3: null };
    expect(hits(f1Tier0(), [], [entry])).toBe(false);
    const tier2Roll = stoneRoll(0x00000103, [
      [0x000000f1, 20],
      [0x000000ae, 15],
      [0x000000a7, 10],
    ]);
    expect(hits(tier2Roll, [], [entry])).toBe(true);
  });

  it("a specified slot trait must match its own rolled position, not the other slot", () => {
    const wantsSlot2 = { family: "000000f1", minTier: 0, slot2: "000000dd", slot3: null };
    // "dd" rolled at position 3, not position 2 — slot2 is unsatisfied.
    expect(hits(f1Tier0(0x000000cc, 0x000000dd), [], [wantsSlot2])).toBe(false);
    expect(hits(f1Tier0(0x000000dd, 0x000000cc), [], [wantsSlot2])).toBe(true);
    const wantsSlot3 = { family: "000000f1", minTier: 0, slot2: null, slot3: "000000cc" };
    expect(hits(f1Tier0(0x000000cc, 0x000000dd), [], [wantsSlot3])).toBe(false);
    expect(hits(f1Tier0(0x000000dd, 0x000000cc), [], [wantsSlot3])).toBe(true);
  });

  it("a stone roll whose item is not in the pool never hits", () => {
    const entry: WrightstoneEntry = { family: "000000f1", minTier: 0, slot2: null, slot3: null };
    expect(hits(stoneRoll(0xdeadbeef, [[0x000000f1, 10]]), [], [entry])).toBe(false);
  });

  it("empty wishlists hit nothing", () => {
    expect(hits(sigilRoll(0x000000aa), [], [])).toBe(false);
    expect(hits(f1Tier0(), [], [])).toBe(false);
  });
});

describe("per-entry hits", () => {
  const sigilRoll = (trait1: number, trait2: number | null = null): TransmarvelRoll => ({
    outcome: { type: "sigil", sigilId: 0x000001aa, traitLevel: 10, trait1, trait2 },
    draws: 5,
  });
  const stoneRoll = (item: number, traits: [number, number][]): TransmarvelRoll => ({
    outcome: { type: "wrightstone", item, traits },
    draws: 12,
  });
  const f1Tier0 = stoneRoll(0x00000101, [
    [0x000000f1, 10],
    [0x000000cc, 7],
    [0x000000dd, 5],
  ]);
  const rolls: TransmarvelRoll[] = [
    sigilRoll(0x000000bb), // roll 0
    f1Tier0, // roll 1
    sigilRoll(0x000000aa, 0x000000cc), // roll 2
    sigilRoll(0x000000aa, 0x000000dd), // roll 3
  ];

  it("lists every roll a sigil entry hits, with the total", () => {
    const entries: SigilEntry[] = [
      { trait: "000000aa", trait2: null }, // any 2nd trait: rolls 2 and 3
      { trait: "000000aa", trait2: "000000cc" }, // exact pair: roll 2 only
      { trait: "000000bb", trait2: null }, // roll 0
      { trait: "000000aa", trait2: "000000ee" }, // never
    ];
    expect(matchRolls(rolls, entries, [], POOL_DOUBLE).sigilHits).toEqual([
      { indices: [2, 3], total: 2 },
      { indices: [2], total: 1 },
      { indices: [0], total: 1 },
      { indices: [], total: 0 },
    ]);
  });

  it("lists each stone entry's hits independently of the other entries", () => {
    const entries: WrightstoneEntry[] = [
      { family: "000000f1", minTier: 0, slot2: null, slot3: null }, // hits roll 1
      { family: "000000f1", minTier: 1, slot2: null, slot3: null }, // rolled tier below min: never
      { family: "000000f2", minTier: 0, slot2: null, slot3: null }, // wrong family: never
    ];
    expect(matchRolls(rolls, [], entries, POOL_DOUBLE).stoneHits).toEqual([
      { indices: [1], total: 1 },
      { indices: [], total: 0 },
      { indices: [], total: 0 },
    ]);
  });

  it("caps the listed indices but still counts every hit", () => {
    const many = Array.from({ length: MAX_ENTRY_HITS + 5 }, () => f1Tier0);
    const entry: WrightstoneEntry = { family: "000000f1", minTier: 0, slot2: null, slot3: null };
    const [hits] = matchRolls(many, [], [entry], POOL_DOUBLE).stoneHits;
    expect(hits.total).toBe(MAX_ENTRY_HITS + 5);
    expect(hits.indices).toHaveLength(MAX_ENTRY_HITS);
    expect(hits.indices[0]).toBe(0);
    expect(hits.indices.at(-1)).toBe(MAX_ENTRY_HITS - 1);
  });

  it("handles empty rolls and empty wishlists", () => {
    expect(matchRolls([], [{ trait: "000000aa", trait2: null }], [], POOL_DOUBLE).sigilHits).toEqual([
      { indices: [], total: 0 },
    ]);
    expect(matchRolls(rolls, [], [], POOL_DOUBLE).sigilHits).toEqual([]);
    expect(matchRolls(rolls, [], [], POOL_DOUBLE).stoneHits).toEqual([]);
  });
});

describe("sanitizeWishlists", () => {
  it("returns empty lists for non-object/undefined input", () => {
    expect(sanitizeWishlists(undefined, POOL_DOUBLE)).toEqual({ sigils: [], stones: [] });
    expect(sanitizeWishlists(null, POOL_DOUBLE)).toEqual({ sigils: [], stones: [] });
    expect(sanitizeWishlists("nope", POOL_DOUBLE)).toEqual({ sigils: [], stones: [] });
    expect(sanitizeWishlists(42, POOL_DOUBLE)).toEqual({ sigils: [], stones: [] });
  });

  it("upgrades a legacy trait-only sigil entry to trait2: null", () => {
    const result = sanitizeWishlists({ sigils: [{ trait: "000000aa" }], stones: [] }, POOL_DOUBLE);
    expect(result.sigils).toEqual([{ trait: "000000aa", trait2: null }]);
  });

  it("keeps valid sigil pairs and drops unknown traits and invalid trait2s", () => {
    const result = sanitizeWishlists(
      {
        sigils: [
          { trait: "000000aa", trait2: "000000ee" }, // fixed-pair extra: valid
          { trait: "000000bb", trait2: "000000ee" }, // not in bb's options
          { trait: "ffffffff", trait2: null },
        ],
        stones: [],
      },
      POOL_DOUBLE
    );
    expect(result.sigils).toEqual([{ trait: "000000aa", trait2: "000000ee" }]);
  });

  it("dedupes sigil entries by (trait, trait2) but keeps same trait with different trait2", () => {
    const result = sanitizeWishlists(
      {
        sigils: [
          { trait: "000000aa", trait2: null },
          { trait: "000000aa", trait2: null },
          { trait: "000000aa", trait2: "000000cc" },
        ],
        stones: [],
      },
      POOL_DOUBLE
    );
    expect(result.sigils).toEqual([
      { trait: "000000aa", trait2: null },
      { trait: "000000aa", trait2: "000000cc" },
    ]);
  });

  it("drops sigil entries with junk shapes", () => {
    const result = sanitizeWishlists(
      {
        sigils: [null, "nope", {}, { trait: 5 }, { notTrait: "000000aa" }, { trait: "000000aa", trait2: 7 }],
        stones: [],
      },
      POOL_DOUBLE
    );
    // trait2: 7 (non-string) normalizes to null rather than dropping the entry.
    expect(result.sigils).toEqual([{ trait: "000000aa", trait2: null }]);
  });

  it("drops legacy slots-shaped stone entries", () => {
    const result = sanitizeWishlists(
      { sigils: [], stones: [{ slots: [{ trait: "000000cc", minLevel: 5 }] }] },
      POOL_DOUBLE
    );
    expect(result.stones).toEqual([]);
  });

  it("keeps a valid stone entry and normalizes missing slots to null", () => {
    const result = sanitizeWishlists(
      { sigils: [], stones: [{ family: "000000f1", minTier: 1, slot2: "000000cc" }] },
      POOL_DOUBLE
    );
    expect(result.stones).toEqual([{ family: "000000f1", minTier: 1, slot2: "000000cc", slot3: null }]);
  });

  it("drops stone entries with an unknown family or out-of-range/non-integer minTier", () => {
    const result = sanitizeWishlists(
      {
        sigils: [],
        stones: [
          { family: "ffffffff", minTier: 0, slot2: null, slot3: null },
          { family: "000000f1", minTier: 3, slot2: null, slot3: null },
          { family: "000000f1", minTier: 1.5, slot2: null, slot3: null },
          { family: "000000f1", minTier: "0", slot2: null, slot3: null },
        ],
      },
      POOL_DOUBLE
    );
    expect(result.stones).toEqual([]);
  });

  it("clamps a stored top-tier (0.1%) minTier down to 1 — the picker folds that tier into 20/15/10", () => {
    const result = sanitizeWishlists(
      {
        sigils: [],
        stones: [
          { family: "000000f1", minTier: 2, slot2: "000000cc", slot3: null },
          { family: "000000f1", minTier: 2, slot2: "000000ae", slot3: "000000a7" },
        ],
      },
      POOL_DOUBLE
    );
    // Slot picks validate against the clamped tier's widened range: "cc" is
    // rolled at tier 1, "ae"/"a7" only exist at tier 2 — all stay valid.
    expect(result.stones).toEqual([
      { family: "000000f1", minTier: 1, slot2: "000000cc", slot3: null },
      { family: "000000f1", minTier: 1, slot2: "000000ae", slot3: "000000a7" },
    ]);
  });

  it("drops stone entries whose slot trait is not offered at any tier >= minTier", () => {
    // "ee" is a sigil-only trait — never rolled on any f1 stone slot.
    const result = sanitizeWishlists(
      {
        sigils: [],
        stones: [
          { family: "000000f1", minTier: 0, slot2: "000000ee", slot3: null },
          { family: "000000f1", minTier: 0, slot2: null, slot3: "000000ee" },
        ],
      },
      POOL_DOUBLE
    );
    expect(result.stones).toEqual([]);
  });

  it("drops junk stone shapes", () => {
    const result = sanitizeWishlists(
      { sigils: [], stones: [null, "nope", {}, { family: 5, minTier: 0 }] },
      POOL_DOUBLE
    );
    expect(result.stones).toEqual([]);
  });
});

describe("real pool asset", () => {
  it("has the expected sigil shape: 121 traits, lots resolve, pairs carry their own item", () => {
    expect(POOL.sigils).toHaveLength(121);
    for (const sigil of POOL.sigils) {
      const lot = POOL.trait2Lots[sigil.trait2Lot];
      expect(lot, `sigil ${sigil.trait} lot ${sigil.trait2Lot}`).toBeDefined();
      for (const pair of sigil.fixedPairs) {
        // A pair's item is a sigil in its own right, never the plain one.
        expect(pair.sigilId, `pair ${sigil.trait}/${pair.trait2}`).not.toBe(sigil.sigilId);
        expect(pair.trait2).toMatch(/^[0-9a-f]{8}$/);
        expect(pair.sigilId).toMatch(/^[0-9a-f]{8}$/);
      }
    }
    // The fixed-pair items the game ships at this gacha tier.
    const pairs = POOL.sigils.flatMap((s) => s.fixedPairs);
    expect(pairs).toHaveLength(38);
  });

  it("has 4 stone families x 3 tiers with fixed trait-1 and top-tier fixed slots", () => {
    expect(POOL.wrightstones.combos).toHaveLength(12);
    const families = [...new Set(POOL.wrightstones.combos.map((c) => c.family))];
    expect(families).toHaveLength(4);
    for (const family of families) {
      const combos = familyCombos(family, POOL);
      expect(combos.map((c) => c.tier)).toEqual([0, 1, 2]);
      expect(combos.map((c) => c.chancePercent)).toEqual([74.9, 25, 0.1]);
      for (const combo of combos) {
        expect(combo.slots).toHaveLength(3);
        expect(combo.slots[0].traits).toEqual([family]);
      }
      // Top tier is fully fixed: singleton trait sets in every slot.
      for (const slot of combos[2].slots) expect(slot.traits).toHaveLength(1);
    }
  });
});
