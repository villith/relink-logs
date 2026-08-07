import { describe, expect, it } from "vitest";

import type { TargetEntry } from "@/types";

import { spawnSegmentAt } from "./eventTargets";

/** Two spawns of one boss: the game reissued actor index 4, and each spawn got
 * its own folded instance pointer from the damage path. */
const ENTRIES = [
  { id: 900, actorIndex: 4, startMs: 1_000, endMs: 5_000 },
  { id: 901, actorIndex: 4, startMs: 8_000, endMs: 12_000 },
  { id: 902, actorIndex: 7, startMs: 0, endMs: 12_000 },
].map((entry) => ({ ...entry, enemyType: "Em0000", instance: 1, maxHp: null }) as unknown as TargetEntry);

describe("spawnSegmentAt", () => {
  // The whole reason a row carries its space: the damage path's folded pointer
  // and the status path's actor index are different namespaces, and comparing
  // one against the other never matches.
  it("matches the id in the spawn space and the actor index in the actor space", () => {
    expect(spawnSegmentAt(ENTRIES, 901, 9_000, "spawn")).toBe(1);
    expect(spawnSegmentAt(ENTRIES, 901, 9_000, "actor")).toBe(-1);
    expect(spawnSegmentAt(ENTRIES, 4, 9_000, "actor")).toBe(1);
    expect(spawnSegmentAt(ENTRIES, 4, 9_000, "spawn")).toBe(-1);
  });

  // Segments for one index are chronological and disjoint, so the spawn alive
  // at `atMs` is the last one to have started by then. The first dragon's hits
  // must not be filed under the second.
  it("picks the spawn that was alive at the moment", () => {
    expect(spawnSegmentAt(ENTRIES, 4, 2_000, "actor")).toBe(0);
    expect(spawnSegmentAt(ENTRIES, 4, 11_000, "actor")).toBe(1);
  });

  // The parser's own tolerance (`segment_at`): a debuff can land on an enemy a
  // moment before that enemy's first damage event, which is where its segment
  // starts. Naming it after the first spawn beats naming it after nothing.
  it("falls back to the first spawn for a moment before any of them started", () => {
    expect(spawnSegmentAt(ENTRIES, 4, 500, "actor")).toBe(0);
  });

  it("answers -1 for an index no spawn carries", () => {
    expect(spawnSegmentAt(ENTRIES, 12345, 2_000, "actor")).toBe(-1);
    expect(spawnSegmentAt([], 4, 2_000, "actor")).toBe(-1);
  });
});
