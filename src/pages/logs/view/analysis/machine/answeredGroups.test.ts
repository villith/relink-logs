import { describe, expect, it } from "vitest";

import type { GroupAggregate } from "@/types";

import { answeredGroups, type GroupReading } from "./answeredGroups";

const player = (index: number): GroupAggregate => ({
  key: { kind: "player", index },
  measure: { amount: 100, hits: 1, min: null, max: null },
  merged: { amount: 100, hits: 1, min: null, max: null, supplementary: 0 },
  series: [100],
});

const ability = (id: number): GroupAggregate => ({
  key: { kind: "friendlyAbility", actionType: { Normal: id }, childCharacterType: "Pl0000" },
  measure: { amount: 50, hits: 1, min: null, max: null },
  merged: { amount: 50, hits: 1, min: null, max: null, supplementary: 0 },
  series: [50],
});

const DAMAGE: GroupReading = { metric: "damage", hostility: "friendly" };
const TAKEN: GroupReading = { metric: "taken", hostility: "friendly" };
const DAMAGE_ENEMY: GroupReading = { metric: "damage", hostility: "enemy" };

/** The base load, answering Damage Done grouped by source — what opening a log
 * on the default tab actually leaves in hand. */
const BASE = { groups: [player(0), player(1)], groupBy: "source" as const, reading: DAMAGE };

/** A response that carried no group query: every non-groups metric's, and first
 * paint. Its aggregate list is empty by construction. */
const NO_QUERY = { groups: [], groupBy: null, reading: null };

const request = (groupBy: "source" | "ability" | "target", reading: GroupReading | null) => ({ groupBy, reading });

describe("answeredGroups", () => {
  it("takes the scoped fetch's aggregates and the grouping they answer", () => {
    const scoped = { groups: [ability(1)], groupBy: "ability" as const, reading: DAMAGE };

    expect(answeredGroups(scoped, BASE, request("ability", DAMAGE))).toEqual({
      groups: [ability(1)],
      groupBy: "ability",
      settled: true,
    });
  });

  it("falls back to the base load's aggregates when no scoped fetch has landed", () => {
    expect(answeredGroups(null, BASE, request("source", DAMAGE))).toEqual({
      groups: BASE.groups,
      groupBy: "source",
      settled: true,
    });
  });

  it("reports the OLD grouping while a regroup is still in flight", () => {
    // `spec.groupBy` flips the instant the tab is clicked, but the aggregates in
    // hand still answer the previous question. Read as the new grouping's, the
    // source aggregates stacked as if they were abilities — a plot whose outer
    // shape was right (the same fight total) and whose bands were the wrong
    // decomposition entirely, until the response landed.
    const answered = answeredGroups(null, BASE, request("ability", DAMAGE));

    expect(answered.groupBy).toBe("source");
    expect(answered.groups).toEqual(BASE.groups);
    expect(answered.settled).toBe(false);
  });

  it("keeps the last scoped answer while the NEXT regroup is in flight", () => {
    const scoped = { groups: [ability(1)], groupBy: "ability" as const, reading: DAMAGE };

    expect(answeredGroups(scoped, BASE, request("target", DAMAGE)).groupBy).toBe("ability");
  });

  /** THE STUN → DAMAGE TAKEN CASE. Stun sends no group query, so its `groups`
   * fell back to the BASE load's — which answer Damage Done. The moment the tab
   * flipped to Damage Taken, whose rows DO come from aggregates, those Damage
   * Done numbers rendered as Taken rows: grouped by source, matching the
   * requested grouping exactly, so nothing downstream could tell it was stale. */
  describe("across metrics", () => {
    it("reports nothing rather than another metric's aggregates", () => {
      const answered = answeredGroups(NO_QUERY, BASE, request("source", TAKEN));

      expect(answered.groups).toEqual([]);
      expect(answered.settled).toBe(false);
    });

    it("treats a side swap the same way — it re-roles both actor dimensions", () => {
      const answered = answeredGroups(null, BASE, request("source", DAMAGE_ENEMY));

      expect(answered.groups).toEqual([]);
      expect(answered.settled).toBe(false);
    });

    // Switching AWAY is the mirror: the aura tabs, Stun and SBA ask for no
    // reading at all, so the damage aggregates left in hand are not theirs
    // either. Their rows come from elsewhere, so an empty list costs nothing.
    it("reports nothing to a metric that asks for no reading", () => {
      expect(answeredGroups(null, BASE, request("source", null)).groups).toEqual([]);
    });

    // A scoped response left over from the previous tab answers nothing, so it
    // must not shadow a base load that does answer — otherwise coming back to
    // the metric the base load carries would wait for a fetch returning the very
    // same rows.
    it("lets the base load answer past a scoped response that cannot", () => {
      expect(answeredGroups(NO_QUERY, BASE, request("source", DAMAGE))).toEqual({
        groups: BASE.groups,
        groupBy: "source",
        settled: true,
      });
    });
  });

  it("reads as the requested grouping when nothing has answered anything yet", () => {
    expect(answeredGroups(null, NO_QUERY, request("ability", DAMAGE))).toEqual({
      groups: [],
      groupBy: "ability",
      settled: false,
    });
  });
});
