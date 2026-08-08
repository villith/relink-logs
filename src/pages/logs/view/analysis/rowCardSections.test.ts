import { describe, expect, it } from "vitest";

import type { ComputedPlayerState, EnemyType, TargetEntry } from "@/types";

import type { MetricCard, MetricRow } from "../metrics/types";

import { CAPABILITIES, levelFor } from "./machine/capabilities";
import type { Dimension } from "./machine/state";
import { rowCardSectionsFor, type RowCardLabels } from "./rowCardSections";

/** One enemy identity used consistently on both streams, so every builder
 * that CAN deliver has the data to. */
const ENEMY = { Unknown: 170 };
const ENEMY_JSON = JSON.stringify(ENEMY);
const ATTACK_JSON = JSON.stringify({ enemyType: ENEMY, actionId: { Normal: 7 } });

const PLAYERS = [
  {
    index: 0,
    partyIndex: 0,
    characterType: "Pl1400",
    totalDamage: 100,
    skillBreakdown: [
      {
        actionType: { Normal: 9001 },
        childCharacterType: "Pl1400",
        hits: 2,
        minDamage: 10,
        maxDamage: 90,
        totalDamage: 100,
        totalStunValue: 10,
        maxStunValue: 0,
        cappedHits: 0,
        cappableHits: 0,
        overcapBaseSum: 0,
        overcapCapSum: 0,
        targets: [{ enemyType: ENEMY, segment: 0, hits: 2, totalDamage: 100 }],
      },
    ],
    damageTakenBreakdown: [{ enemyType: ENEMY, actionId: { Normal: 7 }, hits: 1, totalDamage: 40, maxDamage: 40 }],
  },
] as unknown as ComputedPlayerState[];

const TARGET_ENTRIES = [
  { id: 9, actorIndex: 9, enemyType: ENEMY, instance: 1, maxHp: null, startMs: 0, endMs: 10_000 },
] as TargetEntry[];

const LABELS: RowCardLabels = {
  ability: (key: string) => `ability:${key}`,
  enemy: (type: EnemyType) => JSON.stringify(type),
  source: (index: number) => `player:${index}`,
  sourceColor: () => "#000",
  target: (segment: number) => `spawn:${segment}`,
  attack: (type, action) => `${JSON.stringify(type)}:${JSON.stringify(action)}`,
  cause: (labelKey: string) => `cause:${labelKey}`,
};

const DAMAGE_CARD: MetricCard = {
  amountKey: "ui.meter-columns.damage",
  valueOf: (skill) => skill.totalDamage,
  format: String,
  perTarget: true,
};

const NO_PINS = { source: null, targets: [] as number[], ability: null };

const rowOf = (key: string, label: string): MetricRow => ({
  key,
  label,
  value: 0,
  columns: [],
  pinOnClick: null,
  colorSlot: -1,
});

/** A representative row of the shape each (metric, hostility, dimension)
 * grouping actually produces — the same key grammars `groupRowsFor` emits.
 *
 * "taken/enemy/source" is `target:0`, not `enemy:<json>`: the groups path
 * keys the taken metric's enemy-side source grouping by ENEMY SPAWN (the
 * victim), which is `groupRowsFor`'s `enemySpawn` case — see
 * `src-tauri/src/parser/v1/groups.rs`'s role mapping ("taken + enemy: dealt
 * stream, source = EnemySpawn (victim)") and `groupRowsFor`'s `enemySpawn`
 * case (`target:<segment>`). */
const ROW_FOR: Record<string, MetricRow> = {
  "damage/friendly/source": rowOf("player:0", "0"),
  "damage/friendly/ability": rowOf("skill:Normal:9001", "Normal:9001"),
  "damage/friendly/target": rowOf("target:0", "target:0"),
  "damage/enemy/source": rowOf(`enemy:${ENEMY_JSON}`, ENEMY_JSON),
  "damage/enemy/ability": rowOf(`taken:${ATTACK_JSON}`, ATTACK_JSON),
  "damage/enemy/target": rowOf("player:0", "0"),
  "taken/friendly/source": rowOf("player:0", "0"),
  "taken/friendly/ability": rowOf(`taken:${ATTACK_JSON}`, ATTACK_JSON),
  "taken/friendly/target": rowOf(`enemy:${ENEMY_JSON}`, ENEMY_JSON),
  "taken/enemy/source": rowOf("target:0", "target:0"),
  "taken/enemy/ability": rowOf("skill:Normal:9001", "Normal:9001"),
  "taken/enemy/target": rowOf("player:0", "0"),
};

describe("card presence matches the declared cardKind — promise vs delivery", () => {
  for (const metric of ["damage", "taken"] as const) {
    const caps = CAPABILITIES[metric];
    for (const hostility of ["friendly", "enemy"] as const) {
      for (const dim of caps.dimensionOrder as Dimension[]) {
        const kind = caps.cardKind(dim, hostility);
        it(`${metric}/${hostility}/${dim} declared "${kind}"`, () => {
          const sections = rowCardSectionsFor({
            cardKind: kind,
            groupBy: dim,
            row: ROW_FOR[`${metric}/${hostility}/${dim}`],
            level: levelFor(dim),
            players: PLAYERS,
            pins: NO_PINS,
            targetEntries: TARGET_ENTRIES,
            color: "red",
            labels: LABELS,
            card: DAMAGE_CARD,
          });

          // The machine's promise IS the builder's delivery: a declared card
          // must arrive, and a declared "none" must stay absent.
          expect(sections !== null).toBe(kind !== "none");
        });
      }
    }
  }
});
