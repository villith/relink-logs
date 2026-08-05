import { describe, expect, it } from "vitest";

import type { StatusInterval } from "@/types";

import { buildEffectSeries, buildStatusSeries } from "./statusChart";

const interval = (over: Partial<StatusInterval>): StatusInterval => ({
  actorIndex: 0,
  casterIndex: null,
  statusId: 10,
  abilityId: 500,
  startMs: 0,
  endMs: 1_000,
  maxStacks: 1,
  targetSegment: null,
  applications: 1,
  ...over,
});

const holderOf = (i: StatusInterval) => ({ key: `player:${i.actorIndex}`, label: `P${i.actorIndex}` });

describe("buildStatusSeries", () => {
  it("returns nothing when no effect is pinned", () => {
    expect(
      buildStatusSeries({ intervals: [interval({})], pinnedKey: null, bucketMs: 1_000, len: 3, holderOf })
    ).toEqual([]);
  });

  it("gives one series per holder, one value per bucket", () => {
    const series = buildStatusSeries({
      intervals: [
        interval({ actorIndex: 0, startMs: 0, endMs: 2_000 }),
        interval({ actorIndex: 1, startMs: 1_000, endMs: 3_000 }),
      ],
      pinnedKey: "status:10:500",
      bucketMs: 1_000,
      len: 3,
      holderOf,
    });

    expect(series).toEqual([
      { key: "player:0", label: "P0", values: [1, 1, 0] },
      { key: "player:1", label: "P1", values: [0, 1, 1] },
    ]);
  });

  it("reports the stack count, not merely presence", () => {
    const series = buildStatusSeries({
      intervals: [interval({ startMs: 0, endMs: 2_000, maxStacks: 4 })],
      pinnedKey: "status:10:500",
      bucketMs: 1_000,
      len: 3,
      holderOf,
    });

    expect(series[0].values).toEqual([4, 4, 0]);
  });

  it("takes the deepest stack where one holder's windows overlap", () => {
    const series = buildStatusSeries({
      intervals: [
        interval({ startMs: 0, endMs: 2_000, maxStacks: 2 }),
        interval({ startMs: 1_000, endMs: 2_000, maxStacks: 5 }),
      ],
      pinnedKey: "status:10:500",
      bucketMs: 1_000,
      len: 3,
      holderOf,
    });

    expect(series[0].values).toEqual([2, 5, 0]);
  });

  it("ignores intervals of a different effect", () => {
    const series = buildStatusSeries({
      intervals: [interval({ statusId: 99, startMs: 0, endMs: 3_000 }), interval({ startMs: 0, endMs: 1_000 })],
      pinnedKey: "status:10:500",
      bucketMs: 1_000,
      len: 3,
      holderOf,
    });

    expect(series).toHaveLength(1);
    expect(series[0].values).toEqual([1, 0, 0]);
  });

  it("ranks holders by how long they held it, longest first", () => {
    const series = buildStatusSeries({
      intervals: [
        interval({ actorIndex: 7, startMs: 0, endMs: 1_000 }),
        interval({ actorIndex: 3, startMs: 0, endMs: 3_000 }),
      ],
      pinnedKey: "status:10:500",
      bucketMs: 1_000,
      len: 3,
      holderOf,
    });

    expect(series.map((s) => s.key)).toEqual(["player:3", "player:7"]);
  });

  it("treats a missing stack count as one stack, never none", () => {
    const series = buildStatusSeries({
      intervals: [interval({ startMs: 0, endMs: 1_000, maxStacks: 0 })],
      pinnedKey: "status:10:500",
      bucketMs: 1_000,
      len: 2,
      holderOf,
    });

    expect(series[0].values).toEqual([1, 0]);
  });
});

const holderKeyOf = (i: StatusInterval) => `player:${i.actorIndex}`;
const labelOf = (key: string) => `L(${key})`;

describe("buildEffectSeries", () => {
  it("gives one series per effect, counting holders per bucket", () => {
    const series = buildEffectSeries({
      intervals: [
        interval({ actorIndex: 0, startMs: 0, endMs: 2_000 }),
        interval({ actorIndex: 1, startMs: 1_000, endMs: 3_000 }),
      ],
      bucketMs: 1_000,
      len: 3,
      topN: 8,
      labelOf,
      holderKeyOf,
    });

    expect(series).toEqual([{ key: "status:10:500", label: "L(status:10:500)", values: [1, 2, 1] }]);
  });

  it("counts a holder once however many of their windows overlap a bucket", () => {
    const series = buildEffectSeries({
      intervals: [
        interval({ actorIndex: 0, startMs: 0, endMs: 2_000 }),
        interval({ actorIndex: 0, startMs: 500, endMs: 1_500 }),
      ],
      bucketMs: 1_000,
      len: 2,
      topN: 8,
      labelOf,
      holderKeyOf,
    });

    expect(series[0].values).toEqual([1, 1]);
  });

  it("keeps separate causes of one status as separate series, like the table rows", () => {
    const series = buildEffectSeries({
      intervals: [interval({ abilityId: 500 }), interval({ abilityId: 900 })],
      bucketMs: 1_000,
      len: 1,
      topN: 8,
      labelOf,
      holderKeyOf,
    });

    expect(series.map((entry) => entry.key).sort()).toEqual(["status:10:500", "status:10:900"]);
  });

  it("ranks by merged uptime and caps at topN", () => {
    const series = buildEffectSeries({
      intervals: [
        interval({ statusId: 1, startMs: 0, endMs: 1_000 }),
        interval({ statusId: 2, startMs: 0, endMs: 3_000 }),
        interval({ statusId: 3, startMs: 0, endMs: 2_000 }),
      ],
      bucketMs: 1_000,
      len: 3,
      topN: 2,
      labelOf,
      holderKeyOf,
    });

    expect(series.map((entry) => entry.key)).toEqual(["status:2:500", "status:3:500"]);
  });

  it("answers empty for an empty chart", () => {
    expect(
      buildEffectSeries({ intervals: [interval({})], bucketMs: 1_000, len: 0, topN: 8, labelOf, holderKeyOf })
    ).toEqual([]);
  });
});
