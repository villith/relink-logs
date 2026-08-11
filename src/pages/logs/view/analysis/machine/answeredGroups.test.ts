import { describe, expect, it } from "vitest";

import type { GroupAggregate } from "@/types";

import { answeredGroups } from "./answeredGroups";

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

const BASE = { groups: [player(0), player(1)], groupBy: "source" as const };

describe("answeredGroups", () => {
  it("takes the scoped fetch's aggregates and the grouping they answer", () => {
    const scoped = { groups: [ability(1)], groupBy: "ability" as const };
    expect(answeredGroups(scoped, BASE, "ability")).toEqual({ groups: [ability(1)], groupBy: "ability" });
  });

  it("falls back to the base load's aggregates when no scoped fetch has landed", () => {
    expect(answeredGroups(null, BASE, "source")).toEqual(BASE);
  });

  it("reports the OLD grouping while a regroup is still in flight", () => {
    // The bug this exists to stop: `spec.groupBy` flips the instant the tab is
    // clicked, but the aggregates in hand still answer the previous question.
    // Read as the new grouping's, the source aggregates stacked as if they
    // were abilities — a plot whose outer shape was right (the same fight
    // total) and whose bands were the wrong decomposition entirely, until the
    // response landed and it settled.
    const answered = answeredGroups(null, BASE, "ability");
    expect(answered.groupBy).toBe("source");
    expect(answered.groups).toEqual(BASE.groups);
  });

  it("keeps the last scoped answer while the NEXT regroup is in flight", () => {
    // Two regroups in a row: the aggregates in hand are the first one's, and
    // they answer its grouping, not the one now requested.
    const scoped = { groups: [ability(1)], groupBy: "ability" as const };
    expect(answeredGroups(scoped, BASE, "target").groupBy).toBe("ability");
  });

  it("reads a scoped fetch that carried no group query as the requested grouping", () => {
    // The non-groups metrics (Stun, SBA, the aura tabs) still run this fetch —
    // for their own state and bands — and simply send no group query, so the
    // response stamps no grouping. Its aggregate list is empty either way.
    expect(answeredGroups({ groups: [], groupBy: null }, BASE, "ability").groupBy).toBe("ability");
  });

  it("reads as the requested grouping when nothing has answered anything yet", () => {
    // First paint on a metric whose base load carried no group query: there is
    // no previous chart to hold, so the requested grouping is the only honest
    // answer — and the empty aggregate list makes it draw nothing anyway.
    expect(answeredGroups(null, { groups: [], groupBy: null }, "ability")).toEqual({
      groups: [],
      groupBy: "ability",
    });
  });
});
