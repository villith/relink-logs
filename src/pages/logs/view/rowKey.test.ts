import { describe, expect, it } from "vitest";

import {
  actorFallbackKey,
  enemyRowKey,
  parseEnemyRow,
  playerRowIndex,
  playerRowKey,
  ROLLUP_KEY,
  rowRefOf,
  SBA_UNATTRIBUTED_KEY,
  sbaCausePayload,
  sbaCauseRowKey,
  skillKey,
  spawnRowKey,
  spawnRowSegment,
  takenAttackRowLabel,
  takenAttackRowParts,
  takenRowKey,
  TOTAL_KEY,
} from "./rowKey";

const ENEMY = { Unknown: 0xaa };
const ATTACK = { Normal: 42 };

describe("row key grammar", () => {
  it("round-trips a player index", () => {
    expect(playerRowKey(3)).toBe("player:3");
    expect(playerRowIndex("player:3")).toBe(3);
  });

  it("round-trips a spawn segment", () => {
    expect(spawnRowKey(12)).toBe("target:12");
    expect(spawnRowSegment("target:12")).toBe(12);
  });

  it("round-trips an enemy type", () => {
    expect(parseEnemyRow(enemyRowKey(ENEMY).slice("enemy:".length))).toEqual(ENEMY);
  });

  it("round-trips one enemy attack", () => {
    expect(takenAttackRowParts(takenAttackRowLabel(ENEMY, ATTACK))).toEqual({ enemyType: ENEMY, actionId: ATTACK });
  });

  it("round-trips a gauge cause with and without a discriminating id", () => {
    expect(sbaCauseRowKey("effect", 0x10)).toBe("source:effect:16");
    expect(sbaCauseRowKey("questStart", null)).toBe("source:questStart");
    expect(sbaCausePayload("source:effect:16")).toBe("effect:16");
  });

  // A key of another namespace is not a failure to parse — it is a different
  // kind of row, and answering 0 for it would file every ability row under
  // player 0.
  it("answers null for a key of another namespace", () => {
    expect(playerRowIndex("target:3")).toBeNull();
    expect(spawnRowSegment("player:3")).toBeNull();
    expect(playerRowIndex("skill:Normal:100")).toBeNull();
    expect(sbaCausePayload(skillKey("Normal:100"))).toBeNull();
  });

  // A hand-edited URL can produce these; NaN would propagate into a Map lookup
  // and match nothing silently.
  it("answers null for a malformed index", () => {
    expect(playerRowIndex("player:")).toBeNull();
    expect(playerRowIndex("player:abc")).toBeNull();
  });
});

describe("rowRefOf", () => {
  it("reads every namespace", () => {
    expect(rowRefOf(playerRowKey(2))).toEqual({ kind: "player", index: 2 });
    expect(rowRefOf(spawnRowKey(1))).toEqual({ kind: "target", segment: 1 });
    expect(rowRefOf(actorFallbackKey(900))).toEqual({ kind: "actor", actorIndex: 900 });
    expect(rowRefOf(enemyRowKey(ENEMY))).toEqual({ kind: "enemy", enemyType: ENEMY });
    expect(rowRefOf(takenRowKey(takenAttackRowLabel(ENEMY, ATTACK)))).toEqual({
      kind: "takenAttack",
      enemyType: ENEMY,
      actionId: ATTACK,
    });
    expect(rowRefOf(skillKey('Group:zerreissen@"Pl1500"'))).toEqual({
      kind: "ability",
      rowKey: 'Group:zerreissen@"Pl1500"',
    });
    expect(rowRefOf("status:12:34:56")).toEqual({ kind: "status", statusKey: "status:12:34:56" });
  });

  it("reads the reserved words", () => {
    expect(rowRefOf(ROLLUP_KEY)).toEqual({ kind: "rollup" });
    expect(rowRefOf(TOTAL_KEY)).toEqual({ kind: "total" });
  });

  // The one exception in the grammar: a `skill:` key that names no skill. Sent
  // through the ability join it draws whichever art the fallback lands on,
  // under a name it never asked for.
  it("classes the unattributed SBA remainder as a gauge cause, not an ability", () => {
    expect(rowRefOf(SBA_UNATTRIBUTED_KEY)).toEqual({ kind: "sbaCause", key: SBA_UNATTRIBUTED_KEY });
    expect(rowRefOf(sbaCauseRowKey("perfectGuard", null))).toEqual({
      kind: "sbaCause",
      key: "source:perfectGuard",
    });
  });

  // The per-player chart's series predate the grammar and carry none of it, so
  // a key that is only digits is a player — but only once every prefixed form
  // has been ruled out.
  it("reads a bare actor index as a player", () => {
    expect(rowRefOf("7")).toEqual({ kind: "player", index: 7 });
  });

  // A stale pin or a hand-edited URL. Callers render the raw key, which is what
  // tells the user what is wrong.
  it("answers null for a key it cannot place", () => {
    expect(rowRefOf("nonsense")).toBeNull();
    expect(rowRefOf("")).toBeNull();
    // A taken key whose payload does not parse has no attacker to name it
    // after, so it is not a taken row either.
    expect(rowRefOf(takenRowKey("{broken"))).toBeNull();
  });
});
