import { describe, expect, it } from "vitest";

import type { MetricRow } from "../metrics/types";

import type { Lane } from "./laneMarks";
import { laneRows } from "./laneRows";

const lane = (key: string, kind?: MetricRow["kind"]): Lane => ({
  row: { key, label: key, value: 0, columns: [], pinOnClick: null, colorSlot: -1, ...(kind ? { kind } : {}) },
  marks: [],
  spans: false,
});

describe("laneRows", () => {
  it("returns one entry per lane when there are no sections", () => {
    expect(laneRows([lane("a"), lane("b")], undefined).map((row) => row.kind)).toEqual(["lane", "lane"]);
  });

  // A heading is emitted only where the section CHANGES, so a run shares one.
  it("emits a heading only where the section changes", () => {
    const lanes = [lane("a", "ability"), lane("b", "ability"), lane("c", "status")];
    const rows = laneRows(lanes, (row) => (row.kind === "status" ? "Effects" : "Abilities"));
    expect(rows.map((row) => (row.kind === "heading" ? `H:${row.label}` : `L:${row.lane.row.key}`))).toEqual([
      "H:Abilities",
      "L:a",
      "L:b",
      "H:Effects",
      "L:c",
    ]);
  });

  // Both columns key their React children off this, so every entry needs an id
  // unique across BOTH kinds.
  it("gives every entry a distinct key", () => {
    const lanes = [lane("a", "ability"), lane("b", "status")];
    const rows = laneRows(lanes, (row) => (row.kind === "status" ? "Effects" : "Abilities"));
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  // A resolver that answers null for some rows must not emit a heading for
  // them, and must not suppress the next real one either.
  it("skips rows the resolver does not name", () => {
    const lanes = [lane("a", "ability"), lane("b", "status")];
    const rows = laneRows(lanes, (row) => (row.kind === "status" ? "Effects" : null));
    expect(rows.map((row) => row.kind)).toEqual(["lane", "heading", "lane"]);
  });

  it("returns nothing for no lanes", () => {
    expect(laneRows([], undefined)).toEqual([]);
  });
});
