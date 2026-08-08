import { describe, expect, it } from "vitest";

import { ENEMY_COLORS, PLAYER_COLORS } from "@/utils";

import { actorColor, keyColor, type ActorColorContext } from "./actorColor";

const CTX: ActorColorContext = {
  palette: PLAYER_COLORS,
  partyData: [null, null, null, null],
  // Only 0..3 are party members; everything else is an enemy.
  slotOf: (index) => (index < 4 ? index : undefined),
};

describe("actorColor", () => {
  it("gives a party member their own slot colour", () => {
    expect(actorColor({ kind: "player", index: 2 }, CTX)).toBe(PLAYER_COLORS[2]);
  });

  // The slot lookup's own fallback would be 0, which paints every stranger in
  // the first player's colour. Absent is the honest answer; the caller picks
  // its own fallback.
  it("gives no colour to a player the identity party does not know", () => {
    expect(actorColor({ kind: "player", index: 99 }, CTX)).toBeUndefined();
  });

  it("gives an enemy a colour from the enemy palette, never the party one", () => {
    const spawn = actorColor({ kind: "target", segment: 1 }, CTX);
    expect(spawn).toBe(ENEMY_COLORS[1]);
    expect(PLAYER_COLORS).not.toContain(spawn);
  });

  it("wraps rather than running out on a fight with many spawns", () => {
    expect(actorColor({ kind: "target", segment: ENEMY_COLORS.length }, CTX)).toBe(ENEMY_COLORS[0]);
  });

  // A type takes its colour from its own hash, not from where it happens to sit
  // in the table — a position moves when the damage ordering does, which would
  // recolour an enemy between one window and the next.
  it("colours an enemy TYPE stably, by identity rather than position", () => {
    const enemyType = { Unknown: 0x1234abcd };
    const first = actorColor({ kind: "enemy", enemyType }, CTX);
    expect(first).toBe(ENEMY_COLORS[0x1234abcd % ENEMY_COLORS.length]);
    expect(actorColor({ kind: "enemy", enemyType }, CTX)).toBe(first);
  });

  it("still colours an enemy type it cannot parse", () => {
    expect(actorColor({ kind: "enemy", enemyType: null }, CTX)).toBe(ENEMY_COLORS[0]);
  });

  // An enemy the segmenter skipped has no spawn to be coloured by, and its raw
  // actor index is the one the game reissues — colouring by it would give two
  // different spawns the same colour and call them the same enemy. An ability
  // and an effect name no actor at all.
  it("gives no colour to the refs that name no actor", () => {
    expect(actorColor({ kind: "actor", actorIndex: 99 }, CTX)).toBeUndefined();
    expect(actorColor({ kind: "ability", rowKey: "Normal:100" }, CTX)).toBeUndefined();
    expect(actorColor({ kind: "status", statusKey: "status:77:210:4242" }, CTX)).toBeUndefined();
    expect(actorColor({ kind: "rollup" }, CTX)).toBeUndefined();
  });
});

describe("keyColor", () => {
  // The point of the shared helper: the chart band, the table row and the
  // dropdown option for ONE enemy all reach the same colour.
  it("resolves a key to the same colour its identity resolves to", () => {
    expect(keyColor("target:3", CTX)).toBe(actorColor({ kind: "target", segment: 3 }, CTX));
    expect(keyColor("player:1", CTX)).toBe(actorColor({ kind: "player", index: 1 }, CTX));
    expect(keyColor('enemy:{"Unknown":305419896}', CTX)).toBe(
      actorColor({ kind: "enemy", enemyType: { Unknown: 305419896 } }, CTX)
    );
  });

  it("answers nothing for a key that names no actor, so callers keep their own fallback", () => {
    expect(keyColor("skill:Normal:100", CTX)).toBeUndefined();
    expect(keyColor("actor:99", CTX)).toBeUndefined();
    expect(keyColor("other", CTX)).toBeUndefined();
  });
});
