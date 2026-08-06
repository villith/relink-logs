import { describe, expect, it } from "vitest";

import type { LogEvent } from "@/types";

import { eventKind, toEventRow } from "./eventRows";

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
