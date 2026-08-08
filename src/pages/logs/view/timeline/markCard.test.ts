import { describe, expect, it } from "vitest";

import type { LaneMark } from "./laneMarks";
import { markCardSections } from "./markCard";

/** A mark with the fields these cases are not about already filled in — the
 * card reads `by` and `count`, and nothing else. */
const mark = (over: Partial<LaneMark>): LaneMark => ({
  startMs: 0,
  endMs: 0,
  count: 1,
  amount: null,
  by: [],
  hits: [],
  casts: 1,
  castKey: "",
  ...over,
});

const NAMES = (key: string) => ({ name: `named(${key})`, iconUrl: `/${key}.png` });

describe("markCardSections", () => {
  it("builds one section listing the mark's parts", () => {
    const sections = markCardSections(
      mark({ endMs: 100, count: 3, amount: 30, by: [{ key: "A", count: 2, amount: 20 }] }),
      { color: "#36B37E", entry: NAMES }
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]?.entries).toEqual([{ key: "A", label: "named(A)", value: 20, icon: "/A.png" }]);
  });

  it("colours the section with the lane's own colour", () => {
    const sections = markCardSections(mark({ amount: 5, by: [{ key: "A", count: 1, amount: 5 }] }), {
      color: "#F06595",
      entry: NAMES,
    });
    expect(sections[0]?.color).toBe("#F06595");
  });

  // `LaneMark.by` is already sorted largest-first; the card must not re-order.
  it("keeps the parts in the order it was given them", () => {
    const sections = markCardSections(
      mark({
        count: 2,
        amount: 30,
        by: [
          { key: "B", count: 1, amount: 20 },
          { key: "A", count: 1, amount: 10 },
        ],
      }),
      { color: "#000", entry: NAMES }
    );
    expect(sections[0]?.entries.map((entry) => entry.key)).toEqual(["B", "A"]);
  });

  // A span mark has no parts. An empty section list is what makes HoverCard
  // render the row alone rather than an empty card (see its own early return).
  it("builds no section for a mark with no parts", () => {
    expect(markCardSections(mark({ endMs: 4000 }), { color: "#000", entry: NAMES })).toEqual([]);
  });

  // An entry with no art stays text-only rather than reserving a blank box.
  it("omits the icon when the resolver has none", () => {
    const sections = markCardSections(mark({ amount: 5, by: [{ key: "A", count: 1, amount: 5 }] }), {
      color: "#000",
      entry: () => ({ name: "bare" }),
    });
    expect(sections[0]?.entries[0]).toEqual({ key: "A", label: "bare", value: 5 });
  });
});
