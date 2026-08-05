import { describe, expect, it } from "vitest";

import type { DeathEvent, SBAEvent } from "@/types";

import { extractMarkers } from "./chartMarkers";

const death = (ts: number, actorIndex: number): DeathEvent => [
  ts,
  { OnDeathEvent: { actor_index: actorIndex, death_counter: 1 } },
];
const perform = (ts: number, actorIndex: number): SBAEvent => [ts, { OnPerformSBA: { actor_index: actorIndex } }];
const attempt = (ts: number, actorIndex: number): SBAEvent => [ts, { OnAttemptSBA: { actor_index: actorIndex } }];
const chain = (ts: number, actorIndex: number): SBAEvent => [ts, { OnContinueSBAChain: { actor_index: actorIndex } }];

const KNOWN = new Set([0, 1, 2, 3]);
const FULL = { startMs: 0, endMs: 240_000 };

describe("extractMarkers", () => {
  it("turns a death event into a death marker at its fight time", () => {
    const markers = extractMarkers({
      deathEvents: [death(42_000, 1)],
      sbaEvents: [],
      window: FULL,
      knownActors: KNOWN,
    });
    expect(markers).toEqual([{ kind: "death", atMs: 42_000, actorIndex: 1 }]);
  });

  it("rebases onto the scoped window and drops what falls outside it", () => {
    const markers = extractMarkers({
      deathEvents: [death(5_000, 0), death(15_000, 1), death(95_000, 2)],
      sbaEvents: [],
      window: { startMs: 10_000, endMs: 90_000 },
      knownActors: KNOWN,
    });
    expect(markers).toEqual([{ kind: "death", atMs: 5_000, actorIndex: 1 }]);
  });

  it("drops an actor the party does not know — enemy deaths are out of scope", () => {
    const markers = extractMarkers({
      deathEvents: [death(1_000, 4026531840)],
      sbaEvents: [],
      window: FULL,
      knownActors: KNOWN,
    });
    expect(markers).toEqual([]);
  });

  it("marks SBA performs and chain continuations, never bare attempts", () => {
    const markers = extractMarkers({
      deathEvents: [],
      sbaEvents: [attempt(1_000, 0), perform(2_000, 0), chain(3_000, 1)],
      window: FULL,
      knownActors: KNOWN,
    });
    expect(markers).toEqual([
      { kind: "sba", atMs: 2_000, actorIndex: 0 },
      { kind: "sba", atMs: 3_000, actorIndex: 1 },
    ]);
  });

  it("interleaves the two kinds in time order", () => {
    const markers = extractMarkers({
      deathEvents: [death(30_000, 0)],
      sbaEvents: [perform(10_000, 1)],
      window: FULL,
      knownActors: KNOWN,
    });
    expect(markers.map((marker) => marker.kind)).toEqual(["sba", "death"]);
  });
});
