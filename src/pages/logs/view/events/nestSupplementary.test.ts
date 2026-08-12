import { describe, expect, it } from "vitest";

import type { EventRow } from "./eventRows";
import { nestSupplementary, type NestedEventRow } from "./nestSupplementary";

const row = (timeMs: number, amount: number, abilityKey: string): EventRow => ({
  timeMs,
  kind: "damage",
  sourceIndex: 0,
  targetIndex: 7,
  targetSpace: "spawn",
  abilityKey,
  statusKey: null,
  statusId: null,
  detailKey: null,
  amount,
  // Nesting pairs an echo with its cause by time and ability; the cap fields
  // ride along untouched, so these rows need none.
  capHit: null,
  capConditions: null,
});

const keys = (rows: NestedEventRow[]) => rows.map((r) => `${r.abilityKey}${r.parent ? "*" : ""}`);

describe("nestSupplementary", () => {
  const all = [
    row(5_000, 154_500, "Normal:9001"),
    row(5_020, 148_200, "Normal:9002"),
    row(5_151, 92_681, "SupplementaryDamage:9001"),
  ];
  // The echo at index 2 was triggered by the hit at index 0.
  const pairs = { 2: 0 };

  it("moves the echo directly beneath its trigger", () => {
    expect(keys(nestSupplementary(all, all, pairs))).toEqual([
      "Normal:9001",
      "SupplementaryDamage:9001*",
      "Normal:9002",
    ]);
  });

  it("carries the offset from its trigger and keeps its real timestamp", () => {
    const [, echo] = nestSupplementary(all, all, pairs);
    expect(echo.parent).toEqual({ deltaMs: 151, sharePercent: 60 });
    // The absolute stamp survives for the hover.
    expect(echo.timeMs).toBe(5_151);
  });

  it("rounds the share to one decimal", () => {
    const odd = [row(0, 1_000, "Normal:1"), row(100, 333, "SupplementaryDamage:1")];
    const [, echo] = nestSupplementary(odd, odd, { 1: 0 });
    expect(echo.parent?.sharePercent).toBe(33.3);
  });

  it("leaves an echo flat when it has no pair", () => {
    expect(keys(nestSupplementary(all, all, {}))).toEqual(["Normal:9001", "Normal:9002", "SupplementaryDamage:9001"]);
  });

  it("readmits a filtered-out trigger as a dimmed context row", () => {
    // Showing an echo implies showing what caused it: a half-drawn pair says
    // less than either row alone.
    const nested = nestSupplementary([all[2]], all, pairs);
    expect(keys(nested)).toEqual(["Normal:9001", "SupplementaryDamage:9001*"]);
    expect(nested[0].context).toBe(true);
    expect(nested[1].context).toBeUndefined();
  });

  it("keeps several echoes on one trigger in time order", () => {
    const many = [
      row(0, 1_000, "Normal:1"),
      row(150, 60, "SupplementaryDamage:1"),
      row(160, 20, "SupplementaryDamage:1"),
    ];
    expect(nestSupplementary(many, many, { 1: 0, 2: 0 }).map((r) => r.amount)).toEqual([1_000, 60, 20]);
  });

  // The re-admission runs one way only. A filter that keeps the trigger and
  // drops the echo is a filter that asked for the trigger on its own merits —
  // there is no half-pair to complete, so nothing moves and nothing dims.
  it("does not let a filtered-out echo disturb its trigger", () => {
    const nested = nestSupplementary([all[0], all[1]], all, pairs);
    expect(keys(nested)).toEqual(["Normal:9001", "Normal:9002"]);
    expect(nested[0].parent).toBeUndefined();
    expect(nested[0].context).toBeUndefined();
  });

  // Nesting is a presentation nicety; SHOWING WHAT THE FILTERS KEPT is the job.
  // Resolving `shown` against `all` leans on the two sharing row identities, so
  // if that ever stops holding — a stage of `narrowStream` mapping instead of
  // filtering — the page must lose the nesting, never the rows.
  it("emits every shown row flat when the rows are not the page's own objects", () => {
    const copies = all.map((r) => ({ ...r }));
    const nested = nestSupplementary(copies, all, pairs);
    expect(keys(nested)).toEqual(["Normal:9001", "Normal:9002", "SupplementaryDamage:9001"]);
    expect(nested.some((r) => r.context)).toBe(false);
  });

  // A partial break is still a break: half the page resolved is not a page.
  it("keeps the whole page when only some rows are the page's own objects", () => {
    const nested = nestSupplementary([all[0], { ...all[1] }, all[2]], all, pairs);
    expect(keys(nested)).toEqual(["Normal:9001", "Normal:9002", "SupplementaryDamage:9001"]);
  });

  // The trigger is reachable twice — once on its own pass through the page, once
  // as the anchor its echo asks for — and both paths emit.
  it("emits a visible trigger exactly once", () => {
    const nested = nestSupplementary(all, all, pairs);
    expect(nested).toHaveLength(3);
    expect(nested.filter((r) => r.abilityKey === "Normal:9001")).toHaveLength(1);
    expect(nested.some((r) => r.context)).toBe(false);
    // Every row of the page, still exactly one apiece.
    expect(new Set(nested).size).toBe(3);
  });
});
