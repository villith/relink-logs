import { describe, expect, it } from "vitest";

import type { MetricRow } from "../metrics/types";

import { laneShapeOf } from "./laneShape";

const row = (over: Partial<MetricRow>): MetricRow => ({
  key: "",
  label: "",
  value: 0,
  columns: [],
  pinOnClick: null,
  colorSlot: -1,
  ...over,
});

describe("laneShapeOf", () => {
  // A row that pools many abilities cannot name its buckets with art — every
  // one of them is a different skill.
  it.each(["player", "enemy", "target", "takenAttack"] as const)("draws a %s row as plain buckets", (kind) => {
    expect(laneShapeOf(row({ kind }))).toBe("buckets");
  });

  // One skill, so every bucket in the lane can carry that skill's own art.
  it("draws an ability row with its art", () => {
    expect(laneShapeOf(row({ kind: "ability" }))).toBe("icons");
  });

  // A row carrying real spans is not an event fold at all, whatever kind it
  // claims — the aura tables' rows say "status", the stun table's say nothing.
  it("draws any row with its own timeline as spans", () => {
    expect(laneShapeOf(row({ kind: "player", timeline: [{ startMs: 0, endMs: 10 }] }))).toBe("spans");
  });

  // The derived metrics leave `kind` off their rows and lean on the view's.
  it("falls back to the view's kind when the row declares none", () => {
    expect(laneShapeOf(row({}), "player")).toBe("buckets");
    expect(laneShapeOf(row({}), "ability")).toBe("icons");
  });

  // The row's own kind is the more specific answer and has to win: one level
  // can produce more than one shape of row.
  it("prefers the row's own kind to the view's", () => {
    expect(laneShapeOf(row({ kind: "ability" }), "player")).toBe("icons");
  });

  it("draws an unclassifiable row as an ability lane", () => {
    expect(laneShapeOf(row({}))).toBe("icons");
  });
});
