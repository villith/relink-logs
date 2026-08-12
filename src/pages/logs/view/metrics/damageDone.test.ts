import { describe, expect, it } from "vitest";

import type { ComputedPlayerState, EnemyType, SkillState, SkillTargetState } from "@/types";

import { groupSkillsForRows, rowKeyingFor } from "../abilitySkills";
import { parseEnemyRow } from "../rowKey";
import type { SelectorPins } from "../selectorOptions";
import { abilityRows, damageDone } from "./damageDone";
import type { MetricRow } from "./types";

/** A per-enemy entry of a skill's breakdown, as the parser ships it. */
const hit = (enemyType: EnemyType, totalDamage: number, hits: number): SkillTargetState => ({
  enemyType,
  totalDamage,
  hits,
});

const player = (
  index: number,
  total: number,
  skills: {
    action: number;
    damage: number;
    child?: string;
    hits?: number;
    min?: number | null;
    max?: number | null;
    targets?: SkillTargetState[];
  }[]
) =>
  ({
    index,
    partyIndex: index,
    characterType: "Pl0000",
    totalDamage: total,
    dps: total / 10,
    percentage: 0,
    sba: 0,
    totalStunValue: 0,
    stunPerSecond: 0,
    lastDamageTime: 0,
    cappedHits: 0,
    cappableHits: 0,
    overcapBaseSum: 0,
    overcapCapSum: 0,
    skillBreakdown: skills.map((s) => ({
      actionType: { Normal: s.action },
      childCharacterType: s.child ?? "Pl0000",
      hits: s.hits ?? 1,
      minDamage: s.min === undefined ? s.damage : s.min,
      maxDamage: s.max === undefined ? s.damage : s.max,
      totalDamage: s.damage,
      totalStunValue: 0,
      maxStunValue: 0,
      cappedHits: 0,
      cappableHits: 0,
      overcapBaseSum: 0,
      overcapCapSum: 0,
      // Left absent unless a case asks for it: `targets` is optional on
      // SkillState because cached payloads predate it, and the fallback for a
      // payload without one is a behaviour worth keeping covered.
      ...(s.targets ? { targets: s.targets } : {}),
    })),
  }) as unknown as ComputedPlayerState;

const PLAYERS = [
  player(0, 300, [
    { action: 9001, damage: 200 },
    { action: 9002, damage: 100 },
  ]),
  player(1, 100, []),
];

const NO_PINS: SelectorPins = { source: null, targets: [], ability: null };

const input = (
  level: "players" | "abilities" | "skills",
  pins: SelectorPins = NO_PINS,
  players: ComputedPlayerState[] = PLAYERS
) =>
  ({
    encounter: { totalDamage: 400 } as never,
    partyData: [null, null],
    players,
    level,
    pins,
  }) as never;

describe("damageDone descriptor", () => {
  it("gives one row per player at the players level, biggest first", () => {
    const rows = damageDone.rows(input("players"));
    expect(rows).toHaveLength(2);
    expect(rows[0].value).toBe(300);
    expect(rows[1].value).toBe(100);
  });

  it("makes a player row pin that player as the source", () => {
    const rows = damageDone.rows(input("players"));
    expect(rows[0].pinOnClick).toEqual({ source: 0 });
  });

  it("gives the pinned player's abilities at the abilities level", () => {
    const rows = damageDone.rows(input("abilities", { source: 0, targets: [], ability: null }));
    expect(rows.map((r) => r.value)).toEqual([200, 100]);
    expect(rows[0].pinOnClick).toEqual({ ability: "Normal:9001" });
  });

  it("returns no rows when the pinned source has no data", () => {
    const rows = damageDone.rows(input("abilities", { source: 99, targets: [], ability: null }));
    expect(rows).toEqual([]);
  });

  it("swaps the second column header when it descends a level", () => {
    // The column carries DPS for players and a hit count for abilities, so the
    // header cannot be fixed.
    expect(damageDone.columnKeys("players")).not.toEqual(damageDone.columnKeys("abilities"));
  });

  it("tags each player row with its party slot", () => {
    const rows = damageDone.rows(input("players"));
    expect(rows.map((r) => r.colorSlot)).toEqual([0, 1]);
  });

  it("tags every ability row with the pinned player's slot", () => {
    // All of one player's abilities are that player's colour — the rows are a
    // breakdown of one bar, not four.
    const rows = damageDone.rows(input("abilities", { source: 0, targets: [], ability: null }));
    expect(rows.every((r) => r.colorSlot === 0)).toBe(true);
  });

  it("sums abilities that share an action id into one row", () => {
    // skill_breakdown is keyed by (action, child character type), so a player
    // and their summon using one action id are two rows sharing an abilityKey.
    // Mapping them 1:1 drew the ability twice with its damage split, and handed
    // React two children with the same key. Same defect 68e148c fixed in the
    // hover card.
    const withSummon = [
      player(0, 300, [
        { action: 9001, damage: 120, hits: 3 },
        { action: 9001, damage: 80, child: "Wp0000", hits: 2 },
        { action: 9002, damage: 100 },
      ]),
    ];
    const rows = damageDone.rows(input("abilities", { source: 0, targets: [], ability: null }, withSummon));

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
    expect(rows[0].value).toBe(200);
    // Hits sum too, or the row reports one contributor's count against both
    // contributors' damage.
    expect(rows[0].columns[1]).toBe("5");
  });

  it("condenses a character's skills into groups, like the classic view does", () => {
    // Against the REAL shipped table: Gran's 100/110/120 are "normal-attack"
    // and 200/201 are "power-raise". Listing every raw action is what made the
    // ability list 27 rows deep where Classic shows a handful.
    const owner = [
      player(0, 300, [
        { action: 100, damage: 30 },
        { action: 110, damage: 20 },
        { action: 120, damage: 10 },
        { action: 200, damage: 40 },
        { action: 201, damage: 5 },
      ]),
    ];
    const rows = damageDone.rows(input("abilities", { source: 0, targets: [], ability: null }, owner));

    expect(rows).toHaveLength(2);
    // Biggest first: normal-attack's 60 over power-raise's 45.
    expect(rows[0].value).toBe(60);
    expect(rows[1].value).toBe(45);
    // Pinning a group row pins the group, not one of its members.
    expect(rows[0].pinOnClick).toEqual({ ability: 'Group:normal-attack@"Pl0000"' });
  });

  it("carries min, max and average per ability", () => {
    // These used to sit in the hover card as a fourth "share of a maximum" list,
    // which meant nothing. A column header gives them their meaning back.
    const owner = [player(0, 300, [{ action: 9001, damage: 1000, hits: 4, min: 100, max: 500 }])];
    const rows = damageDone.rows(input("abilities", { source: 0, targets: [], ability: null }, owner));

    expect(damageDone.columnKeys("abilities")).toEqual([
      "ui.skill-columns.total",
      "ui.skill-columns.hits",
      "ui.skill-columns.min",
      "ui.skill-columns.max",
      "ui.skill-columns.average",
      "ui.logs.column-share",
    ]);
    expect(rows[0].columns).toEqual(["1.0k", "4", "100", "500", "250", "333.3%"]);
  });

  it("takes the extremes across every skill behind one ability", () => {
    const owner = [
      player(0, 300, [
        { action: 9001, damage: 200, hits: 2, min: 80, max: 120 },
        { action: 9001, damage: 300, hits: 2, min: 40, max: 260, child: "Wp0000" },
      ]),
    ];
    const rows = damageDone.rows(input("abilities", { source: 0, targets: [], ability: null }, owner));

    // Smallest and largest single hit either landed — not the smallest minimum
    // of one contributor alone.
    expect(rows[0].columns.slice(2, 5)).toEqual(["40", "260", "125"]);
  });

  it("shows a dash rather than a zero when a log predates the min/max fields", () => {
    const owner = [player(0, 300, [{ action: 9001, damage: 200, hits: 2, min: null, max: null }])];
    const rows = damageDone.rows(input("abilities", { source: 0, targets: [], ability: null }, owner));

    // A null is "not recorded", and rendering it as 0 claims a hit landed for
    // nothing. The average is still derivable from total and hits.
    expect(rows[0].columns.slice(2, 5)).toEqual(["—", "—", "100"]);
  });

  it("lists a pinned group's member skills at the skills level", () => {
    // The scoped fetch has already narrowed the party to the pinned group's
    // member actions, so these ARE its members: 100/110/120 are all
    // "normal-attack" in the shipped table, and this level is what shows that.
    const owner = [
      player(0, 60, [
        { action: 100, damage: 30 },
        { action: 110, damage: 20 },
        { action: 120, damage: 10 },
      ]),
    ];
    const rows = damageDone.rows(
      input("skills", { source: 0, targets: [], ability: 'Group:normal-attack@"Pl0000"' }, owner)
    );

    expect(rows.map((r) => r.key)).toEqual(["skill:Normal:100", "skill:Normal:110", "skill:Normal:120"]);
    expect(rows.map((r) => r.value)).toEqual([30, 20, 10]);
  });

  it("offers no pin at the skills level", () => {
    // Display only: there is nothing below a member skill to descend into.
    const owner = [player(0, 30, [{ action: 100, damage: 30 }])];
    const rows = damageDone.rows(
      input("skills", { source: 0, targets: [], ability: 'Group:normal-attack@"Pl0000"' }, owner)
    );

    expect(rows.every((r) => r.pinOnClick === null)).toBe(true);
  });

  it("shows one row for a pinned ungrouped ability", () => {
    // Link Attack and SBA never group. One row, itself, is the honest answer.
    const owner = [player(0, 40, [{ action: 9001, damage: 40 }])];
    const rows = damageDone.rows(input("skills", { source: 0, targets: [], ability: "Normal:9001" }, owner));

    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("skill:Normal:9001");
  });

  it("merges a member dealt by a player and their summon into one row", () => {
    const owner = [
      player(0, 50, [
        { action: 100, damage: 30, hits: 2 },
        { action: 100, damage: 20, hits: 1, child: "Wp0000" },
      ]),
    ];
    const rows = damageDone.rows(
      input("skills", { source: 0, targets: [], ability: 'Group:normal-attack@"Pl0000"' }, owner)
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(50);
    expect(rows[0].columns[1]).toBe("3");
  });

  it("sums every player's breakdown when an ability is pinned with no friendly", () => {
    // The scoped fetch sends sourceIndices: [] with the ability filter intact,
    // so the state is correct and complete — only the row builder refused to
    // read it, and the table claimed nothing matched.
    const party = [
      player(0, 30, [{ action: 100, damage: 30, hits: 2 }]),
      player(1, 20, [{ action: 100, damage: 20, hits: 1 }]),
    ];
    const rows = damageDone.rows(
      input("skills", { source: null, targets: [], ability: 'Group:normal-attack@"Pl0000"' }, party)
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(50);
    expect(rows[0].columns[1]).toBe("3");
  });

  it("shares against the whole party's total when no friendly is pinned", () => {
    const party = [player(0, 30, [{ action: 100, damage: 30 }]), player(1, 10, [{ action: 110, damage: 10 }])];
    const rows = damageDone.rows(
      input("skills", { source: null, targets: [], ability: 'Group:normal-attack@"Pl0000"' }, party)
    );

    expect(rows[0].columns.at(-1)).toBe("75.0%");
    expect(rows[1].columns.at(-1)).toBe("25.0%");
  });

  it("gives a party-wide row no party colour", () => {
    // A row summed across players belongs to no one slot; the table renders a
    // negative slot in its neutral ink.
    const party = [player(0, 30, [{ action: 100, damage: 30 }]), player(1, 20, [{ action: 100, damage: 20 }])];
    const rows = damageDone.rows(
      input("skills", { source: null, targets: [], ability: 'Group:normal-attack@"Pl0000"' }, party)
    );

    expect(rows[0].colorSlot).toBe(-1);
  });

  it("still returns nothing when a pinned source has no data", () => {
    // A source that IS pinned but absent from the scoped party is a different
    // case from no source at all, and must stay empty.
    expect(damageDone.rows(input("skills", { source: 99, targets: [], ability: "Normal:100" }))).toEqual([]);
  });

  it("carries the share of the level's total as its last column", () => {
    const rows = damageDone.rows(input("players"));
    expect(rows[0].columns.at(-1)).toBe("75.0%");
    expect(rows[1].columns.at(-1)).toBe("25.0%");
  });
});

describe("drilling a pinned ability with a friendly pinned", () => {
  // The pinned row's own enemies, as the scoped fetch leaves them: one action,
  // hit on two enemy types.
  const soloAction = (targets = [hit("Em1000", 90, 3), hit("Em2000", 30, 1)]) => [
    player(0, 120, [{ action: 100, damage: 120, hits: 4, min: 10, max: 60, targets }]),
  ];

  const drill = (players: ComputedPlayerState[]) =>
    damageDone.rows(input("skills", { source: 0, targets: [], ability: "Normal:100" }, players));

  it("lists the group's members when the pinned row was a group", () => {
    // Two actions behind the row means it condensed several — those ARE the
    // decomposition, so the enemies stay one level further down.
    const grouped = [
      player(0, 120, [
        { action: 100, damage: 90, hits: 3, targets: [hit("Em1000", 90, 3)] },
        { action: 101, damage: 30, hits: 1, targets: [hit("Em1000", 30, 1)] },
      ]),
    ];
    const rows = damageDone.rows(
      input("skills", { source: 0, targets: [], ability: 'Group:normal-attack@"Pl0000"' }, grouped)
    );

    expect(rows.map((row) => row.key)).toEqual(["skill:Normal:100", "skill:Normal:101"]);
    expect(rows.every((row) => row.kind === undefined)).toBe(true);
  });

  it("lists the enemies hit when the pinned row was a single ability", () => {
    // Restating one action as one row says nothing the row above it did not.
    const rows = drill(soloAction());

    expect(rows.map((row) => row.kind)).toEqual(["enemy", "enemy"]);
    expect(rows.map((row) => parseEnemyRow(row.label))).toEqual(["Em1000", "Em2000"]);
  });

  it("reports each enemy's damage, hits, average and share", () => {
    const [top, second] = drill(soloAction());

    // Total, hits, min, max, average, share — the same six the member rows
    // fill, so both shapes line up under one header.
    expect(top.columns).toEqual(["90", "3", "—", "—", "30", "75.0%"]);
    expect(second.columns).toEqual(["30", "1", "—", "—", "30", "25.0%"]);
  });

  it("leaves the per-enemy extremes blank rather than borrowing the ability's", () => {
    // The skill's own min/max (10/60) describe hits across every enemy; printing
    // them on one enemy's row would claim a spread that was never measured.
    const [top] = drill(soloAction());
    expect(top.columns[2]).toBe("—");
    expect(top.columns[3]).toBe("—");
  });

  it("sums same-type spawns into one row and adds their hits", () => {
    const rows = drill(soloAction([hit("Em1000", 50, 2), hit("Em1000", 40, 1), hit("Em2000", 30, 1)]));

    expect(rows).toHaveLength(2);
    expect(rows[0].columns.slice(0, 2)).toEqual(["90", "3"]);
  });

  it("keeps every Unknown enemy on its own row", () => {
    // JSON, not String(): every Unknown variant stringifies to "[object
    // Object]" and would collapse into a single unnamed row.
    const rows = drill(soloAction([hit({ Unknown: 1 }, 60, 1), hit({ Unknown: 2 }, 60, 1)]));

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => parseEnemyRow(row.label))).toEqual([{ Unknown: 1 }, { Unknown: 2 }]);
  });

  it("pins nothing, because a type cannot choose between two spawns", () => {
    expect(drill(soloAction()).every((row) => row.pinOnClick === null)).toBe(true);
  });

  it("falls back to the single ability row when the payload has no enemies", () => {
    // A log saved before SkillState.targets existed. An empty table would claim
    // the ability hit nothing.
    const rows = drill([player(0, 120, [{ action: 100, damage: 120, hits: 4 }])]);

    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("skill:Normal:100");
    expect(rows[0].kind).toBeUndefined();
  });

  it("keeps summing across the party when no friendly is pinned", () => {
    // Without an owner the row answers a different question, and the per-enemy
    // breakdown cannot say who dealt which part of it.
    const party = [
      player(0, 30, [{ action: 100, damage: 30, targets: [hit("Em1000", 30, 1)] }]),
      player(1, 20, [{ action: 100, damage: 20, targets: [hit("Em1000", 20, 1)] }]),
    ];
    const rows = damageDone.rows(input("skills", { source: null, targets: [], ability: "Normal:100" }, party));

    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("skill:Normal:100");
  });
});

const victimPlayer = (index: number, breakdown: { enemy: number; total: number }[]) =>
  ({
    index,
    partyIndex: index,
    characterType: "Pl0000",
    totalDamage: 0,
    dps: 0,
    percentage: 0,
    sba: 0,
    totalStunValue: 0,
    stunPerSecond: 0,
    lastDamageTime: 0,
    cappedHits: 0,
    cappableHits: 0,
    overcapBaseSum: 0,
    overcapCapSum: 0,
    skillBreakdown: [],
    damageTakenBreakdown: breakdown.map((row) => ({
      enemyType: { Unknown: row.enemy },
      actionId: { Normal: 1 },
      hits: 1,
      totalDamage: row.total,
      maxDamage: row.total,
    })),
  }) as unknown as ComputedPlayerState;

describe("damageDone enemy side", () => {
  it("ranks enemy types by damage dealt to the party", () => {
    const players = [
      victimPlayer(0, [{ enemy: 0xaa, total: 500 }]),
      victimPlayer(1, [
        { enemy: 0xaa, total: 300 },
        { enemy: 0xbb, total: 100 },
      ]),
    ];

    const rows = damageDone.rows({
      encounter: { totalDamage: 0 } as never,
      partyData: [null, null],
      players,
      level: "players",
      pins: { source: null, targets: [], ability: null },
      fightDurationMs: 100_000,
      hostility: "enemy",
    } as never);

    expect(rows.map((row) => row.key)).toEqual([
      `enemy:${JSON.stringify({ Unknown: 0xaa })}`,
      `enemy:${JSON.stringify({ Unknown: 0xbb })}`,
    ]);
    expect(rows[0].kind).toBe("enemy");
    expect(rows[0].value).toBe(800);
    // Amount, DPS-to-party over the 100s window, share.
    expect(rows[0].columns).toEqual(["800", "8", "88.9%"]);
    expect(rows[0].pinOnClick).toBeNull();
  });

  it("shows nothing on the enemy side of a log with no incoming events recorded", () => {
    const rows = damageDone.rows({
      encounter: { totalDamage: 0 } as never,
      partyData: [null, null],
      players: [victimPlayer(0, [])],
      level: "players",
      pins: { source: null, targets: [], ability: null },
      fightDurationMs: 100_000,
      hostility: "enemy",
    } as never);

    expect(rows).toEqual([]);
  });

  it("fills the full six-column drill-down shape below the players level", () => {
    const players = [
      victimPlayer(0, [{ enemy: 0xaa, total: 500 }]),
      victimPlayer(1, [
        { enemy: 0xaa, total: 300 },
        { enemy: 0xbb, total: 100 },
      ]),
    ];

    const rows = damageDone.rows({
      encounter: { totalDamage: 0 } as never,
      partyData: [null, null],
      players,
      level: "abilities",
      pins: { source: null, targets: [], ability: null },
      fightDurationMs: 100_000,
      hostility: "enemy",
    } as never);

    expect(rows[0].columns).toHaveLength(6);
    // min is blank: DamageTakenState carries no minimum.
    expect(rows[0].columns[2]).toBe("—");
    // max folds across both victims' rows for 0xaa (500, 300) to the larger.
    expect(rows[0].columns[3]).toBe("500");
  });
});

describe("damageDone.children — party-wide per-source split", () => {
  const abilityRow = (key: string): MetricRow => ({
    key,
    label: key.replace(/^skill:/, ""),
    kind: "ability",
    value: 0,
    columns: [],
    pinOnClick: null,
    colorSlot: -1,
  });

  const childrenOf = (
    key: string,
    players: ComputedPlayerState[],
    pins: SelectorPins = NO_PINS,
    hostility?: "friendly" | "enemy",
    level: "players" | "abilities" | "skills" = "abilities"
  ) => damageDone.children!({ row: abilityRow(key), players, level, pins, hostility, fightDurationMs: 100_000 });

  const party = [
    player(0, 300, [
      { action: 9001, damage: 200, hits: 2, min: 50, max: 150 },
      { action: 9002, damage: 100 },
    ]),
    player(1, 100, [{ action: 9001, damage: 100, hits: 1, min: 100, max: 100 }]),
  ];

  it("splits a party-wide ability row into one child per player who used it", () => {
    const children = childrenOf("skill:Normal:9001", party)!;

    expect(children.map((child) => child.key)).toEqual(["player:0", "player:1"]);
    expect(children.map((child) => child.kind)).toEqual(["player", "player"]);
    expect(children[0].pinOnClick).toEqual({ source: 0 });
    expect(children.map((child) => child.colorSlot)).toEqual([0, 1]);
    // The six damage drill-down cells, shared against the party total (400).
    expect(children[0].columns).toEqual(["200", "2", "50", "150", "100", "50.0%"]);
    expect(children[1].columns).toEqual(["100", "1", "100", "100", "100", "25.0%"]);
  });

  it("carries each player's own echo share, so a child bar splits like its parent", () => {
    // The nested rows are table bars too — a child that folded an echo must
    // draw the same two-segment fill the parent above it does.
    const withEcho = [
      {
        ...party[0],
        skillBreakdown: [
          ...party[0].skillBreakdown,
          {
            ...party[0].skillBreakdown[0],
            actionType: { SupplementaryDamage: 9001 },
            totalDamage: 60,
            hits: 3,
          },
        ],
      } as ComputedPlayerState,
      party[1],
    ];
    const keying = rowKeyingFor(
      withEcho.flatMap((entry) => entry.skillBreakdown),
      true
    );
    const children = damageDone.children!({
      row: abilityRow("skill:Normal:9001"),
      players: withEcho,
      level: "abilities",
      pins: NO_PINS,
      fightDurationMs: 100_000,
      keying,
    })!;

    // Player 0 dealt the echo, player 1 did not.
    expect(children[0].value).toBe(260);
    expect(children[0].subValue).toBe(60);
    expect(children[1].subValue).toBeUndefined();
    // Its extremes still describe the named skill's own hits.
    expect(children[0].columns[2]).toBe("50");
    expect(children[0].columns[3]).toBe("150");
  });

  it("makes a nested child count landings, like the merged parent above it", () => {
    // The parent rows come from the group aggregates and the children from the
    // derived state, so a child still counting events contradicts the very row
    // that was expanded.
    const landed = [
      {
        ...party[0],
        skillBreakdown: [
          {
            ...party[0].skillBreakdown[0],
            merged: { hits: 2, damage: 260, min: 55, max: 205, supplementary: 60 },
          },
          party[0].skillBreakdown[1],
          {
            ...party[0].skillBreakdown[0],
            actionType: { SupplementaryDamage: 9001 },
            totalDamage: 60,
            hits: 3,
            // Claimed by the landings above, so this row's landing view is empty.
            merged: { hits: 0, damage: 0, min: null, max: null, supplementary: 0 },
          },
        ],
      } as ComputedPlayerState,
      {
        ...party[1],
        skillBreakdown: [
          {
            ...party[1].skillBreakdown[0],
            merged: { hits: 1, damage: 100, min: 100, max: 100, supplementary: 0 },
          },
        ],
      } as ComputedPlayerState,
    ];
    const keying = rowKeyingFor(
      landed.flatMap((entry) => entry.skillBreakdown),
      true
    );
    const children = damageDone.children!({
      row: abilityRow("skill:Normal:9001"),
      players: landed,
      level: "abilities",
      pins: NO_PINS,
      fightDurationMs: 100_000,
      keying,
    })!;

    // Two landings worth 260, not five events — and 55..205 is neither the
    // direct half's 50..150 nor the echo's, so a locally re-derived extreme
    // fails here.
    expect(children[0].value).toBe(260);
    expect(children[0].columns.slice(0, 5)).toEqual(["260", "2", "55", "205", "130"]);
    expect(children[0].subValue).toBe(60);
    // The player who dealt no echo has no split to draw.
    expect(children[1].columns.slice(0, 5)).toEqual(["100", "1", "100", "100", "100"]);
    expect(children[1].subValue).toBeUndefined();
  });

  it("sums a group parent's members per player", () => {
    // Against the REAL table: Gran's 100/110/120 are all "normal-attack".
    const grouped = [
      player(0, 50, [
        { action: 100, damage: 30 },
        { action: 110, damage: 20 },
      ]),
      player(1, 10, [{ action: 120, damage: 10 }]),
    ];
    const children = childrenOf('skill:Group:normal-attack@"Pl0000"', grouped)!;

    expect(children.map((child) => child.key)).toEqual(["player:0", "player:1"]);
    expect(children.map((child) => child.value)).toEqual([50, 10]);
  });

  it("answers null with a source pinned — the parent already carries its variants", () => {
    expect(childrenOf("skill:Normal:9001", party, { source: 0, targets: [], ability: null })).toBeNull();
  });

  it("answers null on the enemy side — incoming rows carry no spawn identity", () => {
    expect(childrenOf("skill:Normal:9001", party, NO_PINS, "enemy")).toBeNull();
  });

  it("answers null off the abilities level", () => {
    expect(childrenOf("skill:Normal:9001", party, NO_PINS, undefined, "players")).toBeNull();
  });

  it("answers null for a row whose key names no ability", () => {
    expect(childrenOf("other", party)).toBeNull();
  });

  it("returns a lone user as a single child — the table hides the chevron below two", () => {
    expect(childrenOf("skill:Normal:9002", party)).toHaveLength(1);
  });
});

describe("abilityRows — supplementary collapse", () => {
  const breakdown = [
    {
      actionType: { Normal: 100 },
      childCharacterType: "Pl1900",
      totalDamage: 1000,
      hits: 4,
      minDamage: 200,
      maxDamage: 300,
      // The LANDING view of the same hits: four landings carrying the three
      // echo ticks, so its extremes are whole landings — 250..400 is neither
      // the direct half's 200..300 nor the echo's 90..110, which is what makes
      // a fold that re-derived them locally fail here.
      merged: { hits: 4, damage: 1300, min: 250, max: 400, supplementary: 300 },
    },
    {
      actionType: { SupplementaryDamage: 100 },
      childCharacterType: "Pl1900",
      totalDamage: 300,
      hits: 3,
      minDamage: 90,
      maxDamage: 110,
      // Every tick claimed: that damage now sits on the trigger above, so the
      // echo row's own landing view is empty.
      merged: { hits: 0, damage: 0, min: null, max: null, supplementary: 0 },
    },
  ] as unknown as SkillState[];

  const rowsWith = (collapse: boolean, rows: SkillState[] = breakdown) =>
    abilityRows(groupSkillsForRows(rows, rowKeyingFor(rows, collapse)), 1300, 0, true, collapse);

  it("adds the echo's damage and hits to its cause, and reports the split", () => {
    // The KEYING fold alone, with the landing view off: both halves land on one
    // row and the row still counts events.
    const rows = abilityRows(groupSkillsForRows(breakdown, rowKeyingFor(breakdown, true)), 1300, 0, true, false);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(1300);
    expect(rows[0].subValue).toBe(300);
    // hits column is index 1 — direct 4 plus echo 3.
    expect(rows[0].columns[1]).toBe("7");
  });

  it("counts landings, not events, with the merge on", () => {
    const rows = rowsWith(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(1300);
    // total, hits, min, max, average. Four landings, not seven events — and
    // the extremes are the backend's own, verbatim.
    expect(rows[0].columns.slice(0, 5)).toEqual(["1.3k", "4", "250", "400", "325"]);
  });

  it("keeps Avg inside Min..Max and equal to Total over Hits", () => {
    // The two invariants the event count broke: a row read Total 247.2k over
    // 2 hits with Min = Max = 154.5k, an average below its own minimum.
    const [total, hits, min, max, avg] = rowsWith(true)[0].columns;
    expect(total).toBe("1.3k");
    expect(Number(hits)).toBe(4);
    expect(avg).toBe(String(Math.round(1300 / 4)));
    expect(Number(min)).toBeLessThanOrEqual(Number(avg));
    expect(Number(avg)).toBeLessThanOrEqual(Number(max));
  });

  it("draws the echo split from the backend's own figure", () => {
    // Read, never inferred from bucket membership: the echo row's landing view
    // is empty, so a fold that looked for an echo among these skills would find
    // no damage at all and draw one flat bar over a row that is 300 echo.
    expect(rowsWith(true)[0].subValue).toBe(300);
  });

  it("draws no split when the backend reports no echo inside the landing", () => {
    // The companion the test above needs to discriminate: the one fixture
    // change is the cause's `supplementary`, zeroed. A membership test would
    // still find the echo row's raw 300 sitting in this bucket and paint a
    // segment for damage the backend says is not there.
    const claimedNothing = [
      { ...breakdown[0], merged: { hits: 4, damage: 1300, min: 250, max: 400, supplementary: 0 } },
      breakdown[1],
    ] as unknown as SkillState[];
    expect(rowsWith(true, claimedNothing)[0].subValue).toBeUndefined();
  });

  it("adds an unpaired echo's residue as damage, never as a landing of its own", () => {
    // One of the four ticks never found its trigger (`supp_pairing` leaves
    // 0.54% unpaired), so the backend reports it as a landing — right for the
    // echo ROW, wrong once the collapse moves it onto its cause. Its damage
    // belongs to the row; its hit does not, and Eustace's 360 normal attacks
    // read 361 with the merge on (log 2586).
    const partly = [
      breakdown[0],
      {
        ...breakdown[1],
        totalDamage: 330,
        hits: 4,
        merged: { hits: 1, damage: 30, min: 30, max: 30, supplementary: 30 },
      },
    ] as unknown as SkillState[];
    const [row] = rowsWith(true, partly);
    expect(row.value).toBe(1330);
    // total, hits, min, max, average. Four landings — and 250 rather than the
    // residue's 30, which is a fragment of a landing already counted here.
    expect(row.columns.slice(0, 5)).toEqual(["1.3k", "4", "250", "400", String(Math.round(1330 / 4))]);
    expect(row.subValue).toBe(330);
  });

  it("mounts no split on a row that is echo all the way across", () => {
    // An unclaimed echo: the backend reports the whole of it as supplementary,
    // and painting the entire bar in the fainter shade would say nothing its
    // own label does not.
    const orphan = [
      {
        actionType: { SupplementaryDamage: 4242 },
        childCharacterType: "Pl1900",
        totalDamage: 300,
        hits: 3,
        minDamage: 90,
        maxDamage: 110,
        merged: { hits: 3, damage: 300, min: 90, max: 110, supplementary: 300 },
      },
    ] as unknown as SkillState[];
    expect(rowsWith(true, orphan)[0].subValue).toBeUndefined();
    // And it keeps its own landings: there is no cause row here reporting them
    // already, so a row of damage over no hits would divide by nothing.
    expect(rowsWith(true, orphan)[0].columns[1]).toBe("3");
  });

  it("falls back to the raw figures when the payload carries no merged measure", () => {
    // A backend older than the field sends none. Summing what is not there
    // would report a row of zeros, which is worse than reporting unmerged
    // figures.
    const legacy = breakdown.map((skill) => {
      const copy = { ...skill };
      delete copy.merged;
      return copy;
    });
    const rows = rowsWith(true, legacy);
    expect(rows[0].value).toBe(1300);
    // Events, and extremes spanning BOTH halves: min 90 is an echo tick, which
    // the old direct-only narrowing would have hidden. Accepted on this
    // degraded path and pinned here so it reads as a decision, not an
    // oversight — see the raw branch's comment in `damageCells`.
    expect(rows[0].columns.slice(0, 5)).toEqual(["1.3k", "7", "90", "300", "186"]);
  });

  it("reports raw hits for a row the landing pass never walked", () => {
    // The landing pass walks DAMAGE events, so a row opened by something else
    // carries an all-zero landing view beside real hits. Reporting that view
    // verbatim would say the guard never happened; only an ECHO row is
    // legitimately empty here, and this one has no echo to have folded away.
    const guarded = [
      {
        actionType: "PerfectGuard",
        childCharacterType: "Pl1900",
        totalDamage: 0,
        hits: 3,
        minDamage: 0,
        maxDamage: 0,
        merged: { hits: 0, damage: 0, min: null, max: null, supplementary: 0 },
      },
    ] as unknown as SkillState[];
    expect(rowsWith(true, guarded)[0].columns[1]).toBe("3");
  });

  it("still reports the empty landing view of a fully claimed echo row", () => {
    // The discriminating companion: same all-zero measure, but its damage was
    // claimed by a trigger that is already reporting it. Falling back to the raw
    // figures here would draw 300 twice under the collapse.
    const claimed = [breakdown[1]];
    const [row] = rowsWith(true, claimed);
    expect(row.value).toBe(0);
    expect(row.columns[1]).toBe("0");
  });

  it("keeps the echo as its own row without collapsing", () => {
    const rows = rowsWith(false);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.subValue === undefined)).toBe(true);
  });

  it("is inert with the merge off", () => {
    // Every figure exactly as before: the toggle moves both the keying and the
    // view together, so with it off each row is one homogeneous half and the
    // landing measures are never read.
    const rows = rowsWith(false);
    expect(rows.map((row) => row.value)).toEqual([1000, 300]);
    expect(rows[0].columns.slice(0, 5)).toEqual(["1.0k", "4", "200", "300", "250"]);
    expect(rows[1].columns.slice(0, 5)).toEqual(["300", "3", "90", "110", "100"]);
  });
});
