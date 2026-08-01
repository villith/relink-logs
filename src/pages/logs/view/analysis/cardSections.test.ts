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
    skillBreakdown: [skill(100, 200, 20), skill(200, 100, 10)],
  },
] as unknown as ComputedPlayerState[];

const LABELS = {
  ability: (key: string) => `ability:${key}`,
  enemy: (type: EnemyType) => `enemy:${typeof type === "string" ? type : `unknown-${type.Unknown}`}`,
  text: (key: string) => key,
};

const row = (key: string): MetricRow => ({
  key,
  label: "",
  value: 0,
  columns: [],
  pinOnClick: null,
  colorSlot: 0,
});

const call = (level: "players" | "abilities" | "hits", key: string) =>
  cardSectionsFor({
    row: row(key),
    level,
    players: PLAYERS,
    pins: { source: 0, targetIds: [], ability: null },
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
        skillBreakdown: [skill(100, 200, 20), skill(100, 50, 5), skill(200, 50, 5)],
      },
    ] as unknown as ComputedPlayerState[];

    const sections = cardSectionsFor({
      row: row("player:0"),
      level: "players",
      players,
      pins: { source: 0, targetIds: [], ability: null },
      color: "rgb(1,2,3)",
      labels: LABELS,
    });

    const abilities = sections?.[0].entries ?? [];
    expect(abilities.map((e) => e.key)).toEqual(["Normal:100", "Normal:200"]);
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
            ...skill(100, 30, 3),
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
      pins: { source: 0, targetIds: [], ability: null },
      color: "rgb(1,2,3)",
      labels: LABELS,
    });

    expect(sections?.[1].entries.map((e) => e.value)).toEqual([20, 10]);
  });

  it("gives an ability row its targets and its hit distribution, and no source", () => {
    // The abilities level is only reached with a source already pinned, so a
    // Source section would always be one row at 100%.
    const sections = call("abilities", "skill:Normal:100");
    expect(sections?.map((s) => s.headingKey)).toEqual(["ui.logs.hover-by-target", "ui.logs.hover-by-hits"]);
  });

  it("reports count, min, max and average for an ability", () => {
    const sections = call("abilities", "skill:Normal:100");
    expect(sections?.[1].entries).toEqual([
      { key: "count", label: "ui.logs.hover-count", value: 20 },
      { key: "min", label: "ui.skill-columns.min", value: 10 },
      { key: "max", label: "ui.skill-columns.max", value: 90 },
      { key: "avg", label: "ui.skill-columns.average", value: 10 },
    ]);
  });

  it("gives a hit row no card", () => {
    expect(call("hits", "hit:0")).toBeNull();
  });

  it("gives an unknown row no card", () => {
    expect(call("players", "player:99")).toBeNull();
  });
});
