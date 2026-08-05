import { describe, expect, it } from "vitest";

import type { ComputedPlayerState } from "@/types";

import type { MetricRow } from "../metrics/types";
import { takenAbilityCardSectionsFor, takenCardSectionsFor } from "./takenCardSections";

const breakdownPlayer = (index: number, breakdown: { enemy: number; action: number; total: number }[]) =>
  ({
    index,
    damageTakenBreakdown: breakdown.map((row) => ({
      enemyType: { Unknown: row.enemy },
      actionId: { Normal: row.action },
      hits: 1,
      totalDamage: row.total,
      maxDamage: row.total,
    })),
  }) as unknown as ComputedPlayerState;

const playerRow = (index: number): MetricRow => ({
  key: `player:${index}`,
  label: String(index),
  value: 0,
  columns: [],
  pinOnClick: null,
  colorSlot: index,
});

const labels = {
  attack: (enemyType: unknown, actionId: unknown) => `${JSON.stringify(enemyType)}:${JSON.stringify(actionId)}`,
  enemy: (type: unknown) => JSON.stringify(type),
};

describe("takenCardSectionsFor", () => {
  it("explains a player row by attack and by attacker, both sorted largest first", () => {
    const players = [
      breakdownPlayer(0, [
        { enemy: 0xaa, action: 1, total: 300 },
        { enemy: 0xaa, action: 2, total: 500 },
        { enemy: 0xbb, action: 9, total: 100 },
      ]),
    ];

    const sections = takenCardSectionsFor({ row: playerRow(0), players, color: "red", labels });

    expect(sections).toHaveLength(2);
    expect(sections?.[0].headingKey).toBe("ui.logs.hover-by-ability");
    expect(sections?.[0].entries.map((entry) => entry.value)).toEqual([500, 300, 100]);
    expect(sections?.[1].headingKey).toBe("ui.logs.hover-by-source");
    // The by-source section folds the enemy's two attacks into one entry.
    expect(sections?.[1].entries.map((entry) => entry.value)).toEqual([800, 100]);
  });

  it("answers a player with no recorded incoming hits with no card", () => {
    expect(
      takenCardSectionsFor({ row: playerRow(0), players: [breakdownPlayer(0, [])], color: "red", labels })
    ).toBeNull();
  });

  it("answers a non-player row with no card — drill rows have their own builder", () => {
    const row: MetricRow = { ...playerRow(0), key: "taken:whatever" };
    expect(takenCardSectionsFor({ row, players: [breakdownPlayer(0, [])], color: "red", labels })).toBeNull();
  });
});

describe("takenAbilityCardSectionsFor", () => {
  const attackLabel = JSON.stringify({ enemyType: { Unknown: 0xaa }, actionId: { Normal: 1 } });
  const attackRow: MetricRow = {
    key: `taken:${attackLabel}`,
    label: attackLabel,
    value: 0,
    columns: [],
    pinOnClick: null,
    colorSlot: -1,
  };
  const party = [
    breakdownPlayer(0, [
      { enemy: 0xaa, action: 1, total: 300 },
      // A different attack from the same enemy must stay out of this row.
      { enemy: 0xaa, action: 2, total: 500 },
    ]),
    breakdownPlayer(1, [{ enemy: 0xaa, action: 1, total: 100 }]),
  ];
  const victimLabels = {
    source: (index: number) => `player:${index}`,
    sourceColor: (index: number) => `#00${index}`,
  };

  it("splits a drilled attack across the victims who took it, in their colours", () => {
    const sections = takenAbilityCardSectionsFor({
      row: attackRow,
      players: party,
      source: null,
      color: "red",
      labels: victimLabels,
    });

    expect(sections?.map((section) => section.headingKey)).toEqual(["ui.logs.hover-by-source"]);
    expect(sections?.[0].entries.map((entry) => [entry.label, entry.value, entry.color])).toEqual([
      ["player:0", 300, "#000"],
      ["player:1", 100, "#001"],
    ]);
  });

  it("narrows to the pinned victim, keeping the card's shape — one row at 100%", () => {
    const sections = takenAbilityCardSectionsFor({
      row: attackRow,
      players: party,
      source: 1,
      color: "red",
      labels: victimLabels,
    });

    expect(sections?.[0].entries.map((entry) => [entry.label, entry.value])).toEqual([["player:1", 100]]);
  });

  it("answers a row that is not a taken attack with no card", () => {
    const notAttack: MetricRow = { ...attackRow, key: "player:0", label: "0" };
    expect(
      takenAbilityCardSectionsFor({ row: notAttack, players: party, source: null, color: "red", labels: victimLabels })
    ).toBeNull();
  });

  it("answers null when nobody recorded taking the attack", () => {
    expect(
      takenAbilityCardSectionsFor({
        row: attackRow,
        players: [breakdownPlayer(0, [])],
        source: null,
        color: "red",
        labels: victimLabels,
      })
    ).toBeNull();
  });

  it("answers a taken: row whose label is not the attack-JSON grammar with no card", () => {
    const garbage: MetricRow = { ...attackRow, key: "taken:garbage", label: "garbage" };
    expect(
      takenAbilityCardSectionsFor({ row: garbage, players: party, source: null, color: "red", labels: victimLabels })
    ).toBeNull();
  });

  it("keeps a breakdown entry for the same action but a DIFFERENT enemy type out of the split", () => {
    const otherEnemyParty = [
      breakdownPlayer(0, [
        { enemy: 0xaa, action: 1, total: 300 },
        // Same action id, different enemy — must not join the drilled row.
        { enemy: 0xbb, action: 1, total: 999 },
      ]),
    ];

    const sections = takenAbilityCardSectionsFor({
      row: attackRow,
      players: otherEnemyParty,
      source: null,
      color: "red",
      labels: victimLabels,
    });

    expect(sections?.[0].entries.map((entry) => [entry.label, entry.value])).toEqual([["player:0", 300]]);
  });
});
