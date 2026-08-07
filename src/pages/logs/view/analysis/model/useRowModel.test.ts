import { describe, expect, it } from "vitest";

import type { MetricRow } from "../../metrics/types";

import { rowKindOf } from "./useRowModel";

const row = (over: Partial<MetricRow>): MetricRow => ({
  key: "k",
  label: "l",
  value: 0,
  columns: [],
  pinOnClick: null,
  colorSlot: -1,
  ...over,
});

describe("rowKindOf", () => {
  it("prefers the row's own declared kind", () => {
    // The groups path declares a kind per row, and it outranks the table's:
    // one level can produce more than one shape of row.
    expect(rowKindOf(row({ kind: "takenAttack" }), "player")).toBe("takenAttack");
  });

  it("falls back to the table's kind where the row declares none", () => {
    expect(rowKindOf(row({}), "status")).toBe("status");
  });

  it("answers identically for a label and an icon asked about one row", () => {
    // The property that matters: renderLabel and rowIconUrl both go through
    // this, so a row can never pair one kind's name with another kind's art.
    const subject = row({ kind: "enemy" });
    expect(rowKindOf(subject, "ability")).toBe(rowKindOf(subject, "ability"));
  });
});
