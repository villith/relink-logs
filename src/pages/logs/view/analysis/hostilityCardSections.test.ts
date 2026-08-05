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

/** The same lookups with art attached. Distinguishable per section AND per
 * index, so a section fed the other one's icon fails loudly rather than
 * matching a shared placeholder. */
const iconLabels = {
  ...labels,
  sourceIcon: (index: number) => `src-icon-${index}`,
  abilityIcon: (key: string) => `ab-icon-${key}`,
};

const player = (index: number, parts: object) =>
  ({
    index,
    partyIndex: index,
    characterType: "Pl0000",
    skillBreakdown: [],
    ...parts,
  }) as unknown as ComputedPlayerState;

/** A player whose skills carry only the fields these builders read. `targets`
 * is omitted outright where the case has none — the point of that case is a
 * cached payload from before the field existed, which an empty array would not
 * reproduce. */
const dealer = (index: number, skills: { action: number; targets?: { enemy: number; total: number }[] }[]) =>
  player(index, {
    skillBreakdown: skills.map((skill) => ({
      actionType: { Normal: skill.action },
      childCharacterType: "Pl0000",
      hits: 1,
      totalDamage: 0,
      ...(skill.targets === undefined
        ? {}
        : {
            targets: skill.targets.map((target) => ({
              enemyType: { Unknown: target.enemy },
              totalDamage: target.total,
              hits: 1,
            })),
          }),
    })),
  });

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

  it("puts each victim's own art on their row, and no art on the attacks", () => {
    const players = [
      player(1, {
        damageTakenBreakdown: [
          { enemyType: { Unknown: 0xaa }, actionId: { Normal: 7 }, hits: 1, totalDamage: 400, maxDamage: 400 },
        ],
      }),
    ];

    const sections = enemyDealtCardSectionsFor({ row: enemyRow(0xaa), players, color: "red", labels: iconLabels });

    // Keyed by the player's own index, not their position in the list.
    expect(sections?.[1].entries[0].icon).toBe("src-icon-1");
    // Deliberate: every attack here belongs to the row's OWN enemy, whose
    // portrait the row above the card already shows.
    expect(sections?.[0].entries[0].icon).toBeUndefined();
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

  it("returns null for a victim nobody dealt to", () => {
    const players = [dealer(0, [{ action: 100, targets: [{ enemy: 0xbb, total: 100 }] }])];

    expect(enemyReceivedCardSectionsFor({ row: enemyRow(0xaa), players, color: "red", labels })).toBeNull();
  });

  it("tolerates a cached payload whose skills predate `targets`", () => {
    // No per-enemy breakdown at all, which means "unavailable" — not that the
    // skill hit nothing. Either way there is nothing to decompose.
    const players = [dealer(0, [{ action: 100 }])];

    expect(enemyReceivedCardSectionsFor({ row: enemyRow(0xaa), players, color: "red", labels })).toBeNull();
  });

  it("gives each section its own art — player portraits to sources, ability art to abilities", () => {
    const players = [dealer(2, [{ action: 100, targets: [{ enemy: 0xaa, total: 600 }] }])];

    const sections = enemyReceivedCardSectionsFor({ row: enemyRow(0xaa), players, color: "red", labels: iconLabels });

    expect(sections?.[0].entries[0].icon).toBe("src-icon-2");
    // The ability key, not the player index: the two lookups must not be
    // crossed, and a shared placeholder would hide it if they were.
    expect(sections?.[1].entries[0].icon).toBe("ab-icon-Normal:100");
  });
});
