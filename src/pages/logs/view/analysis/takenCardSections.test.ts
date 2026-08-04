import { describe, expect, it } from "vitest";

import type { ComputedPlayerState } from "@/types";

import type { MetricRow } from "../metrics/types";
import { takenCardSectionsFor } from "./takenCardSections";

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

  it("answers a non-player row with no card — drill rows fix every dimension", () => {
    const row: MetricRow = { ...playerRow(0), key: "taken:whatever" };
    expect(takenCardSectionsFor({ row, players: [breakdownPlayer(0, [])], color: "red", labels })).toBeNull();
  });
});
