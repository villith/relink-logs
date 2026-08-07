import { describe, expect, it } from "vitest";

import { ENEMY_COLORS, PLAYER_COLORS } from "@/utils";

import { actorColor, actorOfKey, keyColor, type ActorColorContext } from "./actorColor";

const CTX: ActorColorContext = {
  palette: PLAYER_COLORS,
  partyData: [null, null, null, null],
  // Only 0..3 are party members; everything else is an enemy.
  slotOf: (index) => (index < 4 ? index : undefined),
};

describe("actorOfKey", () => {
  it("reads the three actor grammars the rows and bands are written in", () => {
    expect(actorOfKey("player:7")).toEqual({ kind: "player", index: 7 });
    expect(actorOfKey("target:2")).toEqual({ kind: "spawn", segment: 2 });
    expect(actorOfKey('enemy:{"Unknown":305419896}')).toEqual({
      kind: "enemyType",
      type: { Unknown: 305419896 },
    });
  });

  // An enemy the segmenter skipped has no spawn to be coloured by, and its raw
  // actor index is the one the game reissues — colouring by it would give two
  // different spawns the same colour and call them the same enemy.
  it("answers null for a key that names no colourable actor", () => {
    expect(actorOfKey("actor:99")).toBeNull();
    expect(actorOfKey("status:77:210:4242")).toBeNull();
    expect(actorOfKey("skill:Normal:100")).toBeNull();
    expect(actorOfKey("other")).toBeNull();
  });
});

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
    const spawn = actorColor({ kind: "spawn", segment: 1 }, CTX);
    expect(spawn).toBe(ENEMY_COLORS[1]);
    expect(PLAYER_COLORS).not.toContain(spawn);
  });

  it("wraps rather than running out on a fight with many spawns", () => {
    expect(actorColor({ kind: "spawn", segment: ENEMY_COLORS.length }, CTX)).toBe(ENEMY_COLORS[0]);
  });

  // A type takes its colour from its own hash, not from where it happens to sit
  // in the table — a position moves when the damage ordering does, which would
  // recolour an enemy between one window and the next.
  it("colours an enemy TYPE stably, by identity rather than position", () => {
    const type = { Unknown: 0x1234abcd };
    const first = actorColor({ kind: "enemyType", type }, CTX);
    expect(first).toBe(ENEMY_COLORS[0x1234abcd % ENEMY_COLORS.length]);
    expect(actorColor({ kind: "enemyType", type }, CTX)).toBe(first);
  });

  it("still colours an enemy type it cannot parse", () => {
    expect(actorColor({ kind: "enemyType", type: null }, CTX)).toBe(ENEMY_COLORS[0]);
  });
});

describe("keyColor", () => {
  // The point of the shared helper: the chart band, the table row and the
  // dropdown option for ONE enemy all reach the same colour.
  it("resolves a key to the same colour its identity resolves to", () => {
    expect(keyColor("target:3", CTX)).toBe(actorColor({ kind: "spawn", segment: 3 }, CTX));
    expect(keyColor("player:1", CTX)).toBe(actorColor({ kind: "player", index: 1 }, CTX));
  });

  it("answers nothing for a key that names no actor, so callers keep their own fallback", () => {
    expect(keyColor("skill:Normal:100", CTX)).toBeUndefined();
  });
});
