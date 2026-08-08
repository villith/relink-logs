import { describe, expect, it, vi } from "vitest";

// Resolved through Tauri's resource API at import time, which jsdom has not.
// Same trimmed real entries as abilitySkills.test.ts: Pl0000's normal-attack
// group is what the parent/children fold must reproduce.
vi.mock("@/assets/skill-groups", () => ({
  default: {
    Pl0000: { "normal-attack": { skills: [100, 110, 120] }, "power-raise": { skills: [200, 201] } },
  },
}));

import type { ActionType, GroupAggregate, GroupKey, GroupMeasure } from "@/types";
import { humanizeNumber, ratePerSecond, share } from "@/utils";

import { rowKeyingFor } from "../../abilitySkills";
import type { EventRow } from "../../events/eventRows";
import { laneMatcherFor } from "../../timeline/laneMatch";

import { groupBandsFor, groupRowsFor, type GroupRowsContext } from "./groupRows";

/** One damage hit carrying an ability key — all the lane join reads. */
const EVENT = (abilityKey: string): EventRow => ({
  timeMs: 0,
  kind: "damage",
  sourceIndex: 0,
  targetIndex: null,
  targetSpace: "actor",
  abilityKey,
  statusKey: null,
  statusId: null,
  detailKey: null,
  amount: null,
});

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

  it("drops the backend's own rollup, which duplicates rows it also sends", () => {
    // `aggregate_groups` keeps every row for the table and APPENDS `other`
    // summing ranks topN.. — so the real rows already carry the whole fight,
    // and keeping `other` too would stack the tail twice. The chart rolls the
    // tail up itself now (from whichever bands are hidden), which is what lets
    // one be switched on without the stack standing that band too tall.
    const bands = groupBandsFor([
      { key: { kind: "other" }, measure: measure(9000), series: [9000] },
      { key: { kind: "player", index: 0 }, measure: measure(10), series: [10] },
    ]);
    expect(bands.map((band) => band.key)).toEqual(["player:0"]);
  });

  const RANKED = [
    { key: { kind: "player" as const, index: 0 }, measure: measure(100), series: [100] },
    { key: { kind: "player" as const, index: 1 }, measure: measure(60), series: [60] },
    { key: { kind: "player" as const, index: 2 }, measure: measure(30), series: [30] },
    { key: { kind: "other" as const }, measure: measure(30), series: [30] },
  ];

  it("keeps every band and marks the ones past topN as the tail", () => {
    // Sliced away, those bands were unreachable: the plot showed the top few
    // and one lump, with no way to ask about anything inside the lump.
    const bands = groupBandsFor(RANKED, 2);
    expect(bands.map((band) => band.key)).toEqual(["player:0", "player:1", "player:2"]);
    expect(bands.map((band) => band.tail ?? false)).toEqual([false, false, true]);
  });

  it("still sums to the fight exactly once", () => {
    // The invariant the old slice existed to protect, kept by dropping the
    // backend rollup rather than by dropping the rows.
    expect(groupBandsFor(RANKED, 2).reduce((sum, band) => sum + band.values[0], 0)).toBe(190);
  });

  it("ranks for the cap AFTER folding, so the cap counts bands and not backend rows", () => {
    // Two rows of one skill group are ONE band. Ranked before the fold, a
    // group split across several rows spent several of the cap's places and
    // the plot drew fewer bands than it was asked for — which is how a
    // top-8 cap came to show six abilities.
    const bands = groupBandsFor(
      [
        {
          key: { kind: "friendlyAbility" as const, actionType: { Normal: 100 }, childCharacterType: "Pl0000" as const },
          measure: measure(30),
          series: [30],
        },
        {
          key: { kind: "friendlyAbility" as const, actionType: { Normal: 110 }, childCharacterType: "Pl0000" as const },
          measure: measure(30),
          series: [30],
        },
        { key: { kind: "player" as const, index: 0 }, measure: measure(50), series: [50] },
        { key: { kind: "player" as const, index: 1 }, measure: measure(40), series: [40] },
      ],
      2
    );

    // The two skill rows fold into one 60 band, which outranks both players.
    expect(bands.map((band) => band.key)).toEqual(['skill:Group:normal-attack@"Pl0000"', "player:0", "player:1"]);
    expect(bands.map((band) => band.tail ?? false)).toEqual([false, false, true]);
  });

  it("marks nothing as tail without a cap", () => {
    expect(groupBandsFor(RANKED).every((band) => !band.tail)).toBe(true);
  });
});

describe("groupRowsFor — the Other rollup", () => {
  it("never becomes a table row — it exists for the chart slice alone", () => {
    // `aggregate_groups` keeps EVERY real row and appends `other` summing the
    // tail past topN, purely so the chart can slice. The table already lists
    // the whole tail, so rendering `other` too showed every drilled player a
    // row that double-counts abilities sitting right above it.
    const rows = groupRowsFor(
      [
        agg({ kind: "player", index: 0 }, measure(100)),
        agg({ kind: "other" }, measure(5000, 50)),
        agg({ kind: "player", index: 1 }, measure(200)),
      ],
      ctx({ groupBy: "source" })
    );
    expect(rows.map((row) => row.key)).toEqual(["player:1", "player:0"]);
  });

  it("leaves the rollup out of the share denominator", () => {
    // `other` duplicates rows already in the table, so counting it would divide
    // every share by the fight plus its own tail — the real rows would never
    // add up to 100%.
    const rows = groupRowsFor(
      [
        agg({ kind: "player", index: 0 }, measure(750)),
        agg({ kind: "player", index: 1 }, measure(250)),
        agg({ kind: "other" }, measure(250)),
      ],
      ctx({ groupBy: "source" })
    );
    const shareOf = (key: string) => rows.find((row) => row.key === key)?.columns.at(-1);
    expect(shareOf("player:0")).toBe("75.0%");
    expect(shareOf("player:1")).toBe("25.0%");
  });
});

describe("groupRowsFor — collapse supplementary", () => {
  // The echo's payload IS its cause's action id (see `abilitySkills`), so
  // `SupplementaryDamage(999)` is the echo of `Normal(999)`.
  const CAUSE = { kind: "friendlyAbility" as const, actionType: { Normal: 999 }, childCharacterType: "Pl0000" };
  const ECHO = {
    kind: "friendlyAbility" as const,
    actionType: { SupplementaryDamage: 999 },
    childCharacterType: "Pl0000",
  };
  // What the view passes as `everySkill`: the actions the party actually used.
  const everySkill = [
    { actionType: CAUSE.actionType, childCharacterType: "Pl0000" as const },
    { actionType: ECHO.actionType, childCharacterType: "Pl0000" as const },
  ];
  const aggregates = [agg(CAUSE, measure(300, 3, 50, 150)), agg(ECHO, measure(100, 4, 5, 40))];

  it("keeps the echo on its own row with the collapse off", () => {
    const rows = groupRowsFor(aggregates, ctx({ groupBy: "ability", keying: rowKeyingFor(everySkill, false) }));
    expect(rows.map((row) => row.key)).toEqual(["skill:Normal:999", "skill:SupplementaryDamage:0"]);
    expect(rows[0].subValue).toBeUndefined();
  });

  it("folds the echo onto its cause's row with the collapse on", () => {
    const rows = groupRowsFor(aggregates, ctx({ groupBy: "ability", keying: rowKeyingFor(everySkill, true) }));
    expect(rows.map((row) => row.key)).toEqual(["skill:Normal:999"]);
    expect(rows[0].value).toBe(400);
    // Hits sum too — the row now answers for both damage sources.
    expect(rows[0].columns[1]).toBe("7");
  });

  it("reports the echo's share as subValue, so the bar can draw the split", () => {
    const rows = groupRowsFor(aggregates, ctx({ groupBy: "ability", keying: rowKeyingFor(everySkill, true) }));
    expect(rows[0].subValue).toBe(100);
  });

  it("keeps min and max over the DIRECT aggregates only", () => {
    // An echo tick is a different damage source; folding it in would make the
    // named skill's smallest hit read as an echo tick (damageDone's own rule).
    const rows = groupRowsFor(aggregates, ctx({ groupBy: "ability", keying: rowKeyingFor(everySkill, true) }));
    expect(rows[0].columns[2]).toBe(humanizeNumber(50));
    expect(rows[0].columns[3]).toBe(humanizeNumber(150));
  });

  it("mounts no subValue on an all-echo row — the residue has no split to show", () => {
    // A cause nobody landed leaves its echo on the echo row, which is echo all
    // the way across.
    const orphan = [agg({ ...ECHO, actionType: { SupplementaryDamage: 4242 } }, measure(70, 2))];
    const rows = groupRowsFor(orphan, ctx({ groupBy: "ability", keying: rowKeyingFor(everySkill, true) }));
    expect(rows.map((row) => row.key)).toEqual(["skill:SupplementaryDamage:0"]);
    expect(rows[0].subValue).toBeUndefined();
  });

  it("folds an echo onto a GROUPED cause, into the member that caused it", () => {
    // Children must still sum to the parent, or the expansion contradicts the
    // row it opens — and a skill group holds skills, so the echo rides its
    // cause rather than standing beside them as a member of its own.
    const grouped = [
      agg({ kind: "friendlyAbility", actionType: { Normal: 100 }, childCharacterType: "Pl0000" }, measure(300, 3)),
      agg(
        { kind: "friendlyAbility", actionType: { SupplementaryDamage: 100 }, childCharacterType: "Pl0000" },
        measure(100, 4)
      ),
    ];
    const skills = grouped.map((aggregate) => ({
      actionType: (aggregate.key as { actionType: ActionType }).actionType,
      childCharacterType: "Pl0000" as const,
    }));
    const rows = groupRowsFor(grouped, ctx({ groupBy: "ability", keying: rowKeyingFor(skills, true) }));

    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('skill:Group:normal-attack@"Pl0000"');
    expect(rows[0].value).toBe(400);
    expect(rows[0].subValue).toBe(100);
    expect(rows[0].children?.map((child) => child.key)).toEqual(["skill:Normal:100"]);
    expect(rows[0].children?.[0].subValue).toBe(100);
    expect(rows[0].children?.reduce((sum, child) => sum + child.value, 0)).toBe(400);
  });
});

describe("groupBandsFor — collapse supplementary", () => {
  const everySkill = [
    { actionType: { Normal: 999 } as ActionType, childCharacterType: "Pl0000" as const },
    { actionType: { SupplementaryDamage: 999 } as ActionType, childCharacterType: "Pl0000" as const },
  ];
  const aggregates = [
    {
      key: { kind: "friendlyAbility" as const, actionType: { Normal: 999 }, childCharacterType: "Pl0000" as const },
      measure: measure(300),
      series: [100, 200],
    },
    {
      key: {
        kind: "friendlyAbility" as const,
        actionType: { SupplementaryDamage: 999 },
        childCharacterType: "Pl0000" as const,
      },
      measure: measure(100),
      series: [40, 60],
    },
  ];

  it("merges an echo band into its cause's band, so a band and its row stay one thing", () => {
    const bands = groupBandsFor(aggregates, undefined, rowKeyingFor(everySkill, true));
    expect(bands.map((band) => band.key)).toEqual(["skill:Normal:999"]);
    expect(bands[0].values).toEqual([140, 260]);
  });

  it("keeps them apart with the collapse off", () => {
    const bands = groupBandsFor(aggregates, undefined, rowKeyingFor(everySkill, false));
    expect(bands.map((band) => band.key)).toEqual(["skill:Normal:999", "skill:SupplementaryDamage:0"]);
  });
});

describe("groupRowsFor + laneMatcherFor — the timeline's lane list", () => {
  // The timeline's lanes ARE these rows, and its join expands each row's label
  // through the SAME collapse-aware `actionsForPin`. Keyed without the collapse
  // while the join keyed with it, the echo row survived the fold but could
  // claim nothing: its hits all key to their cause rows. An empty lane is the
  // shape that defect takes on screen.
  const everySkill = [
    { actionType: { Normal: 999 } as ActionType, childCharacterType: "Pl0000" as const },
    { actionType: { SupplementaryDamage: 999 } as ActionType, childCharacterType: "Pl0000" as const },
  ];
  const aggregates = [
    agg({ kind: "friendlyAbility", actionType: { Normal: 999 }, childCharacterType: "Pl0000" }, measure(300, 3)),
    agg(
      { kind: "friendlyAbility", actionType: { SupplementaryDamage: 999 }, childCharacterType: "Pl0000" },
      measure(100, 4)
    ),
  ];

  const lanesFor = (collapse: boolean) => {
    const keying = rowKeyingFor(everySkill, collapse);
    const rows = groupRowsFor(aggregates, ctx({ groupBy: "ability", keying }));
    const matcher = laneMatcherFor(rows, {
      everySkill,
      end: "source",
      segmentAt: () => -1,
      enemyTypeAt: () => null,
      keying,
    });
    return { rows, matcher };
  };

  it("leaves no lane the join cannot fill, with the collapse on", () => {
    const { rows, matcher } = lanesFor(true);
    const claimed = new Set(
      ["Normal:999", "SupplementaryDamage:999"]
        .map((key) => matcher.laneOf(EVENT(key)))
        .filter((lane): lane is string => lane !== null)
    );
    expect(rows.map((row) => row.key).filter((key) => !claimed.has(key))).toEqual([]);
  });

  it("still keys both lanes with the collapse off", () => {
    const { rows, matcher } = lanesFor(false);
    expect(rows).toHaveLength(2);
    expect(matcher.laneOf(EVENT("Normal:999"))).toBe("skill:Normal:999");
    expect(matcher.laneOf(EVENT("SupplementaryDamage:999"))).toBe("skill:SupplementaryDamage:0");
  });
});

describe("groupRowsFor — echo members of a grouped cause", () => {
  // The group's own member, its sibling, and the echo the FIRST of them caused.
  const grouped = [
    agg(
      { kind: "friendlyAbility", actionType: { Normal: 100 }, childCharacterType: "Pl0000" },
      measure(300, 3, 50, 150)
    ),
    agg(
      { kind: "friendlyAbility", actionType: { Normal: 110 }, childCharacterType: "Pl0000" },
      measure(200, 2, 90, 110)
    ),
    agg(
      { kind: "friendlyAbility", actionType: { SupplementaryDamage: 100 }, childCharacterType: "Pl0000" },
      measure(100, 4, 5, 40)
    ),
  ];
  const everySkill = [
    { actionType: { Normal: 100 } as ActionType, childCharacterType: "Pl0000" as const },
    { actionType: { Normal: 110 } as ActionType, childCharacterType: "Pl0000" as const },
    { actionType: { SupplementaryDamage: 100 } as ActionType, childCharacterType: "Pl0000" as const },
  ];
  const collapsed = () => groupRowsFor(grouped, ctx({ groupBy: "ability", keying: rowKeyingFor(everySkill, true) }));

  it("lists no echo among the members — a group contains no skill called Supplementary Damage", () => {
    expect(collapsed()[0].children?.map((child) => child.key)).toEqual(["skill:Normal:100", "skill:Normal:110"]);
  });

  it("folds the echo onto the MEMBER that caused it, so the children still sum to the parent", () => {
    const [parent] = collapsed();
    const children = parent.children ?? [];
    expect(children.reduce((sum, child) => sum + child.value, 0)).toBe(parent.value);
    // Normal:100 caused the echo, so it carries it; its sibling does not.
    expect(children.find((child) => child.key === "skill:Normal:100")?.value).toBe(400);
    expect(children.find((child) => child.key === "skill:Normal:110")?.value).toBe(200);
  });

  it("gives the causing member its own split, and its sibling none", () => {
    const children = collapsed()[0].children ?? [];
    expect(children.find((child) => child.key === "skill:Normal:100")?.subValue).toBe(100);
    expect(children.find((child) => child.key === "skill:Normal:110")?.subValue).toBeUndefined();
  });

  it("keeps a member's extremes over its DIRECT hits only", () => {
    const child = collapsed()[0].children?.find((entry) => entry.key === "skill:Normal:100");
    expect(child?.columns[2]).toBe(humanizeNumber(50));
    expect(child?.columns[3]).toBe(humanizeNumber(150));
  });

  it("still lists the echo as its own member with the collapse off", () => {
    // Off, the echo never reaches the group bucket at all — it is its own row.
    const rows = groupRowsFor(grouped, ctx({ groupBy: "ability", keying: rowKeyingFor(everySkill, false) }));
    expect(rows.map((row) => row.key)).toEqual(['skill:Group:normal-attack@"Pl0000"', "skill:SupplementaryDamage:0"]);
    expect(rows[0].children?.map((child) => child.key)).toEqual(["skill:Normal:100", "skill:Normal:110"]);
  });
});
