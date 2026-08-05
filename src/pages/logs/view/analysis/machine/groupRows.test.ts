import { describe, expect, it, vi } from "vitest";

// Resolved through Tauri's resource API at import time, which jsdom has not.
// Same trimmed real entries as abilitySkills.test.ts: Pl0000's normal-attack
// group is what the parent/children fold must reproduce.
vi.mock("@/assets/skill-groups", () => ({
  default: {
    Pl0000: { "normal-attack": { skills: [100, 110, 120] }, "power-raise": { skills: [200, 201] } },
  },
}));

import type { GroupAggregate, GroupKey, GroupMeasure } from "@/types";
import { humanizeNumber, ratePerSecond, share } from "@/utils";

import { groupBandsFor, groupRowsFor, type GroupRowsContext } from "./groupRows";

const measure = (amount: number, hits = 1, min: number | null = null, max: number | null = null): GroupMeasure => ({
  amount,
  hits,
  min,
  max,
});

const agg = (key: GroupKey, m: GroupMeasure): GroupAggregate => ({ key, measure: m, series: [] });

const ctx = (over: Partial<GroupRowsContext>): GroupRowsContext => ({
  metric: "damage",
  groupBy: "source",
  hostility: "friendly",
  partySlots: new Map([
    [0, 0],
    [1, 1],
    [7, 3],
  ]),
  source: null,
  fightDurationMs: 10_000,
  ...over,
});

describe("groupRowsFor — player rows", () => {
  it("keys players by index, pins the grouped dimension, and colours by party slot", () => {
    const rows = groupRowsFor(
      [agg({ kind: "player", index: 0 }, measure(1000, 2)), agg({ kind: "player", index: 7 }, measure(3000, 4))],
      ctx({ groupBy: "source" })
    );

    expect(rows.map((row) => row.key)).toEqual(["player:7", "player:0"]); // amount descending
    expect(rows[0].pinOnClick).toEqual({ source: 7 });
    expect(rows[0].colorSlot).toBe(3);
    expect(rows[1].colorSlot).toBe(0);
    expect(rows[0].kind).toBe("player");
    // The damage source shape: amount, rate, share of the fetched total.
    expect(rows[0].columns).toEqual([humanizeNumber(3000), ratePerSecond(3000, 10_000), share(3000, 4000)]);
  });

  it("pins the TARGET dimension when players are the grouped targets (enemy side)", () => {
    const rows = groupRowsFor(
      [agg({ kind: "player", index: 1 }, measure(500))],
      ctx({ groupBy: "target", hostility: "enemy" })
    );
    expect(rows[0].pinOnClick).toEqual({ targets: [1] });
  });

  it("adds the taken source grouping's share of the fetched total", () => {
    const rows = groupRowsFor(
      [agg({ kind: "player", index: 0 }, measure(3000, 2)), agg({ kind: "player", index: 1 }, measure(1000, 1))],
      ctx({ metric: "taken", groupBy: "source" })
    );

    // Amount, DTPS, share — the same players-level shape as damage, matching
    // damageTaken.columnKeys("players")'s three headers.
    expect(rows[0].columns).toEqual([humanizeNumber(3000), ratePerSecond(3000, 10_000), share(3000, 4000)]);
  });
});

describe("groupRowsFor — skill-group fold", () => {
  const members = [
    agg(
      { kind: "friendlyAbility", actionType: { Normal: 100 }, childCharacterType: "Pl0000" },
      measure(300, 3, 50, 150)
    ),
    agg(
      { kind: "friendlyAbility", actionType: { Normal: 110 }, childCharacterType: "Pl0000" },
      measure(100, 1, 100, 100)
    ),
    agg({ kind: "friendlyAbility", actionType: { Normal: 999 }, childCharacterType: "Pl0000" }, measure(50, 1, 50, 50)),
  ];

  it("folds one group's members into ONE parent row with summed measure and per-member children", () => {
    const rows = groupRowsFor(members, ctx({ groupBy: "ability", source: 0 }));

    expect(rows).toHaveLength(2);
    const [parent, loner] = rows;

    expect(parent.key).toBe('skill:Group:normal-attack@"Pl0000"');
    expect(parent.pinOnClick).toEqual({ ability: 'Group:normal-attack@"Pl0000"' });
    expect(parent.value).toBe(400);
    expect(parent.kind).toBe("ability");
    // The pinned source's party slot colours the rows, as damageDone always has.
    expect(parent.colorSlot).toBe(0);

    expect(parent.children).toHaveLength(2);
    expect(parent.children?.map((child) => child.key)).toEqual(["skill:Normal:100", "skill:Normal:110"]); // descending
    expect(parent.children?.[0].pinOnClick).toEqual({ ability: "Normal:100" });
    expect(parent.children?.[1].pinOnClick).toEqual({ ability: "Normal:110" });

    expect(loner.key).toBe("skill:Normal:999");
    expect(loner.children).toBeUndefined();
  });

  it("fills the six damage drill-down columns from the summed measure", () => {
    const rows = groupRowsFor(members, ctx({ groupBy: "ability", source: 0 }));
    const total = 450;
    // amount, hits, min, max, average, share — the exported damageColumns shape.
    expect(rows[0].columns).toEqual([
      humanizeNumber(400),
      "4",
      humanizeNumber(50),
      humanizeNumber(150),
      humanizeNumber(100),
      share(400, total),
    ]);
  });

  it("writes '—' where a measure never recorded an extreme", () => {
    const rows = groupRowsFor(
      [agg({ kind: "friendlyAbility", actionType: { Normal: 999 }, childCharacterType: "Pl0000" }, measure(50, 1))],
      ctx({ groupBy: "ability" })
    );
    expect(rows[0].columns[2]).toBe("—");
    expect(rows[0].columns[3]).toBe("—");
  });
});

describe("groupRowsFor — enemy rows", () => {
  it("keys enemy spawns by segment and pins the grouped dimension", () => {
    const rows = groupRowsFor(
      [agg({ kind: "enemySpawn", segment: 2, enemyType: "Em1000", instance: 1 }, measure(800, 2))],
      ctx({ groupBy: "target" })
    );
    expect(rows[0].key).toBe("target:2");
    expect(rows[0].label).toBe("target:2");
    expect(rows[0].kind).toBe("target");
    expect(rows[0].pinOnClick).toEqual({ targets: [2] });
    expect(rows[0].colorSlot).toBe(-1);
  });

  it("keys enemy TYPES by their JSON and leaves them unpinnable — a type cannot pick a spawn", () => {
    const rows = groupRowsFor(
      [agg({ kind: "enemyType", enemyType: { Unknown: 123 } }, measure(400))],
      ctx({ groupBy: "source", hostility: "enemy" })
    );
    expect(rows[0].key).toBe(`enemy:${JSON.stringify({ Unknown: 123 })}`);
    expect(rows[0].label).toBe(JSON.stringify({ Unknown: 123 }));
    expect(rows[0].kind).toBe("enemy");
    expect(rows[0].pinOnClick).toBeNull();
  });

  it("spells enemy attacks in the takenAttack JSON grammar and pins them as the ability", () => {
    const label = JSON.stringify({ enemyType: "Em1000", actionId: { Normal: 5 } });
    const rows = groupRowsFor(
      [agg({ kind: "enemyAttack", enemyType: "Em1000", actionId: { Normal: 5 } }, measure(600, 3))],
      ctx({ metric: "taken", groupBy: "ability" })
    );
    expect(rows[0].key).toBe(`taken:${label}`);
    expect(rows[0].label).toBe(label);
    expect(rows[0].kind).toBe("takenAttack");
    expect(rows[0].pinOnClick).toEqual({ ability: label });
    // The four-column taken drill-down shape: amount, hits, average, DTPS.
    expect(rows[0].columns).toEqual([humanizeNumber(600), "3", humanizeNumber(200), ratePerSecond(600, 10_000)]);
  });
});

describe("groupBandsFor", () => {
  it("keys bands by the same grammar as the rows and folds skill-group members' series", () => {
    const bands = groupBandsFor([
      {
        key: { kind: "friendlyAbility", actionType: { Normal: 100 }, childCharacterType: "Pl0000" },
        measure: measure(300),
        series: [100, 200],
      },
      {
        key: { kind: "friendlyAbility", actionType: { Normal: 110 }, childCharacterType: "Pl0000" },
        measure: measure(100),
        series: [0, 100],
      },
      { key: { kind: "player", index: 2 }, measure: measure(50), series: [50] },
    ]);

    expect(bands.map((band) => band.key)).toEqual(['skill:Group:normal-attack@"Pl0000"', "player:2"]);
    expect(bands[0].values).toEqual([100, 300]);
  });

  it("keeps the other rollup last however large its series", () => {
    const bands = groupBandsFor([
      { key: { kind: "other" }, measure: measure(9000), series: [9000] },
      { key: { kind: "player", index: 0 }, measure: measure(10), series: [10] },
    ]);
    expect(bands.map((band) => band.key)).toEqual(["player:0", "other"]);
  });
});

describe("groupRowsFor — the Other rollup", () => {
  it("names itself, pins nothing, and stays last however large it is", () => {
    const rows = groupRowsFor(
      [
        agg({ kind: "player", index: 0 }, measure(100)),
        agg({ kind: "other" }, measure(5000, 50)),
        agg({ kind: "player", index: 1 }, measure(200)),
      ],
      ctx({ groupBy: "source" })
    );
    expect(rows.map((row) => row.key)).toEqual(["player:1", "player:0", "other"]);
    const other = rows[2];
    expect(other.labelKey).toBe("ui.logs.chart-other-label");
    expect(other.pinOnClick).toBeNull();
    expect(other.colorSlot).toBe(-1);
  });
});
