import { describe, expect, it } from "vitest";

import type { TransmarvelRoll } from "@/types";

import {
  comboSatisfies,
  rollHits,
  sanitizeWishlists,
  SigilEntry,
  stoneEntryMatches,
  TransmarvelPool,
  WrightstoneEntry,
} from "./useTransmarvelSearcher";

/** Minimal pool double shaped like the real generated asset
 * (src/assets/transmarvel-pool.json): two sigil traits, and one gacha-stone
 * combo with three slots — a fixed "aa" position, a fixed "bb" position, and
 * a fixed "cc" position that only ever rolls level 5. */
const POOL: TransmarvelPool = {
  sigils: [
    { trait: "000000aa", sigilId: "000001aa" },
    { trait: "000000bb", sigilId: "000001bb" },
  ],
  wrightstones: {
    levels: [5, 7, 10, 15, 20],
    combos: [
      {
        slots: [
          { traits: ["000000aa"], levels: [5, 7, 10] },
          { traits: ["000000bb"], levels: [5, 7] },
          { traits: ["000000cc"], levels: [5] },
        ],
      },
    ],
  },
};

describe("stoneEntryMatches", () => {
  it("hits when each slot is satisfied by a distinct rolled trait at or above its min level", () => {
    const entry: WrightstoneEntry = {
      slots: [
        { trait: "000000aa", minLevel: 7 },
        { trait: "000000bb", minLevel: 5 },
      ],
    };
    const traits: [number, number][] = [
      [0x000000aa, 10],
      [0x000000bb, 5],
    ];
    expect(stoneEntryMatches(traits, entry)).toBe(true);
  });

  it("misses when a rolled level is below the slot minimum", () => {
    const entry: WrightstoneEntry = { slots: [{ trait: "000000aa", minLevel: 10 }] };
    const traits: [number, number][] = [[0x000000aa, 7]];
    expect(stoneEntryMatches(traits, entry)).toBe(false);
  });

  it("misses when one rolled trait would have to satisfy two slots", () => {
    const entry: WrightstoneEntry = {
      slots: [
        { trait: "000000aa", minLevel: 5 },
        { trait: "000000aa", minLevel: 5 },
      ],
    };
    // The stone only rolled "aa" once, at a different position.
    const traits: [number, number][] = [
      [0x000000aa, 10],
      [0x000000bb, 5],
    ];
    expect(stoneEntryMatches(traits, entry)).toBe(false);
  });
});

describe("rollHits", () => {
  const sigilRoll = (trait1: number): TransmarvelRoll => ({
    outcome: { type: "sigil", sigilId: 0x000001aa, traitLevel: 10, trait1, trait2: null },
    draws: 5,
  });
  const stoneRoll = (traits: [number, number][]): TransmarvelRoll => ({
    outcome: { type: "wrightstone", item: 0x1234, traits },
    draws: 12,
  });

  it("sigil roll hits iff trait1 is in the sigil wishlist, any level", () => {
    const sigils: SigilEntry[] = [{ trait: "000000aa" }];
    expect(rollHits(sigilRoll(0x000000aa), sigils, [])).toBe(true);
    expect(rollHits(sigilRoll(0x000000bb), sigils, [])).toBe(false);
  });

  it("wrightstone roll hits iff ANY wishlist stone entry matches (OR across the list)", () => {
    const stones: WrightstoneEntry[] = [
      { slots: [{ trait: "000000cc", minLevel: 5 }] },
      { slots: [{ trait: "000000aa", minLevel: 5 }] },
    ];
    const roll = stoneRoll([
      [0x000000aa, 10],
      [0x000000bb, 5],
    ]);
    expect(rollHits(roll, [], stones)).toBe(true);
  });

  it("empty wishlists hit nothing", () => {
    expect(rollHits(sigilRoll(0x000000aa), [], [])).toBe(false);
    expect(
      rollHits(
        stoneRoll([
          [0x000000aa, 10],
          [0x000000bb, 5],
        ]),
        [],
        []
      )
    ).toBe(false);
  });
});

describe("comboSatisfies", () => {
  const combo = POOL.wrightstones.combos[0];

  it("true when the combo offers every slot's trait at a reachable level, distinct positions", () => {
    const entry: WrightstoneEntry = {
      slots: [
        { trait: "000000aa", minLevel: 7 },
        { trait: "000000cc", minLevel: 5 },
      ],
    };
    expect(comboSatisfies(combo, entry)).toBe(true);
  });

  it("false when the min level is unreachable at any position offering the trait", () => {
    const entry: WrightstoneEntry = { slots: [{ trait: "000000cc", minLevel: 7 }] };
    expect(comboSatisfies(combo, entry)).toBe(false);
  });
});

describe("sanitizeWishlists", () => {
  it("returns empty lists for non-object/undefined input", () => {
    expect(sanitizeWishlists(undefined, POOL)).toEqual({ sigils: [], stones: [] });
    expect(sanitizeWishlists(null, POOL)).toEqual({ sigils: [], stones: [] });
    expect(sanitizeWishlists("nope", POOL)).toEqual({ sigils: [], stones: [] });
    expect(sanitizeWishlists(42, POOL)).toEqual({ sigils: [], stones: [] });
  });

  it("keeps valid sigil entries and drops unknown traits", () => {
    const result = sanitizeWishlists({ sigils: [{ trait: "000000aa" }, { trait: "ffffffff" }], stones: [] }, POOL);
    expect(result.sigils).toEqual([{ trait: "000000aa" }]);
  });

  it("dedupes sigil entries by trait", () => {
    const result = sanitizeWishlists(
      { sigils: [{ trait: "000000aa" }, { trait: "000000aa" }, { trait: "000000bb" }], stones: [] },
      POOL
    );
    expect(result.sigils).toEqual([{ trait: "000000aa" }, { trait: "000000bb" }]);
  });

  it("drops sigil entries with junk shapes", () => {
    const result = sanitizeWishlists(
      { sigils: [null, "nope", {}, { trait: 5 }, { notTrait: "000000aa" }], stones: [] },
      POOL
    );
    expect(result.sigils).toEqual([]);
  });

  it("drops stone entries with an unknown trait", () => {
    const result = sanitizeWishlists(
      { sigils: [], stones: [{ slots: [{ trait: "ffffffff", minLevel: 5 }] }] },
      POOL
    );
    expect(result.stones).toEqual([]);
  });

  it("drops stone entries with a minLevel not in the pool's level set", () => {
    const result = sanitizeWishlists(
      { sigils: [], stones: [{ slots: [{ trait: "000000aa", minLevel: 6 }] }] },
      POOL
    );
    expect(result.stones).toEqual([]);
  });

  it("drops junk stone shapes: null, non-object, missing fields, empty slots, >3 slots", () => {
    const tooManySlots = {
      slots: [
        { trait: "000000aa", minLevel: 5 },
        { trait: "000000bb", minLevel: 5 },
        { trait: "000000cc", minLevel: 5 },
        { trait: "000000aa", minLevel: 5 },
      ],
    };
    const result = sanitizeWishlists(
      {
        sigils: [],
        stones: [null, "nope", {}, { slots: [] }, { notSlots: [] }, tooManySlots],
      },
      POOL
    );
    expect(result.stones).toEqual([]);
  });

  it("drops a stone entry no valid combo can satisfy: wanting one trait twice when only one position offers it", () => {
    const result = sanitizeWishlists(
      {
        sigils: [],
        stones: [
          {
            slots: [
              { trait: "000000aa", minLevel: 5 },
              { trait: "000000aa", minLevel: 5 },
            ],
          },
        ],
      },
      POOL
    );
    expect(result.stones).toEqual([]);
  });

  it("drops a stone entry whose trait exists but whose min level is unreachable in every assignable position", () => {
    // "cc" only ever rolls at level 5 in the pool double.
    const result = sanitizeWishlists(
      { sigils: [], stones: [{ slots: [{ trait: "000000cc", minLevel: 7 }] }] },
      POOL
    );
    expect(result.stones).toEqual([]);
  });

  it("keeps a valid stone entry some combo can satisfy", () => {
    const entry = { slots: [{ trait: "000000aa", minLevel: 7 }, { trait: "000000bb", minLevel: 5 }] };
    const result = sanitizeWishlists({ sigils: [], stones: [entry] }, POOL);
    expect(result.stones).toEqual([entry]);
  });

  it("drops the whole entry when a later slot is junk (no truncation)", () => {
    const result = sanitizeWishlists(
      { sigils: [], stones: [{ slots: [{ trait: "000000aa", minLevel: 5 }, { trait: "not-a-trait" }] }] },
      POOL
    );
    expect(result.stones).toEqual([]);
  });
});
