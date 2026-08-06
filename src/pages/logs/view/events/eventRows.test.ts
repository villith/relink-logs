import { describe, expect, it } from "vitest";

import type { LogEvent } from "@/types";

import { DEFAULT_KINDS, EVENT_KINDS, eventKind, filterByKind, filterByPins, toEventRow } from "./eventRows";

const actor = (index: number) => ({
  index,
  actor_type: 1,
  parent_index: index,
  parent_actor_type: 1,
});

const damage: LogEvent = [
  1_500,
  {
    DamageEvent: {
      source: actor(0),
      target: actor(9),
      damage: 18204,
      flags: 0,
      action_id: { Normal: 100 },
    },
  },
];

const death: LogEvent = [41_880, { OnDeathEvent: { actor_index: 1, death_counter: 1 } }];
const gaugeTick: LogEvent = [900, { OnUpdateSBA: { actor_index: 0, sba_value: 42.5, sba_added: 1.5 } }];
const stun: LogEvent = [2_000, { OnPlayerStun: { actor_index: 2, stun_amount: 12.75 } }];
const guard: LogEvent = [2_100, { OnPerfectGuardStun: { actor_index: 2, stun_amount: 4 } }];
const perform: LogEvent = [3_000, { OnPerformSBA: { actor_index: 3 } }];
const applied: LogEvent = [4_000, { StatusApply: { actor_index: 1, status_id: 77, stacks: 2 } }];
const linked: LogEvent = [5_000, { LinkTime: { active: true } }];

/** A variant appended to `Message` after this file was written. */
const future = [7_000, { SomeVariantAddedLater: { whatever: 1 } }] as unknown as LogEvent;

describe("eventKind", () => {
  it("classifies the kinds the toggles filter on", () => {
    expect(eventKind(damage)).toBe("damage");
    expect(eventKind(death)).toBe("death");
    expect(eventKind(gaugeTick)).toBe("sbaTick");
    expect(eventKind(stun)).toBe("stun");
    expect(eventKind(guard)).toBe("perfectGuard");
    expect(eventKind(perform)).toBe("sba");
    expect(eventKind(applied)).toBe("status");
  });

  it("files a per-hit gauge grant with the gauge ticks", () => {
    // SbaGain is one event per damaging hit — DamageEvent-scale volume, and
    // gauge noise like OnUpdateSBA. One toggle covers both.
    const gain: LogEvent = [1_000, { SbaGain: { actor_index: 0, action_id: 100, amount: 3.25 } }];
    expect(eventKind(gain)).toBe("sbaTick");
  });

  it("files a variant it does not know under other, rather than guessing", () => {
    // Message grows by the append-only rule. A variant added after this file
    // must not be labelled a stun and must not have an actor_index read off it.
    expect(eventKind(future)).toBe("other");
    expect(eventKind(linked)).toBe("other");
  });
});

describe("toEventRow", () => {
  it("projects a damage event into its columns", () => {
    const row = toEventRow(damage);
    expect(row.timeMs).toBe(1_500);
    expect(row.sourceIndex).toBe(0);
    expect(row.targetIndex).toBe(9);
    expect(row.abilityKey).toBe("Normal:100");
    expect(row.amount).toBe(18204);
    expect(row.detailKey).toBeNull();
  });

  it("credits a hit to the PARENT actor, so a summon's damage is its caller's", () => {
    const summoned: LogEvent = [
      1_000,
      {
        DamageEvent: {
          source: { index: 42, actor_type: 1, parent_index: 7, parent_actor_type: 1 },
          target: actor(9),
          damage: 5,
          flags: 0,
          action_id: "LinkAttack",
        },
      },
    ];
    expect(toEventRow(summoned).sourceIndex).toBe(7);
  });

  it("leaves target and amount absent on a death", () => {
    // Ragged shapes must not fabricate zeros — a death has no target and no
    // amount, and rendering "0" would read as real data.
    const row = toEventRow(death);
    expect(row.sourceIndex).toBe(1);
    expect(row.targetIndex).toBeNull();
    expect(row.amount).toBeNull();
    expect(row.abilityKey).toBeNull();
    expect(row.detailKey).toBe("ui.logs.events-died");
  });

  it("rounds the fractional gauge and stun readings", () => {
    // stun_amount and sba_value are f32. A column of 12.749999 is unreadable.
    expect(toEventRow(stun).amount).toBe(13);
    expect(toEventRow(gaugeTick).amount).toBe(43);
  });

  it("carries a status effect's stacks as its amount", () => {
    const row = toEventRow(applied);
    expect(row.sourceIndex).toBe(1);
    expect(row.amount).toBe(2);
    expect(row.detailKey).toBe("ui.logs.events-status-applied");
  });

  it("leaves the source absent on a party-wide event with no actor", () => {
    // LinkTime carries no actor_index at all; reading one would print undefined.
    const row = toEventRow(linked);
    expect(row.sourceIndex).toBeNull();
    expect(row.detailKey).toBe("ui.logs.events-link-start");
  });

  it("names an unknown variant by its own tag instead of inventing a row", () => {
    const row = toEventRow(future);
    expect(row.kind).toBe("other");
    expect(row.sourceIndex).toBeNull();
    expect(row.amount).toBeNull();
    expect(row.detailKey).toBe("ui.logs.events-unknown");
    expect(row.detailParams).toEqual({ variant: "SomeVariantAddedLater" });
  });
});

describe("kind filtering", () => {
  it("excludes the gauge ticks by default and nothing else", () => {
    // OnUpdateSBA alone is 29% of every stored log, and SbaGain is one per hit —
    // unfiltered they bury everything.
    expect(DEFAULT_KINDS.has("sbaTick")).toBe(false);
    expect(EVENT_KINDS.filter((kind) => !DEFAULT_KINDS.has(kind))).toEqual(["sbaTick"]);
  });

  it("offers a toggle for every kind the projection can produce", () => {
    // A kind with no toggle is a row the reader cannot turn off — or, worse, one
    // that vanishes because no toggle ever enables it.
    const produced = [damage, death, gaugeTick, stun, guard, perform, applied, linked, future].map(
      (event) => toEventRow(event).kind
    );
    for (const kind of produced) expect(EVENT_KINDS).toContain(kind);
  });

  it("keeps only the enabled kinds", () => {
    const rows = [damage, death, gaugeTick].map(toEventRow);
    expect(filterByKind(rows, new Set(["death"] as const)).map((row) => row.kind)).toEqual(["death"]);
  });

  it("returns nothing when no kind is enabled", () => {
    const rows = [damage, death].map(toEventRow);
    expect(filterByKind(rows, new Set())).toEqual([]);
  });
});

describe("filterByPins", () => {
  // damage: source 0, target 9, Normal:100 at 1500ms | death: source 1 |
  // stun: source 2 | linked: no source at all
  const rows = [damage, death, stun, linked].map(toEventRow);
  const spans = [{ actorIndex: 9, startMs: 0, endMs: 10_000 }];
  const NO_PINS = { source: null, targetSpans: [], abilityKeys: null };

  it("keeps everything with nothing pinned", () => {
    expect(filterByPins(rows, NO_PINS)).toHaveLength(4);
  });

  it("narrows to one actor on a source pin", () => {
    expect(filterByPins(rows, { ...NO_PINS, source: 2 }).map((row) => row.kind)).toEqual(["stun"]);
  });

  it("drops a row that names no actor while a source is pinned", () => {
    // A party-wide LinkTime row belongs to nobody; keeping it under a pin would
    // read as the pin failing to apply.
    expect(filterByPins(rows, { ...NO_PINS, source: 0 }).map((row) => row.kind)).toEqual(["damage"]);
  });

  it("narrows to a target SPAWN, matching its actor index and its span", () => {
    expect(filterByPins(rows, { ...NO_PINS, targetSpans: spans })).toHaveLength(1);
  });

  it("excludes a hit on the same actor index outside the spawn's span", () => {
    // The game reissues a dead boss's actor index to a later spawn — matching the
    // index alone put a second dragon's damage under the first one.
    expect(filterByPins(rows, { ...NO_PINS, targetSpans: [{ actorIndex: 9, startMs: 0, endMs: 1_000 }] })).toEqual([]);
  });

  it("narrows to the expanded ability keys", () => {
    expect(filterByPins(rows, { ...NO_PINS, abilityKeys: new Set(["Normal:100"]) })).toHaveLength(1);
    expect(filterByPins(rows, { ...NO_PINS, abilityKeys: new Set(["Normal:999"]) })).toEqual([]);
  });

  it("ANDs the dimensions", () => {
    expect(filterByPins(rows, { source: 0, targetSpans: spans, abilityKeys: new Set(["Normal:100"]) })).toHaveLength(1);
    expect(filterByPins(rows, { source: 1, targetSpans: spans, abilityKeys: null })).toEqual([]);
  });

  it("narrows to nothing on an ability pin that expanded to no action", () => {
    // An EMPTY set is a real filter (a status pin, or a stale URL naming an
    // action nobody landed) — distinct from null, which is "no ability pinned".
    expect(filterByPins(rows, { ...NO_PINS, abilityKeys: new Set<string>() })).toEqual([]);
  });
});
