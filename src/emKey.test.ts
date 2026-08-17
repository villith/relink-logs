import { describe, expect, it } from "vitest";

import { emKeyOf } from "./emKey";
import type { EnemyType } from "./types";

/** Proto Bahamut's wire hash, off `enemies.json` (`dbca3857` -> EM7000). */
const PROTO_BAHAMUT = { Unknown: 0xdbca3857 } as unknown as EnemyType;
const UNKNOWN_ENEMY = { Unknown: 1 } as unknown as EnemyType;

describe("emKeyOf", () => {
  it("resolves a wire enemy hash to its em id key", () => {
    expect(emKeyOf(PROTO_BAHAMUT)).toBe("EM7000");
  });

  it("answers null for a hash no enemy row names", () => {
    expect(emKeyOf(UNKNOWN_ENEMY)).toBeNull();
  });

  it("passes a string type straight through", () => {
    expect(emKeyOf("EM1700" as EnemyType)).toBe("EM1700");
  });

  it("keeps the eight-digit pad, so a leading-zero hash still finds its row", () => {
    // The load-bearing half of the shared edge: dropping the pad misses the row.
    expect(emKeyOf({ Unknown: 0x00ca3857 } as unknown as EnemyType)).toBeNull();
  });
});
