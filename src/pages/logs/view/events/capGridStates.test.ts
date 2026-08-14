import { describe, expect, it } from "vitest";

import { buildGridStates, capBucketOf, classifyOffGrid, type GridSourceRow } from "./capGridStates";
import { gameLadderBase, ladderCurveFor } from "./capLadder";

// A real base from the shipped ladder, so the fixtures cannot drift off the
// asset: whatever Pl1900's normal curve holds at rate 0.5 is what the builder
// would use, and caps fabricated as trunc(base·K/100) are on-grid by
// construction.
const BASE = gameLadderBase(ladderCurveFor("Pl1900", 0)!, 0.5);

const onGrid = (k: number) => Math.trunc((BASE * k) / 100);

const HIT = (k: number): GridSourceRow => ({
  sourceIndex: 1,
  hit: { damage: 1, damage_cap: onGrid(k), base_damage: 1, attack_rate: 0.5, class_flags: 0 },
});

describe("capBucketOf", () => {
  it("orders summon > sba > skill > normal, null on absent flags", () => {
    expect(capBucketOf(0x80 | 0x40000)).toBe("summon");
    expect(capBucketOf(0x40000 | 0x10000)).toBe("sba");
    expect(capBucketOf(0x10000)).toBe("skill");
    expect(capBucketOf(0)).toBe("normal");
    expect(capBucketOf(null)).toBeNull();
  });
});

describe("buildGridStates", () => {
  const characterOf = () => "Pl1900" as const;

  it("collects on-grid K per actor and bucket, skipping what it cannot judge", () => {
    expect(BASE).toBeGreaterThan(0);
    const rows: GridSourceRow[] = [
      HIT(2401),
      HIT(2401),
      HIT(2426),
      // Off-grid: parked mid-way between two grid points.
      { sourceIndex: 1, hit: { ...HIT(2401).hit!, damage_cap: Math.trunc(BASE * 24.115) } },
      // Rows without a judgeable hit contribute nothing.
      { sourceIndex: 1, hit: null },
      { sourceIndex: null, hit: HIT(2401).hit },
      { sourceIndex: 1, hit: { ...HIT(2401).hit!, attack_rate: null } },
      { sourceIndex: 1, hit: { ...HIT(2401).hit!, class_flags: null } },
    ];
    const states = buildGridStates(rows, characterOf);
    expect(states.get(1)?.get("normal")).toEqual(
      new Map([
        [2401, 2],
        [2426, 1],
      ])
    );
  });

  it("keeps buckets apart: a skill hit never lands in the normal set", () => {
    const skill: GridSourceRow = {
      sourceIndex: 1,
      hit: { ...HIT(2401).hit!, class_flags: 0x10000 },
    };
    const states = buildGridStates([HIT(2401), skill], characterOf);
    expect(states.get(1)?.get("normal")?.get(2401)).toBe(1);
    expect(states.get(1)?.get("skill")?.get(2401)).toBe(1);
  });

  it("drops an actor whose character has no curve", () => {
    const states = buildGridStates([HIT(2401)], () => undefined);
    expect(states.size).toBe(0);
  });
});

describe("classifyOffGrid", () => {
  const states = new Map([
    [2401, 2],
    [2426, 1],
  ]);

  it("calls a K strictly inside the bracket a transition", () => {
    expect(classifyOffGrid(2410.3, states)).toBe("transition");
  });

  it("never rationalizes a hit outside every bracket", () => {
    expect(classifyOffGrid(2440.5, states)).toBeNull();
    expect(classifyOffGrid(2390.5, states)).toBeNull();
  });

  it("refuses a bracket of one state", () => {
    expect(classifyOffGrid(2410.3, new Map([[2401, 5]]))).toBeNull();
  });

  it("calls within 0.15 of a state settling, even with one state", () => {
    expect(classifyOffGrid(2426.1, states)).toBe("settling");
    expect(classifyOffGrid(2400.9, states)).toBe("settling");
    expect(classifyOffGrid(2401.1, new Map([[2401, 5]]))).toBe("settling");
  });

  it("returns null with no states at all", () => {
    expect(classifyOffGrid(2410.3, undefined)).toBeNull();
    expect(classifyOffGrid(2410.3, new Map())).toBeNull();
  });
});
