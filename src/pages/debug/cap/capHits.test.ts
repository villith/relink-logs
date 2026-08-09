import { describe, expect, it } from "vitest";

import type { LogEvent } from "@/types";

import { browsableHits, damageHits, hitLabel } from "./capHits";

const actor = (index: number, parent = index) => ({
  index,
  actor_type: 0,
  parent_index: parent,
  parent_actor_type: 0,
});

const damage = (timeMs: number, sourceParent: number, over: Record<string, unknown> = {}): LogEvent => [
  timeMs,
  {
    DamageEvent: {
      source: actor(sourceParent + 100, sourceParent),
      target: actor(900),
      damage: 1000,
      flags: 0,
      action_id: { Normal: 1 },
      damage_cap: 2000,
      base_damage: 3000,
      attack_rate: 0.5,
      class_flags: 0x1,
      ...over,
    },
  } as LogEvent[1],
];

const death = (timeMs: number): LogEvent => [timeMs, { OnDeathEvent: { actor_index: 1, death_counter: 1 } }];

describe("damageHits", () => {
  it("keeps only damage events, in stream order", () => {
    const hits = damageHits([damage(10, 1), death(20), damage(30, 2)]);
    expect(hits.map((hit) => hit.timeMs)).toEqual([10, 30]);
  });

  it("attributes a hit to the source's PARENT, so a summon's hit is its owner's", () => {
    // A summon acts under its own actor index but the cap-up record, the
    // loadout and the ladder key all belong to the player who called it.
    const [hit] = damageHits([damage(10, 3)]);
    expect(hit.sourceIndex).toBe(3);
  });

  it("carries the stream position, so a hit can be named and found again", () => {
    const hits = damageHits([death(5), damage(10, 1), damage(20, 1)]);
    expect(hits.map((hit) => hit.eventIndex)).toEqual([1, 2]);
  });

  it("projects exactly the fields the explanation reads", () => {
    const [hit] = damageHits([damage(10, 1, { damage: 55, damage_cap: 66, base_damage: 77, attack_rate: 0.25 })]);
    expect(hit.hit).toEqual({
      damage: 55,
      damage_cap: 66,
      base_damage: 77,
      attack_rate: 0.25,
      class_flags: 0x1,
      flags: 0,
    });
  });

  it("keeps a hit from a log predating the cap capture", () => {
    // The panel's job is to say WHY it cannot explain such a hit; dropping it
    // here would make an old log look like it contained no damage at all.
    const [hit] = damageHits([
      damage(10, 1, { damage_cap: null, base_damage: null, attack_rate: null, class_flags: null }),
    ]);
    expect(hit.hit.damage_cap).toBeNull();
    expect(hit.abilityKey).toBe("Normal:1");
  });
});

describe("browsableHits", () => {
  it("drops supplementary echoes", () => {
    // An echo is a fixed ratio off a hit that already appears in this list, so
    // it has no cap derivation of its own worth stepping through — it only
    // pads the list between the hits that do.
    const events = [
      damage(10, 1),
      damage(20, 1, { action_id: { SupplementaryDamage: 500 } }),
      damage(30, 1, { action_id: "LinkAttack" }),
    ];
    expect(browsableHits(events).map((hit) => hit.abilityKey)).toEqual(["Normal:1", "LinkAttack"]);
  });

  it("keeps the stream positions of the hits it does keep", () => {
    // The echo is filtered from the LIST, not renumbered out of the log — the
    // index still has to address the same event in the stored stream.
    const events = [damage(10, 1, { action_id: { SupplementaryDamage: 500 } }), damage(20, 1)];
    expect(browsableHits(events).map((hit) => hit.eventIndex)).toEqual([1]);
  });
});

describe("hitLabel", () => {
  it("numbers a hit by its position in the stream", () => {
    // The NAME is resolved by the caller through the analysis view's own skill
    // namer, so this only owns the numbering.
    const [hit] = damageHits([damage(10, 1)]);
    expect(hitLabel(hit, "Kaigan")).toBe("#0 Kaigan");
  });
});
