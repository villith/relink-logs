import { describe, expect, it } from "vitest";

import { enemyAttackOrdinal } from "./enemyAttackNames";
import type { EnemyType } from "./types";

/** Proto Bahamut's wire hash, off `enemies.json` (`dbca3857` -> EM7000). */
const PROTO_BAHAMUT = { Unknown: 0xdbca3857 } as unknown as EnemyType;
const UNKNOWN_ENEMY = { Unknown: 1 } as unknown as EnemyType;

describe("enemyAttackOrdinal", () => {
  it("resolves a mapped (enemy, action id) to its callout ordinal", () => {
    const map = { EM7000: { 9001: 1 } };
    expect(enemyAttackOrdinal(PROTO_BAHAMUT, { Normal: 9001 }, map)).toBe(1);
  });

  it("answers null for unmapped attacks, unmapped enemies and non-Normal actions", () => {
    const map = { EM7000: { 9001: 1 } };
    expect(enemyAttackOrdinal(PROTO_BAHAMUT, { Normal: 42 }, map)).toBeNull();
    expect(enemyAttackOrdinal(PROTO_BAHAMUT, "LinkAttack" as never, map)).toBeNull();
    expect(enemyAttackOrdinal(PROTO_BAHAMUT, { DamageOverTime: 1 } as never, map)).toBeNull();
    expect(enemyAttackOrdinal(UNKNOWN_ENEMY, { Normal: 9001 }, map)).toBeNull();
  });

  it("defaults to the committed map, which ships with no derived pairs", () => {
    // The action-id -> ordinal edge is live-capture work (see the enemy-attack
    // names plan's discovery log); until pairs land, every attack falls back.
    expect(enemyAttackOrdinal(PROTO_BAHAMUT, { Normal: 9001 })).toBeNull();
  });
});
