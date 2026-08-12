import { describe, expect, it } from "vitest";

import { applyColumnFilters, columnOptions, columnToken, facetFor, filteredColumns } from "./columnFilters";
import type { EventRow } from "./eventRows";

const row = (over: Partial<EventRow> & { timeMs: number }): EventRow => ({
  kind: "damage",
  sourceIndex: null,
  targetIndex: null,
  targetSpace: "actor",
  abilityKey: null,
  statusKey: null,
  statusId: null,
  detailKey: null,
  amount: null,
  // A row with no cap to explain, which is what every non-damage kind is and
  // what a damage row from a log predating the capture degrades to.
  capHit: null,
  capConditions: null,
  ...over,
});

const NAMING = {
  ability: (key: string) => ({ name: `ability-${key}`, iconUrl: `/${key}.png` }),
  status: (key: string) => ({ name: `status-${key}` }),
  actor: (index: number, _atMs: number, space: "actor" | "spawn") => ({ name: `actor-${index}-${space}` }),
};

describe("columnToken", () => {
  it("names a row's source by its index", () => {
    expect(columnToken(row({ timeMs: 0, sourceIndex: 4 }), "source")).toBe("4");
  });

  it("names a row's ability by its key", () => {
    expect(columnToken(row({ timeMs: 0, abilityKey: "Normal:100" }), "ability")).toBe("Normal:100");
  });

  // An effect row names an EFFECT in the same column, through the same grammar
  // the buffs tables pin — so one filter covers both kinds of row.
  it("names an effect row's ability column by its effect key", () => {
    expect(columnToken(row({ timeMs: 0, statusKey: "status:77:210:4242" }), "ability")).toBe("status:77:210:4242");
  });

  // The two capture paths do NOT share an index space (see `ActorSpace`), so a
  // bare number cannot say which spawn it means — the space travels with it.
  it("carries the index space in a target's token", () => {
    expect(columnToken(row({ timeMs: 0, targetIndex: 9, targetSpace: "spawn" }), "target")).toBe("spawn:9");
    expect(columnToken(row({ timeMs: 0, targetIndex: 9, targetSpace: "actor" }), "target")).toBe("actor:9");
  });

  it("names nothing for a column the row has no value in", () => {
    expect(columnToken(row({ timeMs: 0 }), "source")).toBeNull();
    expect(columnToken(row({ timeMs: 0 }), "ability")).toBeNull();
    expect(columnToken(row({ timeMs: 0 }), "target")).toBeNull();
  });
});

describe("columnOptions", () => {
  const rows = [
    row({ timeMs: 0, sourceIndex: 0, abilityKey: "Normal:100", targetIndex: 9, targetSpace: "spawn" }),
    row({ timeMs: 1, sourceIndex: 0, abilityKey: "Normal:100", targetIndex: 9, targetSpace: "spawn" }),
    row({ timeMs: 2, sourceIndex: 1, abilityKey: "Normal:200", targetIndex: 9, targetSpace: "spawn" }),
    row({ timeMs: 3, sourceIndex: 1, statusKey: "status:77:210:4242", targetIndex: 1 }),
  ];

  it("offers every distinct value in the column, most frequent first", () => {
    expect(columnOptions(rows, NAMING, "source").map((option) => option.label)).toEqual([
      "actor-0-actor",
      "actor-1-actor",
    ]);
  });

  it("counts the rows each option would keep", () => {
    expect(columnOptions(rows, NAMING, "ability").map((option) => option.count)).toEqual([2, 1, 1]);
  });

  it("names an effect option through the status resolver", () => {
    const labels = columnOptions(rows, NAMING, "ability").map((option) => option.label);
    expect(labels).toContain("status-status:77:210:4242");
  });

  it("carries the option's own art, so the menu is pictured like the rows", () => {
    expect(columnOptions(rows, NAMING, "ability")[0].iconUrl).toBe("/Normal:100.png");
  });

  it("resolves a target through the space its own row declares", () => {
    expect(columnOptions(rows, NAMING, "target").map((option) => option.label)).toEqual([
      "actor-9-spawn",
      "actor-1-actor",
    ]);
  });

  // Two values the game names identically are one line in the menu — ticking it
  // must keep BOTH, or the count beside it is a lie.
  it("folds values that share a name into one option carrying both tokens", () => {
    const shared = [row({ timeMs: 0, abilityKey: "Normal:100" }), row({ timeMs: 1, abilityKey: "Normal:101" })];
    const naming = { ...NAMING, ability: () => ({ name: "Fatal Ember" }) };
    expect(columnOptions(shared, naming, "ability")).toEqual([
      { label: "Fatal Ember", count: 2, iconUrl: undefined, tokens: ["Normal:100", "Normal:101"] },
    ]);
  });

  it("offers nothing for a column no row carries", () => {
    expect(columnOptions([row({ timeMs: 0 })], NAMING, "source")).toEqual([]);
  });
});

describe("applyColumnFilters", () => {
  const rows = [
    row({ timeMs: 0, sourceIndex: 0, abilityKey: "Normal:100" }),
    row({ timeMs: 1, sourceIndex: 1, abilityKey: "Normal:100" }),
    row({ timeMs: 2, sourceIndex: 1, abilityKey: "Normal:200" }),
    row({ timeMs: 3 }),
  ];

  it("keeps everything when nothing is ticked", () => {
    expect(applyColumnFilters(rows, {})).toEqual(rows);
  });

  // Unticking the last box is "no filter", not "match nothing" — an empty table
  // with an empty menu gives the reader nothing to undo.
  it("treats an empty selection as no filter at all", () => {
    expect(applyColumnFilters(rows, { source: new Set() })).toEqual(rows);
  });

  it("keeps only the rows a ticked value names", () => {
    expect(applyColumnFilters(rows, { source: new Set(["1"]) }).map((kept) => kept.timeMs)).toEqual([1, 2]);
  });

  it("keeps a row matching any of several ticked values", () => {
    expect(applyColumnFilters(rows, { source: new Set(["0", "1"]) }).map((kept) => kept.timeMs)).toEqual([0, 1, 2]);
  });

  it("narrows by every filtered column at once", () => {
    const kept = applyColumnFilters(rows, { source: new Set(["1"]), ability: new Set(["Normal:100"]) });
    expect(kept.map((match) => match.timeMs)).toEqual([1]);
  });

  // A row that cannot answer a filtered column belongs to none of its values —
  // keeping it would read as the filter having failed to apply.
  it("drops a row that carries nothing in a filtered column", () => {
    expect(applyColumnFilters(rows, { source: new Set(["0"]) }).map((kept) => kept.timeMs)).toEqual([0]);
  });
});

describe("facetFor", () => {
  const rows = [
    row({ timeMs: 0, sourceIndex: 0, abilityKey: "Normal:100" }),
    row({ timeMs: 1, sourceIndex: 1, abilityKey: "Normal:100" }),
    row({ timeMs: 2, sourceIndex: 1, abilityKey: "Normal:200" }),
  ];

  // What the menu counts against. Narrowed by the OTHER columns, so the numbers
  // beside each value answer "how many would I get, given what is already
  // ticked elsewhere" rather than restating the unfiltered stream.
  it("applies the other columns' filters", () => {
    const kept = facetFor(rows, { source: new Set(["1"]) }, "ability");
    expect(kept.map((match) => match.timeMs)).toEqual([1, 2]);
  });

  // But NOT its own. Counting a column against its own ticks would zero every
  // box the reader had not ticked and drop them out of the menu they were about
  // to tick them in.
  it("ignores the filter belonging to the column being counted", () => {
    const kept = facetFor(rows, { ability: new Set(["Normal:100"]) }, "ability");
    expect(kept.map((match) => match.timeMs)).toEqual([0, 1, 2]);
  });

  it("applies the others while still ignoring its own", () => {
    const kept = facetFor(rows, { source: new Set(["1"]), ability: new Set(["Normal:100"]) }, "ability");
    expect(kept.map((match) => match.timeMs)).toEqual([1, 2]);
  });

  it("keeps everything when no other column is filtered", () => {
    expect(facetFor(rows, {}, "source")).toEqual(rows);
  });
});

describe("filteredColumns", () => {
  it("counts only the columns with something actually ticked", () => {
    expect(filteredColumns({ source: new Set(["1"]), ability: new Set(), target: undefined })).toBe(1);
  });

  it("counts nothing for a filter set that narrows nothing", () => {
    expect(filteredColumns({})).toBe(0);
  });
});
