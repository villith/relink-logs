import { describe, expect, it } from "vitest";

import type { GroupReference } from "@/types";

import { HP_SERIES_COLORS, mantineColorVar } from "../DetailCharts";

import {
  BAND_COLOR_COUNT,
  bandColorAt,
  hasTimeFilters,
  paletteOrderOf,
  referenceBandOrder,
  stripTimeFilters,
} from "./bandPalette";

describe("bandColorAt", () => {
  it("reproduces the existing palette for the first lap, so no chart changes colour", () => {
    HP_SERIES_COLORS.forEach((color, index) => expect(bandColorAt(index)).toBe(mantineColorVar(color)));
  });

  it("gives a full palette of distinct colours before repeating, so reference ranks do not collide", () => {
    // Reference ranks index this directly, so its LENGTH is what decides
    // whether two drawn bands can share a colour.
    const colors = Array.from({ length: BAND_COLOR_COUNT }, (_, index) => bandColorAt(index));
    expect(new Set(colors).size).toBe(BAND_COLOR_COUNT);
    expect(bandColorAt(BAND_COLOR_COUNT)).toBe(bandColorAt(0));
  });

  it("is wide enough that a busy fight's ranks stay distinct", () => {
    expect(BAND_COLOR_COUNT).toBeGreaterThanOrEqual(36);
  });
});

describe("stripTimeFilters", () => {
  it("drops the three time fields and keeps everything else", () => {
    expect(
      stripTimeFilters({ metric: "damage", source: 7, windows: [{ fromMs: 1, upToMs: 2 }], fromMs: 1, upToMs: 9 })
    ).toEqual({ metric: "damage", source: 7 });
  });

  it("leaves a request that narrows no time untouched", () => {
    const request = { metric: "damage", source: 7, target: null };
    expect(stripTimeFilters(request)).toEqual(request);
  });
});

describe("hasTimeFilters", () => {
  it("is false for a request that narrows no time", () => {
    expect(hasTimeFilters({ metric: "damage", source: 7 })).toBe(false);
  });

  it("is true for any one of the three on its own", () => {
    // An EMPTY windows array is a real mask, not an absent one — the same
    // convention the aggregator follows.
    expect(hasTimeFilters({ windows: [] })).toBe(true);
    expect(hasTimeFilters({ fromMs: 0 })).toBe(true);
    expect(hasTimeFilters({ upToMs: 10 })).toBe(true);
  });

  it("is false for no request at all", () => {
    expect(hasTimeFilters(undefined)).toBe(false);
    expect(hasTimeFilters(null)).toBe(false);
  });
});

describe("paletteOrderOf", () => {
  it("ranks by the reference, not by the order drawn now", () => {
    // The whole point: "c" is drawn first under the filter but keeps the
    // reference's third colour.
    const order = paletteOrderOf(["a", "b", "c"], ["c", "a"]);
    expect(order.get("a")).toBe(0);
    expect(order.get("c")).toBe(2);
  });

  it("appends a band the reference never produced, after every reference rank", () => {
    const order = paletteOrderOf(["a", "b"], ["z", "a"]);
    expect(order.get("z")).toBe(2);
  });

  it("degrades to the drawn order when there is no reference yet", () => {
    const order = paletteOrderOf([], ["x", "y"]);
    expect([order.get("x"), order.get("y")]).toEqual([0, 1]);
  });

  it("gives a repeated key one rank, so a duplicate cannot spend two colours", () => {
    const order = paletteOrderOf(["a", "a", "b"], []);
    expect(order.get("b")).toBe(1);
  });
});

const ability = (action: number, amount: number): GroupReference => ({
  key: { kind: "friendlyAbility", actionType: { Normal: action }, childCharacterType: "Pl1000" },
  amount,
});

describe("referenceBandOrder", () => {
  it("ranks the whole-fight totals largest first", () => {
    expect(referenceBandOrder([ability(1, 10), ability(2, 900), ability(3, 50)])).toEqual([
      "skill:Normal:2",
      "skill:Normal:3",
      "skill:Normal:1",
    ]);
  });

  it("folds several backend keys onto one band before ranking", () => {
    // The whole reason the backend sends AMOUNTS rather than ranks: a band can
    // be several aggregate keys, and a rank over the raw keys is not a rank
    // over the bands drawn. Summed first, ranked second.
    const order = referenceBandOrder([ability(1, 10), ability(1, 10), ability(2, 15)]);
    expect(order[0]).toBe("skill:Normal:1");
  });

  it("is empty for an empty reference, so the chart ranks its own bands", () => {
    expect(referenceBandOrder([])).toEqual([]);
  });

  it("keys bands the same way the chart does, so a reference rank names a real band", () => {
    // Guards the one thing this cannot get wrong: a key grammar that drifts
    // from `groupBandsFor`'s would rank keys no band ever asks about, and the
    // palette would silently fall back to the drawn order for every band.
    expect(referenceBandOrder([{ key: { kind: "player", index: 7 }, amount: 1 }])).toEqual(["player:7"]);
  });
});
