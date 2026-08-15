import { describe, expect, it, vi } from "vitest";

// Resolved through Tauri's resource API at import time, which jsdom has not.
// Same trimmed real entries as abilitySkills.test.ts: Pl0000's normal-attack
// group is what the parent/children fold must reproduce.
vi.mock("@/assets/skill-groups", () => ({
  default: {
    Pl0000: { "normal-attack": { skills: [100, 110, 120] }, "power-raise": { skills: [200, 201] } },
  },
}));

import type { ActionType, FactTally, GroupAggregate, GroupFacts, GroupKey, GroupMeasure, MergedMeasure } from "@/types";
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
  capHit: null,
  capConditions: null,
});

const measure = (amount: number, hits = 1, min: number | null = null, max: number | null = null): GroupMeasure => ({
  amount,
  hits,
  min,
  max,
});

/** A `MergedMeasure` — the landing view of one aggregate key. */
const merged = (
  amount: number,
  hits: number,
  min: number | null = null,
  max: number | null = null,
  supplementary = 0
): MergedMeasure => ({ amount, hits, min, max, supplementary });

const agg = (key: GroupKey, m: GroupMeasure, mergedMeasure?: MergedMeasure): GroupAggregate => ({
  key,
  measure: m,
  merged: mergedMeasure ?? { ...m, supplementary: 0 },
  series: [],
});

const tally = (over: Partial<FactTally>): FactTally => ({
  measuredYes: 0,
  measuredNo: 0,
  inferredYes: 0,
  inferredNo: 0,
  unknown: 0,
  ...over,
});

/** A `GroupFacts` fixture where every tally defaults to the same one — tests
 * that care about only one fact (say, crit) override just that field. */
const facts = (over: Partial<GroupFacts> = {}): GroupFacts => ({
  crit: tally({}),
  weakPoint: tally({}),
  backAttack: tally({}),
  debuffed: tally({}),
  overdrive: tally({}),
  break: tally({}),
  overdriveDamage: 0,
  breakDamage: 0,
  ...over,
});

/** A band fixture: `groupBandsFor` reads only `key` and `series`, so both
 * measures ride along at the raw amount. */
const bandAgg = (key: GroupKey, amount: number, series: number[]): GroupAggregate => ({
  ...agg(key, measure(amount)),
  series,
});

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
    // The damage source shape: amount, rate, share of the fetched total, then
    // three dashes — this fixture's `measure` carries no facts.
    expect(rows[0].columns).toEqual([
      humanizeNumber(3000),
      ratePerSecond(3000, 10_000),
      share(3000, 4000),
      "—",
      "—",
      "—",
    ]);
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
    // amount, hits, min, max, average, share, then the crit/WP/BA cells —
    // dashes here, since these fixtures carry no facts.
    expect(rows[0].columns).toEqual([
      humanizeNumber(400),
      "4",
      humanizeNumber(50),
      humanizeNumber(150),
      humanizeNumber(100),
      share(400, total),
      "—",
      "—",
      "—",
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
      bandAgg({ kind: "friendlyAbility", actionType: { Normal: 100 }, childCharacterType: "Pl0000" }, 300, [100, 200]),
      bandAgg({ kind: "friendlyAbility", actionType: { Normal: 110 }, childCharacterType: "Pl0000" }, 100, [0, 100]),
      bandAgg({ kind: "player", index: 2 }, 50, [50]),
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
      bandAgg({ kind: "other" }, 9000, [9000]),
      bandAgg({ kind: "player", index: 0 }, 10, [10]),
    ]);
    expect(bands.map((band) => band.key)).toEqual(["player:0"]);
  });

  const RANKED = [
    bandAgg({ kind: "player", index: 0 }, 100, [100]),
    bandAgg({ kind: "player", index: 1 }, 60, [60]),
    bandAgg({ kind: "player", index: 2 }, 30, [30]),
    bandAgg({ kind: "other" }, 30, [30]),
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
        bandAgg({ kind: "friendlyAbility", actionType: { Normal: 100 }, childCharacterType: "Pl0000" }, 30, [30]),
        bandAgg({ kind: "friendlyAbility", actionType: { Normal: 110 }, childCharacterType: "Pl0000" }, 30, [30]),
        bandAgg({ kind: "player", index: 0 }, 50, [50]),
        bandAgg({ kind: "player", index: 1 }, 40, [40]),
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
    // Index 2: share sits before the trailing crit/WP/BA cells now.
    const shareOf = (key: string) => rows.find((row) => row.key === key)?.columns[2];
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
  // The landing view of the same pair: the cause's three landings carry the
  // four echo ticks, so its extremes are whole landings (55..190, neither raw
  // half) and the echo's own aggregate is left with nothing.
  const aggregates = [
    agg(CAUSE, measure(300, 3, 50, 150), merged(400, 3, 55, 190, 100)),
    agg(ECHO, measure(100, 4, 5, 40), merged(0, 0, null, null, 0)),
  ];

  it("keeps the echo on its own row with the collapse off", () => {
    const rows = groupRowsFor(aggregates, ctx({ groupBy: "ability", keying: rowKeyingFor(everySkill, false) }));
    expect(rows.map((row) => row.key)).toEqual(["skill:Normal:999", "skill:SupplementaryDamage:0"]);
    expect(rows[0].subValue).toBeUndefined();
  });

  it("folds the echo onto its cause's row with the collapse on", () => {
    const rows = groupRowsFor(aggregates, ctx({ groupBy: "ability", keying: rowKeyingFor(everySkill, true) }));
    expect(rows.map((row) => row.key)).toEqual(["skill:Normal:999"]);
    expect(rows[0].value).toBe(400);
    // The damage sums; the HITS do not. Three landings each carried an echo
    // tick, and counting those ticks again is the miscount this view removes.
    expect(rows[0].columns[1]).toBe("3");
  });

  it("reports the echo's share as subValue, so the bar can draw the split", () => {
    const rows = groupRowsFor(aggregates, ctx({ groupBy: "ability", keying: rowKeyingFor(everySkill, true) }));
    expect(rows[0].subValue).toBe(100);
  });

  it("takes the merged view's extremes from the backend, never from the raw halves", () => {
    // Under the landing model an extreme IS a whole landing, echo included, so
    // only the backend can compute it — a `GroupMeasure` has already lost the
    // per-hit identity. This fold reports what it was sent and derives nothing:
    // 55..190 is neither the direct half's 50..150 nor the echo's 5..40.
    const rows = groupRowsFor(aggregates, ctx({ groupBy: "ability", keying: rowKeyingFor(everySkill, true) }));
    expect(rows[0].columns[2]).toBe(humanizeNumber(55));
    expect(rows[0].columns[3]).toBe(humanizeNumber(190));
  });

  it("folds an unpaired echo's residue as damage on its cause's row, never as a landing", () => {
    // 0.54% of echoes never find their trigger (`supp_pairing`), and the
    // backend reports each as a landing of its own — correct for the echo ROW,
    // wrong the moment the collapse moves it onto its cause. The echo's payload
    // IS the cause's action id, so the damage belongs here; the hit does not.
    // Eustace's 360 normal attacks read 361 with the merge on (log 2586: one
    // orphan among 359 echoes of Normal 121/125/130).
    const partly = [
      agg(CAUSE, measure(300, 3, 50, 150), merged(400, 3, 55, 190, 100)),
      agg(ECHO, measure(130, 4, 5, 40), merged(30, 1, 30, 30, 30)),
    ];
    const [row] = groupRowsFor(partly, ctx({ groupBy: "ability", keying: rowKeyingFor(everySkill, true) }));
    expect(row.value).toBe(430);
    expect(row.columns[1]).toBe("3");
    // Nor an extreme: the residue is a fragment of a landing this row already
    // counted, so admitting its 30 would report a minimum no hit of this
    // ability ever dealt.
    expect(row.columns[2]).toBe(humanizeNumber(55));
    expect(row.columns[3]).toBe(humanizeNumber(190));
    expect(row.subValue).toBe(130);
  });

  it("keeps the residue's own landing where it stays on the echo row", () => {
    // The discriminating companion: same unclaimed residue, but its cause named
    // no row to fold onto, so this row IS the echo — and a row reporting damage
    // over no hits at all would divide its own average by nothing.
    const stranded = [
      agg({ ...ECHO, actionType: { SupplementaryDamage: 4242 } }, measure(130, 4, 5, 40), merged(30, 1, 30, 30, 30)),
    ];
    const [row] = groupRowsFor(stranded, ctx({ groupBy: "ability", keying: rowKeyingFor(everySkill, true) }));
    expect(row.key).toBe("skill:SupplementaryDamage:0");
    expect(row.columns[1]).toBe("1");
  });

  it("mounts no subValue on an all-echo row — the residue has no split to show", () => {
    // A cause nobody landed leaves its echo on the echo row, which is echo all
    // the way across.
    // Unclaimed, so the backend reports the whole of it as supplementary —
    // which is what makes this row echo all the way across rather than mixed.
    const orphan = [
      agg({ ...ECHO, actionType: { SupplementaryDamage: 4242 } }, measure(70, 2), merged(70, 2, null, null, 70)),
    ];
    const rows = groupRowsFor(orphan, ctx({ groupBy: "ability", keying: rowKeyingFor(everySkill, true) }));
    expect(rows.map((row) => row.key)).toEqual(["skill:SupplementaryDamage:0"]);
    expect(rows[0].subValue).toBeUndefined();
  });

  // The one state where a row and its chart band can disagree, pinned so the
  // choice reads as one. The keying resolves a cause against the actions the
  // party used; the backend claims an echo against the trigger EVENTS it holds.
  // Nothing today can leave the second ahead of the first — `everySkill` comes
  // from the unscoped breakdown, so it is a superset of anything a query can
  // leave surviving — but if it ever did, the claimed echo strands on the echo
  // row carrying the empty landing view its trigger already absorbed.
  it("leaves a claimed echo at zero when its cause resolves to no row", () => {
    const stranded = [
      agg({ ...CAUSE, actionType: { Normal: 4242 } }, measure(300, 3, 50, 150), merged(400, 3, 55, 190, 100)),
      agg({ ...ECHO, actionType: { SupplementaryDamage: 4242 } }, measure(100, 4, 5, 40), merged(0, 0, null, null, 0)),
    ];
    // `everySkill` names Normal:999, never Normal:4242 — so `causeRow` finds
    // nothing to fold onto.
    const rows = groupRowsFor(stranded, ctx({ groupBy: "ability", keying: rowKeyingFor(everySkill, true) }));
    expect(rows.map((row) => row.key)).toEqual(["skill:Normal:4242", "skill:SupplementaryDamage:0"]);
    // Zero, NOT its raw 100: the cause's row is already reporting that damage
    // inside its own 400, and the table summing to more than the fight is a
    // worse failure than a row that reads empty beside a band that does not.
    expect(rows[1].value).toBe(0);
    expect(rows[0].value).toBe(400);
    expect(rows.reduce((sum, row) => sum + row.value, 0)).toBe(400);
  });

  it("folds an echo onto a GROUPED cause, into the member that caused it", () => {
    // Children must still sum to the parent, or the expansion contradicts the
    // row it opens — and a skill group holds skills, so the echo rides its
    // cause rather than standing beside them as a member of its own.
    const grouped = [
      agg(
        { kind: "friendlyAbility", actionType: { Normal: 100 }, childCharacterType: "Pl0000" },
        measure(300, 3),
        merged(400, 3, null, null, 100)
      ),
      agg(
        { kind: "friendlyAbility", actionType: { SupplementaryDamage: 100 }, childCharacterType: "Pl0000" },
        measure(100, 4),
        merged(0, 0, null, null, 0)
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

describe("groupRowsFor — the landing view", () => {
  const CAUSE = { kind: "friendlyAbility" as const, actionType: { Normal: 9001 }, childCharacterType: "Pl0000" };
  const ECHO = {
    kind: "friendlyAbility" as const,
    actionType: { SupplementaryDamage: 9001 },
    childCharacterType: "Pl0000",
  };
  const everySkill = [
    { actionType: CAUSE.actionType, childCharacterType: "Pl0000" as const },
    { actionType: ECHO.actionType, childCharacterType: "Pl0000" as const },
  ];
  // One landing of 154,500 with a 92,681 echo — log 2573's Grade 1 Shot.
  const aggregates = [
    agg(CAUSE, measure(154_500, 1, 154_500, 154_500), merged(247_181, 1, 247_181, 247_181, 92_681)),
    agg(ECHO, measure(92_681, 1, 92_681, 92_681), merged(0, 0, null, null, 0)),
  ];
  // `merged` and `keying` move together — the view passes both off the one
  // toggle, and a test that set only the keying would silently exercise the
  // raw view while claiming to test the merged one.
  const rowsWith = (collapse: boolean) =>
    groupRowsFor(aggregates, ctx({ groupBy: "ability", keying: rowKeyingFor(everySkill, collapse) }));

  it("counts landings, not events, with the collapse on", () => {
    const [row] = rowsWith(true);
    // total, hits, min, max, average, share
    expect(row.columns.slice(0, 5)).toEqual([
      humanizeNumber(247_181),
      "1",
      humanizeNumber(247_181),
      humanizeNumber(247_181),
      humanizeNumber(247_181),
    ]);
  });

  it("keeps Avg inside Min..Max and equal to Total over Hits", () => {
    // The two invariants log 2573 broke: it read Min 154.5k, Max 154.5k,
    // Avg 123.6k over 2 hits.
    const [row] = rowsWith(true);
    const [total, hits, min, max, avg] = row.columns;
    expect(Number(hits)).toBe(1);
    expect(avg).toBe(humanizeNumber(Math.round(247_181 / 1)));
    expect(avg).toBe(min);
    expect(avg).toBe(max);
    expect(total).toBe(humanizeNumber(247_181));
  });

  it("draws the echo split from the backend's own figure", () => {
    // The split is READ, not inferred. The echo aggregate still arrives with
    // its `measure` intact — the toggle is display-only and must not force a
    // refetch — so the bucket it keys into is not evidence of anything.
    expect(rowsWith(true)[0].subValue).toBe(92_681);
  });

  it("draws no split when the backend reports no echo inside the landing", () => {
    // The companion the test above needs to discriminate: the one fixture
    // change is the cause's `supplementary`, zeroed. A fold that inferred the
    // split from bucket membership would still find the echo aggregate's raw
    // 92.7k sitting in this bucket and paint a segment for damage the backend
    // says is not there.
    const claimedNothing = [
      agg(CAUSE, measure(154_500, 1, 154_500, 154_500), merged(247_181, 1, 247_181, 247_181, 0)),
      agg(ECHO, measure(92_681, 1, 92_681, 92_681), merged(0, 0, null, null, 0)),
    ];
    const rows = groupRowsFor(claimedNothing, ctx({ groupBy: "ability", keying: rowKeyingFor(everySkill, true) }));
    expect(rows[0].subValue).toBeUndefined();
  });

  it("is inert with the collapse off", () => {
    const rows = rowsWith(false);
    expect(rows.map((row) => row.key)).toEqual(["skill:Normal:9001", "skill:SupplementaryDamage:0"]);
    expect(rows[0].columns.slice(0, 5)).toEqual([
      humanizeNumber(154_500),
      "1",
      humanizeNumber(154_500),
      humanizeNumber(154_500),
      humanizeNumber(154_500),
    ]);
    expect(rows[0].subValue).toBeUndefined();
  });
});

describe("groupBandsFor — collapse supplementary", () => {
  const everySkill = [
    { actionType: { Normal: 999 } as ActionType, childCharacterType: "Pl0000" as const },
    { actionType: { SupplementaryDamage: 999 } as ActionType, childCharacterType: "Pl0000" as const },
  ];
  const aggregates = [
    bandAgg({ kind: "friendlyAbility", actionType: { Normal: 999 }, childCharacterType: "Pl0000" }, 300, [100, 200]),
    bandAgg(
      { kind: "friendlyAbility", actionType: { SupplementaryDamage: 999 }, childCharacterType: "Pl0000" },
      100,
      [40, 60]
    ),
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
      measure(300, 3, 50, 150),
      merged(400, 3, 55, 190, 100)
    ),
    agg(
      { kind: "friendlyAbility", actionType: { Normal: 110 }, childCharacterType: "Pl0000" },
      measure(200, 2, 90, 110),
      merged(200, 2, 90, 110)
    ),
    agg(
      { kind: "friendlyAbility", actionType: { SupplementaryDamage: 100 }, childCharacterType: "Pl0000" },
      measure(100, 4, 5, 40),
      merged(0, 0, null, null, 0)
    ),
  ];
  const everySkill = [
    { actionType: { Normal: 100 } as ActionType, childCharacterType: "Pl0000" as const },
    { actionType: { Normal: 110 } as ActionType, childCharacterType: "Pl0000" as const },
    { actionType: { SupplementaryDamage: 100 } as ActionType, childCharacterType: "Pl0000" as const },
  ];
  // The state the toggle actually produces. One keying drives BOTH which rows
  // exist and which view they report, so there is no half-collapsed fixture to
  // set up — and no way for a test to exercise the raw view by accident.
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

  it("takes a member's merged extremes from the backend too", () => {
    // Same rule as the parent row's: under the landing model an extreme is a
    // whole landing, and this fold reports the figure it was sent.
    const child = collapsed()[0].children?.find((entry) => entry.key === "skill:Normal:100");
    expect(child?.columns[2]).toBe(humanizeNumber(55));
    expect(child?.columns[3]).toBe(humanizeNumber(190));
  });

  it("still lists the echo as its own member with the collapse off", () => {
    // Off, the echo never reaches the group bucket at all — it is its own row.
    const rows = groupRowsFor(grouped, ctx({ groupBy: "ability", keying: rowKeyingFor(everySkill, false) }));
    expect(rows.map((row) => row.key)).toEqual(['skill:Group:normal-attack@"Pl0000"', "skill:SupplementaryDamage:0"]);
    expect(rows[0].children?.map((child) => child.key)).toEqual(["skill:Normal:100", "skill:Normal:110"]);
  });
});

describe("groupRowsFor — damage facts", () => {
  const withFacts = (m: GroupMeasure, f: GroupFacts): GroupMeasure => ({ ...m, facts: f });

  it("appends the row's real crit/WP/BA rates after its own columns, and carries them on MetricRow.facts", () => {
    const rowFacts = facts({
      crit: tally({ measuredYes: 3, measuredNo: 1 }),
      weakPoint: tally({ inferredYes: 1, inferredNo: 1 }),
      backAttack: tally({ unknown: 5 }),
    });
    const rows = groupRowsFor(
      [agg({ kind: "player", index: 0 }, withFacts(measure(1000, 4), rowFacts))],
      ctx({ groupBy: "source" })
    );
    // amount, rate, share, then crit% (75%), WP% (50%~, all inferred), BA% (—, nothing counted).
    expect(rows[0].columns.slice(3)).toEqual(["75%", "50%~", "—"]);
    expect(rows[0].facts).toEqual(rowFacts);
  });

  it("leaves facts absent, and the trailing cells dashes, where the aggregate carries none", () => {
    const rows = groupRowsFor([agg({ kind: "player", index: 0 }, measure(1000, 4))], ctx({ groupBy: "source" }));
    expect(rows[0].facts).toBeUndefined();
    expect(rows[0].columns.slice(3)).toEqual(["—", "—", "—"]);
  });

  it("never appends fact cells to a taken row, even if its measure carried them", () => {
    // Defensive: `GroupMeasure.facts` is documented absent on taken rows, but
    // the column fold must not lean on that alone — it gates on the METRIC.
    const rows = groupRowsFor(
      [agg({ kind: "player", index: 0 }, withFacts(measure(1000, 4), facts()))],
      ctx({ metric: "taken", groupBy: "source" })
    );
    expect(rows[0].columns).toHaveLength(3);
  });

  it("sums sibling members' facts field-wise into the group parent", () => {
    // Sibling-action summing IS the same aggregation a single row's own facts
    // already are — a skill group is several backend keys folding into one row.
    const grouped = [
      agg(
        { kind: "friendlyAbility", actionType: { Normal: 100 }, childCharacterType: "Pl0000" },
        withFacts(measure(300, 3), facts({ crit: tally({ measuredYes: 2, measuredNo: 1 }), overdriveDamage: 100 }))
      ),
      agg(
        { kind: "friendlyAbility", actionType: { Normal: 110 }, childCharacterType: "Pl0000" },
        withFacts(measure(100, 1), facts({ crit: tally({ measuredYes: 1 }), overdriveDamage: 50, breakDamage: 20 }))
      ),
    ];
    const [parent] = groupRowsFor(grouped, ctx({ groupBy: "ability" }));
    expect(parent.facts?.crit).toEqual(tally({ measuredYes: 3, measuredNo: 1 }));
    expect(parent.facts?.overdriveDamage).toBe(150);
    expect(parent.facts?.breakDamage).toBe(20);
  });

  it("keeps the one side present when only one sibling carries facts", () => {
    const grouped = [
      agg(
        { kind: "friendlyAbility", actionType: { Normal: 100 }, childCharacterType: "Pl0000" },
        withFacts(measure(300, 3), facts({ crit: tally({ measuredYes: 2 }) }))
      ),
      agg({ kind: "friendlyAbility", actionType: { Normal: 110 }, childCharacterType: "Pl0000" }, measure(100, 1)),
    ];
    const [parent] = groupRowsFor(grouped, ctx({ groupBy: "ability" }));
    expect(parent.facts?.crit).toEqual(tally({ measuredYes: 2 }));
  });

  it("stays absent when neither sibling carries facts", () => {
    const grouped = [
      agg({ kind: "friendlyAbility", actionType: { Normal: 100 }, childCharacterType: "Pl0000" }, measure(300, 3)),
      agg({ kind: "friendlyAbility", actionType: { Normal: 110 }, childCharacterType: "Pl0000" }, measure(100, 1)),
    ];
    const [parent] = groupRowsFor(grouped, ctx({ groupBy: "ability" }));
    expect(parent.facts).toBeUndefined();
  });

  it("keeps each member's own facts distinct from its siblings'", () => {
    const grouped = [
      agg(
        { kind: "friendlyAbility", actionType: { Normal: 100 }, childCharacterType: "Pl0000" },
        withFacts(measure(300, 3), facts({ crit: tally({ measuredYes: 2 }) }))
      ),
      agg(
        { kind: "friendlyAbility", actionType: { Normal: 110 }, childCharacterType: "Pl0000" },
        withFacts(measure(100, 1), facts({ crit: tally({ measuredNo: 1 }) }))
      ),
    ];
    const [parent] = groupRowsFor(grouped, ctx({ groupBy: "ability" }));
    const member100 = parent.children?.find((child) => child.key === "skill:Normal:100");
    const member110 = parent.children?.find((child) => child.key === "skill:Normal:110");
    expect(member100?.facts?.crit).toEqual(tally({ measuredYes: 2 }));
    expect(member110?.facts?.crit).toEqual(tally({ measuredNo: 1 }));
  });

  it("reads facts off the RAW measure even when the collapse reports the landing view", () => {
    // The merged view never carries facts (see `GroupFacts`'s doc) — the fact
    // cells must not go blank just because the reader turned Merge Sup DMG on.
    const rowFacts = facts({ crit: tally({ measuredYes: 1 }) });
    const rows = groupRowsFor(
      [agg({ kind: "player", index: 0 }, withFacts(measure(1000, 4), rowFacts), merged(1300, 4, null, null, 300))],
      ctx({ groupBy: "source", keying: rowKeyingFor([], true) })
    );
    // The amount reports the merged view (1300, not 1000) while the fact cell
    // still reads.
    expect(rows[0].value).toBe(1300);
    expect(rows[0].columns[3]).toBe("100%");
  });
});
