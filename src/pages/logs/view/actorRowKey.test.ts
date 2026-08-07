import { describe, expect, it } from "vitest";

import { playerRowIndex, playerRowKey, spawnRowKey, spawnRowSegment } from "./actorRowKey";

describe("actor row keys", () => {
  it("round-trips a player index", () => {
    expect(playerRowKey(3)).toBe("player:3");
    expect(playerRowIndex("player:3")).toBe(3);
  });

  it("round-trips a spawn segment", () => {
    expect(spawnRowKey(12)).toBe("target:12");
    expect(spawnRowSegment("target:12")).toBe(12);
  });

  // A key of the other namespace is not a failure to parse — it is a different
  // kind of row, and answering 0 for it would file every ability row under
  // player 0.
  it("answers null for a key of another namespace", () => {
    expect(playerRowIndex("target:3")).toBeNull();
    expect(spawnRowSegment("player:3")).toBeNull();
    expect(playerRowIndex("skill:Normal:100")).toBeNull();
  });

  // A hand-edited URL can produce these; NaN would propagate into a Map lookup
  // and match nothing silently.
  it("answers null for a malformed index", () => {
    expect(playerRowIndex("player:")).toBeNull();
    expect(playerRowIndex("player:abc")).toBeNull();
  });
});
