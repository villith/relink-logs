import { describe, expect, it } from "vitest";

import type { LogEvent } from "@/types";

import { EVENT_KINDS, eventKind, filterByKind, filterByPins, toEventRow } from "./eventRows";

const actor = (index: number) => ({
  index,
  actor_type: 1,
  parent_index: index,
  parent_actor_type: 1,
});

/** The cap half of a damage payload, absent. Old logs carry every one of these
 * as null, so it is the shape a fixture must default to. */
const noCap = {
  damage_cap: null,
  base_damage: null,
  attack_rate: null,
  stun_value: null,
  target_current_hp: null,
  target_max_hp: null,
};

const damage: LogEvent = [
  1_500,
  {
    DamageEvent: {
      source: actor(0),
      target: actor(9),
      damage: 18204,
      flags: 0,
      action_id: { Normal: 100 },
      ...noCap,
      damage_cap: 1_000_000,
      base_damage: 4_000_000,
      attack_rate: 2.5,
    },
  },
];

const death: LogEvent = [41_880, { OnDeathEvent: { actor_index: 1, death_counter: 1 } }];
const gaugeTick: LogEvent = [900, { OnUpdateSBA: { actor_index: 0, sba_value: 42.5, sba_added: 1.5 } }];
const stun: LogEvent = [2_000, { OnPlayerStun: { actor_index: 2, stun_amount: 12.75 } }];
const guard: LogEvent = [2_100, { OnPerfectGuardStun: { actor_index: 2, stun_amount: 4 } }];
const perform: LogEvent = [3_000, { OnPerformSBA: { actor_index: 3 } }];
const applied: LogEvent = [
  4_000,
  {
    StatusApply: {
      actor_index: 1,
      caster_index: 3,
      status_id: 77,
      ability_id: 210,
      stacks: 2,
      status_class: 4242,
      caster_action_id: null,
    },
  },
];
const removed: LogEvent = [6_000, { StatusRemove: { actor_index: 1, status_id: 77, ability_id: 210 } }];
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

  // The damage path keys a spawn by the folded INSTANCE POINTER; every other
  // path reports the game's actor index. Nothing about the number says which,
  // so the row has to — see `ActorSpace`.
  it("declares which index space its target is in", () => {
    expect(toEventRow(damage).targetSpace).toBe("spawn");
    expect(toEventRow(applied).targetSpace).toBe("actor");
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
          ...noCap,
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
    expect(toEventRow(applied).amount).toBe(2);
  });

  // The caster acts on the holder, exactly as an attacker acts on a target, so
  // the two kinds of row scan as one table. Filed the other way round — the way
  // every other variant's bare `actor_index` is read — a buff read as the
  // target buffing itself.
  it("reads a status apply as caster ACTING ON holder", () => {
    const row = toEventRow(applied);
    expect(row.sourceIndex).toBe(3);
    expect(row.targetIndex).toBe(1);
    expect(row.targetSpace).toBe("actor");
  });

  // The same grammar the buffs tables and the ability selector pin, so one
  // effect is named and pictured identically wherever it appears.
  it("names the effect with the pin key the buffs tables use", () => {
    expect(toEventRow(applied).statusKey).toBe("status:77:210:4242");
    expect(toEventRow(applied).abilityKey).toBeNull();
  });

  // The shared destructor cannot vouch for a class, so the remove side spells
  // one it does not have rather than inventing it.
  it("spells a removal's missing class rather than guessing one", () => {
    const row = toEventRow(removed);
    expect(row.statusKey).toBe("status:77:210:unknown");
    expect(row.sourceIndex).toBeNull();
    expect(row.targetIndex).toBe(1);
  });

  it("names the skill behind a gauge grant", () => {
    const gain: LogEvent = [1_000, { SbaGain: { actor_index: 0, action_id: 100, amount: 3.25 } }];
    const row = toEventRow(gain);
    expect(row.abilityKey).toBe("Normal:100");
    expect(row.amount).toBe(3);
    expect(row.detailKey).toBeNull();
  });

  // `action_id` is 0 wherever the cause was not a `Skill(Normal(id))` — every
  // link attack and echo that fed the gauge. Naming 0 would print an unknown
  // skill over all of them.
  it("does not name action 0 as a skill", () => {
    const gain: LogEvent = [1_000, { SbaGain: { actor_index: 0, action_id: 0, amount: 1 } }];
    const row = toEventRow(gain);
    expect(row.abilityKey).toBeNull();
    expect(row.detailKey).toBe("ui.logs.events-sba-gain");
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
  it("gives every kind the projection can produce a place in the universe", () => {
    // A kind missing from EVENT_KINDS has no colour and no toggle — a row that
    // cannot be turned off, or one that no scope can ever enable.
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
  // One spawn in both spaces: the damage path's folded pointer is 9, the actor
  // index the status path reports is 4.
  const spans = [{ spawnId: 9, actorIndex: 4, startMs: 0, endMs: 10_000 }];
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

  it("narrows to a target SPAWN, matching its id and its span", () => {
    expect(filterByPins(rows, { ...NO_PINS, targetSpans: spans })).toHaveLength(1);
  });

  // The span carries both ids and the ROW says which one applies. Matching a
  // damage row against the actor index compares different namespaces — the
  // defect the parser already documents in `segment_at` — and drops every
  // damage row the pin was supposed to keep.
  it("matches each row in the space that row declares", () => {
    const damageRow = toEventRow(damage);
    expect(filterByPins([damageRow], { ...NO_PINS, targetSpans: spans })).toHaveLength(1);
    // The actor index of the SAME spawn must not match a damage row.
    expect(
      filterByPins([damageRow], { ...NO_PINS, targetSpans: [{ ...spans[0], spawnId: 4, actorIndex: 9 }] })
    ).toEqual([]);

    // ...and an actor-space row matches on the other id, not the pointer.
    const statusRow = toEventRow(applied);
    expect(
      filterByPins([statusRow], {
        ...NO_PINS,
        targetSpans: [{ spawnId: 99, actorIndex: 1, startMs: 0, endMs: 10_000 }],
      })
    ).toHaveLength(1);
    expect(
      filterByPins([statusRow], {
        ...NO_PINS,
        targetSpans: [{ spawnId: 1, actorIndex: 99, startMs: 0, endMs: 10_000 }],
      })
    ).toEqual([]);
  });

  it("excludes a hit on the same spawn id outside the spawn's span", () => {
    // The game reissues a dead boss's actor index to a later spawn — matching the
    // index alone put a second dragon's damage under the first one.
    expect(
      filterByPins(rows, { ...NO_PINS, targetSpans: [{ spawnId: 9, actorIndex: 4, startMs: 0, endMs: 1_000 }] })
    ).toEqual([]);
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
