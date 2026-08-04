import { describe, expect, it } from "vitest";

import type { ComputedPlayerState } from "@/types";

import type { MetricRow } from "../metrics/types";

import { enemyDealtCardSectionsFor, enemyReceivedCardSectionsFor } from "./hostilityCardSections";

const enemyRow = (hash: number): MetricRow => ({
  key: `enemy:${JSON.stringify({ Unknown: hash })}`,
  label: JSON.stringify({ Unknown: hash }),
  kind: "enemy",
  value: 0,
  columns: [],
  pinOnClick: null,
  colorSlot: -1,
});

const labels = {
  attack: (_enemyType: unknown, actionId: unknown) => `atk:${JSON.stringify(actionId)}`,
  ability: (key: string) => `ab:${key}`,
  source: (index: number) => `player ${index}`,
  sourceColor: () => "blue",
};

const player = (index: number, parts: object) =>
  ({
    index,
    partyIndex: index,
    characterType: "Pl0000",
    skillBreakdown: [],
    ...parts,
  }) as unknown as ComputedPlayerState;

describe("enemyDealtCardSectionsFor", () => {
  it("explains an attacker by its attacks and by its victims", () => {
    const players = [
      player(0, {
        damageTakenBreakdown: [
          { enemyType: { Unknown: 0xaa }, actionId: { Normal: 1 }, hits: 1, totalDamage: 500, maxDamage: 500 },
          { enemyType: { Unknown: 0xbb }, actionId: { Normal: 9 }, hits: 1, totalDamage: 50, maxDamage: 50 },
        ],
      }),
      player(1, {
        damageTakenBreakdown: [
          { enemyType: { Unknown: 0xaa }, actionId: { Normal: 2 }, hits: 1, totalDamage: 300, maxDamage: 300 },
        ],
      }),
    ];

    const sections = enemyDealtCardSectionsFor({ row: enemyRow(0xaa), players, color: "red", labels });

    expect(sections).toHaveLength(2);
    expect(sections?.[0].headingKey).toBe("ui.logs.hover-by-ability");
    // Only 0xaa's attacks — 0xbb's row must not leak in.
    expect(sections?.[0].entries.map((entry) => entry.value)).toEqual([500, 300]);
    expect(sections?.[1].headingKey).toBe("ui.logs.hover-by-target");
    expect(sections?.[1].entries.map((entry) => entry.label)).toEqual(["player 0", "player 1"]);
  });

  it("folds one attack across every player it hit", () => {
    const players = [
      player(0, {
        damageTakenBreakdown: [
          { enemyType: { Unknown: 0xaa }, actionId: { Normal: 7 }, hits: 1, totalDamage: 400, maxDamage: 400 },
        ],
      }),
      player(1, {
        damageTakenBreakdown: [
          { enemyType: { Unknown: 0xaa }, actionId: { Normal: 7 }, hits: 1, totalDamage: 100, maxDamage: 100 },
        ],
      }),
    ];

    const sections = enemyDealtCardSectionsFor({ row: enemyRow(0xaa), players, color: "red", labels });

    // One attack row summing both victims; the split by victim is the job of
    // the by-target section beneath it.
    expect(sections?.[0].entries).toEqual([expect.objectContaining({ label: 'atk:{"Normal":7}', value: 500 })]);
    expect(sections?.[1].entries.map((entry) => entry.value)).toEqual([400, 100]);
  });

  it("returns null for an attacker nothing recorded against", () => {
    expect(
      enemyDealtCardSectionsFor({ row: enemyRow(0xcc), players: [player(0, {})], color: "red", labels })
    ).toBeNull();
  });
});

describe("enemyReceivedCardSectionsFor", () => {
  it("explains a victim by who dealt to it and with what", () => {
    const players = [
      player(0, {
        skillBreakdown: [
          {
            actionType: { Normal: 100 },
            childCharacterType: "Pl0000",
            hits: 2,
            totalDamage: 700,
            minDamage: 1,
            maxDamage: 1,
            totalStunValue: 0,
            maxStunValue: 0,
            cappedHits: 0,
            cappableHits: 0,
            overcapBaseSum: 0,
            overcapCapSum: 0,
            targets: [
              { enemyType: { Unknown: 0xaa }, totalDamage: 600, hits: 1 },
              { enemyType: { Unknown: 0xbb }, totalDamage: 100, hits: 1 },
            ],
          },
        ],
      }),
    ];

    const sections = enemyReceivedCardSectionsFor({ row: enemyRow(0xaa), players, color: "red", labels });

    expect(sections).toHaveLength(2);
    expect(sections?.[0].headingKey).toBe("ui.logs.hover-by-source");
    expect(sections?.[0].entries).toEqual([expect.objectContaining({ label: "player 0", value: 600, color: "blue" })]);
    expect(sections?.[1].headingKey).toBe("ui.logs.hover-by-ability");
    expect(sections?.[1].entries[0].value).toBe(600);
  });
});
