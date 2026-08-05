import { describe, expect, it } from "vitest";

import type { EnemySeries, EnemyType } from "@/types";

import { hostilitySeriesFor } from "./hostilityChart";

// Distinct values in both arms, so a swapped selector cannot coincidentally
// produce the right answer.
const DEALT: EnemySeries[] = [
  { enemyType: "Gallanza", values: [10, 20, 30] },
  { enemyType: "Maglielle", values: [1, 2, 3] },
];

const RECEIVED: EnemySeries[] = [{ enemyType: "Managarmr", values: [900, 800, 700] }];

// The view injects `translateEnemyType`; a marker is enough to prove the label
// comes from the injected namer and not from the raw type.
const enemyName = (enemyType: EnemyType) => `name(${JSON.stringify(enemyType)})`;

const call = (metricKey: string, dealt = DEALT, received = RECEIVED) =>
  hostilitySeriesFor({ metricKey, dealt, received, enemyName });

describe("hostilitySeriesFor", () => {
  // The two cases this module exists for. Damage Done's ENEMY side is what the
  // enemies dealt, and Damage Taken's is what they received — both read
  // backwards from the tab name, which is how they get inverted. These must
  // fail if the arms are ever swapped.
  it("draws the DEALT series on the damage tab", () => {
    const series = call("damage");
    expect(series?.map((band) => band.values)).toEqual([
      [10, 20, 30],
      [1, 2, 3],
    ]);
  });

  it("draws the RECEIVED series on the taken tab", () => {
    expect(call("taken")?.map((band) => band.values)).toEqual([[900, 800, 700]]);
  });

  // Stated separately from the two above: a swap that also inverted the tab
  // keys would keep the value assertions passing in pairs, but not this one.
  it("never draws the received series for the damage tab, or the reverse", () => {
    expect(call("damage")?.some((band) => band.values[0] === 900)).toBe(false);
    expect(call("taken")?.some((band) => band.values[0] === 10)).toBe(false);
  });

  it("has no series for a metric with neither source", () => {
    // The status tabs (and stun, and SBA) reach this with real charts in hand —
    // the metric, not the data, is what says there is nothing to draw.
    expect(call("buffs")).toBeNull();
    expect(call("stun")).toBeNull();
    expect(call("sba")).toBeNull();
  });

  it("answers null rather than an empty array for a log carrying no series", () => {
    // Null is load-bearing: the caller keeps the chart it was already drawing,
    // where an empty array would blank the plot. Logs recorded before
    // damage-taken capture reach this on the damage tab.
    expect(call("damage", [])).toBeNull();
    expect(call("taken", DEALT, [])).toBeNull();
  });

  it("keys each band by the table's own enemy row key", () => {
    // `enemy:<JSON of the type>` — the grammar `enemyRowKey` in
    // metrics/damageDone.ts writes for the row this band decomposes. Pinned as
    // a literal here on purpose: the row builders' own suites assert the same
    // shape independently, so nothing checks the constructor against itself.
    expect(call("damage")?.map((band) => band.key)).toEqual(['enemy:"Gallanza"', 'enemy:"Maglielle"']);
  });

  it("keys an unnamed enemy by its hash object, not by [object Object]", () => {
    const unknown: EnemyType = { Unknown: 3735928559 };
    const series = call("damage", [{ enemyType: unknown, values: [5] }]);
    expect(series?.[0].key).toBe('enemy:{"Unknown":3735928559}');
  });

  it("labels each band through the injected namer", () => {
    expect(call("taken")?.map((band) => band.label)).toEqual(['name("Managarmr")']);
  });

  it("keeps the backend's order rather than re-ranking", () => {
    // The table ranks by the same totals; a second sort rule here would let the
    // biggest band and the top row disagree.
    const series = call("damage", [
      { enemyType: "Small", values: [1] },
      { enemyType: "Big", values: [99] },
    ]);
    expect(series?.map((band) => band.label)).toEqual(['name("Small")', 'name("Big")']);
  });
});
