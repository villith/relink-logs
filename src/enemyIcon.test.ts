import { describe, expect, it } from "vitest";
import { enemyIconUrl } from "./enemyIcon";

describe("enemyIconUrl", () => {
  it("resolves a boss hash to its portrait", () => {
    // 0x2b31654b is Lucilius (EM7700) in enemies.json.
    expect(enemyIconUrl({ Unknown: 0x2b31654b })).toMatch(/em7700\.png/);
  });

  it("resolves an Em-string spelling too", () => {
    expect(enemyIconUrl("EM1700")).toMatch(/em1700\.png/);
  });

  it("returns undefined for an enemy with no portrait", () => {
    // 0x61325867 is Celestial Slime (EM0610) — named, but never drawn.
    expect(enemyIconUrl({ Unknown: 0x61325867 })).toBeUndefined();
  });

  it("returns undefined for an unknown hash and for null", () => {
    expect(enemyIconUrl({ Unknown: 0xdeadbeef })).toBeUndefined();
    expect(enemyIconUrl(null)).toBeUndefined();
  });
});
