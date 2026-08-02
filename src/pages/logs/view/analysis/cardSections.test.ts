import { describe, expect, it } from "vitest";

import type { ComputedPlayerState, EnemyType } from "@/types";

import type { MetricRow } from "../metrics/types";

import { cardSectionsFor } from "./cardSections";

const skill = (action: number, damage: number, hits: number) => ({
  actionType: { Normal: action },
  childCharacterType: "Pl1400",
  hits,
  minDamage: 10,
  maxDamage: 90,
  totalDamage: damage,
  totalStunValue: 0,
  maxStunValue: 0,
  cappedHits: 0,
  cappableHits: 0,
  overcapBaseSum: 0,
  overcapCapSum: 0,
  targets: [
    { enemyType: "Em0003", hits, totalDamage: damage * 0.8 },
    // The Unknown variant is an object, not a string — it must key distinctly
    // from every other unknown, which a naive String() would not do.
    { enemyType: { Unknown: 7 }, hits, totalDamage: damage * 0.2 },
  ],
});

const PLAYERS = [
  {
    index: 0,
    partyIndex: 0,
    characterType: "Pl1400",
    totalDamage: 300,
    skillBreakdown: [skill(9001, 200, 20), skill(9002, 100, 10)],
  },
] as unknown as ComputedPlayerState[];

/** Two players who both used 9001, for the source section — which only says
 * anything when more than one player is in scope. */
const PARTY = [
  {
    index: 0,
    partyIndex: 0,
    characterType: "Pl1400",
    totalDamage: 300,
    skillBreakdown: [skill(9001, 200, 20), skill(9002, 100, 10)],
  },
  {
    index: 1,
    partyIndex: 1,
    characterType: "Pl1400",
    totalDamage: 50,
    skillBreakdown: [skill(9001, 50, 5)],
  },
] as unknown as ComputedPlayerState[];

const LABELS = {
  ability: (key: string) => `ability:${key}`,
  enemy: (type: EnemyType) => `enemy:${typeof type === "string" ? type : `unknown-${type.Unknown}`}`,
  source: (index: number) => `player:${index}`,
  sourceColor: (index: number) => `#00${index}`,
};

const row = (key: string): MetricRow => ({
  key,
  label: "",
  value: 0,
  columns: [],
  pinOnClick: null,
  colorSlot: 0,
});

const call = (level: "players" | "abilities" | "skills", key: string) =>
  cardSectionsFor({
    row: row(key),
    level,
    players: PLAYERS,
    pins: { source: 0, targets: [], ability: null },
    color: "rgb(1,2,3)",
    labels: LABELS,
  });

const callWith = (
  level: "players" | "abilities" | "skills",
  key: string,
  pins: { source: number | null; targets: number[]; ability: string | null },
  players = PARTY
) =>
  cardSectionsFor({
    row: row(key),
    level,
    players,
    pins,
    color: "rgb(1,2,3)",
    labels: LABELS,
  });

describe("cardSectionsFor", () => {
  it("gives a player row its abilities and its targets", () => {
    const sections = call("players", "player:0");
    expect(sections?.map((s) => s.headingKey)).toEqual(["ui.logs.hover-by-ability", "ui.logs.hover-by-target"]);
  });

  it("orders a player's abilities biggest first", () => {
    const sections = call("players", "player:0");
    expect(sections?.[0].entries.map((e) => e.value)).toEqual([200, 100]);
  });

  it("sums skills that share an ability key into one row", () => {
    // The parser can emit more than one SkillState per action id, so mapping
    // 1:1 draws the same ability twice with its damage split between the rows
    // — and hands React two children with the same key. Measured live on log
    // 544: "Link Attack" and "Light Blast" both appeared twice.
    const players = [
      {
        index: 0,
        partyIndex: 0,
        characterType: "Pl1400",
        totalDamage: 300,
        skillBreakdown: [skill(9001, 200, 20), skill(9001, 50, 5), skill(9002, 50, 5)],
      },
    ] as unknown as ComputedPlayerState[];

    const sections = cardSectionsFor({
      row: row("player:0"),
      level: "players",
      players,
      pins: { source: 0, targets: [], ability: null },
      color: "rgb(1,2,3)",
      labels: LABELS,
    });

    const abilities = sections?.[0].entries ?? [];
    expect(abilities.map((e) => e.key)).toEqual(["Normal:9001", "Normal:9002"]);
    expect(abilities.map((e) => e.value)).toEqual([250, 50]);
  });

  it("merges a player's targets across every ability, biggest first", () => {
    // Em0003 takes 0.8 of both skills: 160 + 80. The unknown takes 0.2: 40 + 20.
    const sections = call("players", "player:0");
    expect(sections?.[1].entries).toEqual([
      { key: '"Em0003"', label: "enemy:Em0003", value: 240 },
      { key: '{"Unknown":7}', label: "enemy:unknown-7", value: 60 },
    ]);
  });

  it("keys unknown enemies apart from each other", () => {
    // String({Unknown: n}) is "[object Object]" for every n, which would merge
    // every unidentified spawn into one row.
    const players = [
      {
        index: 0,
        partyIndex: 0,
        characterType: "Pl1400",
        totalDamage: 30,
        skillBreakdown: [
          {
            ...skill(9001, 30, 3),
            targets: [
              { enemyType: { Unknown: 1 }, hits: 1, totalDamage: 20 },
              { enemyType: { Unknown: 2 }, hits: 1, totalDamage: 10 },
            ],
          },
        ],
      },
    ] as unknown as ComputedPlayerState[];

    const sections = cardSectionsFor({
      row: row("player:0"),
      level: "players",
      players,
      pins: { source: 0, targets: [], ability: null },
      color: "rgb(1,2,3)",
      labels: LABELS,
    });

    expect(sections?.[1].entries.map((e) => e.value)).toEqual([20, 10]);
  });

  it("gives an ability row its targets, and nothing else", () => {
    // No Source section: the abilities level is only reached with a source
    // already pinned, so it would always be one row at 100%. No hit-statistics
    // section either — every section here renders as a share and a bar, which
    // is meaningless over min/max/avg, so those live in the table's columns.
    const sections = call("abilities", "skill:Normal:9001");
    expect(sections?.map((s) => s.headingKey)).toEqual(["ui.logs.hover-by-target"]);
  });

  it("explains an ability with every skill behind it, not just the first", () => {
    // The row above the card sums the skills sharing an ability key, so a card
    // built from one of them describes a fraction of what the row reports.
    const players = [
      {
        index: 0,
        partyIndex: 0,
        characterType: "Pl1400",
        totalDamage: 250,
        skillBreakdown: [skill(9001, 200, 20), skill(9001, 50, 5)],
      },
    ] as unknown as ComputedPlayerState[];

    const sections = cardSectionsFor({
      row: row("skill:Normal:9001"),
      level: "abilities",
      players,
      pins: { source: 0, targets: [], ability: null },
      color: "rgb(1,2,3)",
      labels: LABELS,
    });

    // Targets merge across both, so the section totals the ability's damage.
    expect(sections?.[0].entries.reduce((sum, e) => sum + e.value, 0)).toBe(250);
  });

  it("gives an unknown skills row no card", () => {
    expect(call("skills", "skill:Normal:404")).toBeNull();
  });

  it("gives an unknown row no card", () => {
    expect(call("players", "player:99")).toBeNull();
  });
});

describe("cardSectionsFor at the skills level", () => {
  const ABILITY_ONLY = { source: null, targets: [] as number[], ability: "Normal:9001" };

  it("explains a member skill by source and then by target", () => {
    const sections = callWith("skills", "skill:Normal:9001", ABILITY_ONLY);

    expect(sections?.map((section) => section.headingKey)).toEqual([
      "ui.logs.hover-by-source",
      "ui.logs.hover-by-target",
    ]);
  });

  it("sums one action across every player who used it, biggest first", () => {
    const sections = callWith("skills", "skill:Normal:9001", ABILITY_ONLY);

    expect(sections?.[0].entries.map((entry) => entry.label)).toEqual(["player:0", "player:1"]);
    expect(sections?.[0].entries.map((entry) => entry.value)).toEqual([200, 50]);
  });

  it("colours each source entry with that player's own colour", () => {
    // The section carries one colour for all its rows, so a per-player section
    // needs the ENTRY to carry it — a party section in one colour says nothing.
    const sections = callWith("skills", "skill:Normal:9001", ABILITY_ONLY);

    expect(sections?.[0].entries.map((entry) => entry.color)).toEqual(["#000", "#001"]);
  });

  it("leaves out a player who never used the skill", () => {
    const sections = callWith("skills", "skill:Normal:9002", ABILITY_ONLY);

    expect(sections?.[0].entries.map((entry) => entry.label)).toEqual(["player:0"]);
  });

  it("still shows the source section when a friendly is pinned", () => {
    // One row at 100%. Shown anyway: Warcraft Logs does, and suppressing it
    // makes the card change shape as the friendly pin comes and goes.
    // With a friendly pinned the scoped party holds only that player, so the
    // section is a single row — which is exactly the case being kept.
    const sections = callWith("skills", "skill:Normal:9001", { source: 0, targets: [], ability: "Normal:9001" }, [
      PARTY[0],
    ]);

    expect(sections?.[0].headingKey).toBe("ui.logs.hover-by-source");
    expect(sections?.[0].entries).toHaveLength(1);
  });

  it("totals the targets across every player's copy of the skill", () => {
    const sections = callWith("skills", "skill:Normal:9001", ABILITY_ONLY);

    // 250 damage total, split 80/20 across the two target rows by the fixture.
    expect(sections?.[1].entries.reduce((sum, entry) => sum + entry.value, 0)).toBe(250);
  });

  it("returns null for a row no player's breakdown holds", () => {
    expect(callWith("skills", "skill:Normal:404", ABILITY_ONLY)).toBeNull();
  });
});
