import { describe, expect, it } from "vitest";

import { characterIconUrl } from "@/characterIcon";
import { enemyIconUrl } from "@/enemyIcon";
import type { TargetEntry } from "@/types";

import { characterIconFor, slotColor, spawnIcon, type IdentityEntry } from "./useActorIdentity";

const PALETTE = ["#a", "#b", "#c", "#d"];

const member = (slot: number, characterType: string): IdentityEntry => ({ slot, characterType }) as IdentityEntry;

describe("characterIconFor", () => {
  it("answers undefined for an index the party does not hold", () => {
    expect(characterIconFor(new Map(), 7)).toBeUndefined();
  });

  it("resolves a member through the shared portrait lookup", () => {
    // Compared against `characterIconUrl` itself rather than a literal URL:
    // what this helper adds is the map lookup and the string guard, and a
    // hard-coded asset path would break whenever the atlas is re-sliced.
    const byIndex = new Map([[7, member(0, "Pl0000")]]);
    expect(characterIconFor(byIndex, 7)).toBe(characterIconUrl("Pl0000"));
  });

  it("answers undefined for a member whose character is not a plain id", () => {
    // `characterType` is `string | { Unknown: number }` on the wire; an
    // Unknown variant names no portrait and must not be sent through the
    // lookup, which would stringify it to "[object Object]".
    const byIndex = new Map([[7, { slot: 0, characterType: { Unknown: 42 } } as unknown as IdentityEntry]]);
    expect(characterIconFor(byIndex, 7)).toBeUndefined();
  });
});

describe("slotColor", () => {
  it("takes the member's own party slot", () => {
    expect(slotColor(PALETTE, [], new Map([[7, member(2, "Pl0000")]]), 7, 0)).toBe("#c");
  });

  it("falls back to the caller's slot for a non-member", () => {
    // The fallback differs per call site BY DESIGN: a table row falls back to
    // its own colorSlot, a bare player index to slot 0. One helper, one
    // parameter — collapsing them onto a single fallback would recolour one.
    expect(slotColor(PALETTE, [], new Map(), 7, 3)).toBe("#d");
  });

  it("prefers the member's slot over the fallback when both are available", () => {
    expect(slotColor(PALETTE, [], new Map([[7, member(1, "Pl0000")]]), 7, 3)).toBe("#b");
  });
});

describe("spawnIcon", () => {
  it("answers undefined for a segment with no entry", () => {
    expect(spawnIcon([], 4)).toBeUndefined();
  });

  it("resolves a spawn through the shared portrait lookup", () => {
    const entries = [{ enemyType: "em0000" } as unknown as TargetEntry];
    expect(spawnIcon(entries, 0)).toBe(enemyIconUrl("em0000"));
  });
});
