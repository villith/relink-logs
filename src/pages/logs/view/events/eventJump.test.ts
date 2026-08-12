import { describe, expect, it } from "vitest";

import { parseTimeInput, rowAtTime, scrollTopFor } from "./eventJump";
import type { EventRow } from "./eventRows";
import type { NestedEventRow } from "./nestSupplementary";

const row = (over: Partial<EventRow> & { timeMs: number }): NestedEventRow => ({
  kind: "damage",
  sourceIndex: null,
  targetIndex: null,
  targetSpace: "actor",
  abilityKey: null,
  statusKey: null,
  statusId: null,
  detailKey: null,
  amount: null,
  // Jumping is about time, not caps; these rows carry nothing to explain.
  capHit: null,
  capConditions: null,
  ...over,
});

describe("parseTimeInput", () => {
  it("reads minutes and seconds", () => {
    expect(parseTimeInput("1:23")).toBe(83000);
  });

  it("reads fractional seconds after the colon", () => {
    expect(parseTimeInput("1:23.4")).toBe(83400);
  });

  it("reads a bare number as seconds", () => {
    expect(parseTimeInput("83")).toBe(83000);
  });

  it("reads an explicit seconds suffix", () => {
    expect(parseTimeInput("83s")).toBe(83000);
  });

  it("reads an explicit milliseconds suffix", () => {
    expect(parseTimeInput("83000ms")).toBe(83000);
  });

  it("ignores surrounding whitespace", () => {
    expect(parseTimeInput("  2:00  ")).toBe(120000);
  });

  // 75 seconds past the minute is not a clock reading — a stream whose column
  // prints 1:15 would never be found by typing 0:75, so accepting it would
  // scroll somewhere the reader did not ask for.
  it("rejects a seconds field of 60 or more", () => {
    expect(parseTimeInput("0:75")).toBeNull();
  });

  it("rejects a negative time", () => {
    expect(parseTimeInput("-5")).toBeNull();
  });

  it("rejects text that names no time", () => {
    expect(parseTimeInput("Fatal Ember")).toBeNull();
  });

  it("rejects an empty input", () => {
    expect(parseTimeInput("   ")).toBeNull();
  });
});

describe("rowAtTime", () => {
  const rows = [row({ timeMs: 1000 }), row({ timeMs: 2000 }), row({ timeMs: 3000 }), row({ timeMs: 4000 })];

  it("lands on the first row at or past the time", () => {
    expect(rowAtTime(rows, 2500)).toBe(2);
  });

  it("lands exactly on a row that carries the time", () => {
    expect(rowAtTime(rows, 2000)).toBe(1);
  });

  // Past the end there is nothing to scroll to — null is what leaves the view
  // where it was rather than pinning it to the last row.
  it("finds nothing past the last row", () => {
    expect(rowAtTime(rows, 99000)).toBeNull();
  });

  // A nested echo was MOVED under its trigger, so the list is not strictly
  // ascending. The scan still lands on the first row at or past the time
  // rather than assuming it can binary-search.
  it("lands on the first row at or past the time even where a child broke the order", () => {
    const nested = [
      row({ timeMs: 1000 }),
      row({ timeMs: 5000 }),
      { ...row({ timeMs: 5151 }), parent: { deltaMs: 151, sharePercent: 60 } },
      row({ timeMs: 2000 }),
    ];
    expect(rowAtTime(nested, 1500)).toBe(1);
  });
});

describe("scrollTopFor", () => {
  const VIEW = { rowHeight: 30, viewportHeight: 540, headHeight: 22, total: 1000 };

  it("centres the landed row in the space below the sticky header", () => {
    // 3000 down, less half of the 488px the header leaves for rows, less half
    // the row itself — so the row lands in the middle of what you can see.
    expect(scrollTopFor({ ...VIEW, index: 100 })).toBe(2756);
  });

  // Not past the top: a match in the first few rows is already on screen, and
  // a negative offset is not a scroll position.
  it("does not scroll above the top for an early match", () => {
    expect(scrollTopFor({ ...VIEW, index: 0 })).toBe(0);
  });

  it("does not scroll past the end of the list", () => {
    expect(scrollTopFor({ ...VIEW, index: 999 })).toBe(22 + 1000 * 30 - 540);
  });

  // Fewer rows than the viewport holds: there is nothing to scroll, and any
  // positive offset would scroll the whole list out of view.
  it("stays at the top when the whole list already fits", () => {
    expect(scrollTopFor({ ...VIEW, total: 3, index: 2 })).toBe(0);
  });
});
