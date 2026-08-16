import { describe, expect, it } from "vitest";

import type { SelectorPins } from "../../selectorOptions";

import { LINKED_DIMS, applyPinChange, pinChangesOf, splitPinChanges, type PinChange } from "./linkedPins";
import { DEFAULT_STATE, type AnalysisState } from "./state";

const state = (over: Partial<AnalysisState>): AnalysisState => ({ ...DEFAULT_STATE, ...over });

const pins = (over: Partial<SelectorPins>): SelectorPins => ({ source: null, targets: [], ability: null, ...over });

describe("LINKED_DIMS", () => {
  // One chart means one question: both lines have to answer it. The source is
  // the exception — each pane picks one from its own log, and one player read
  // against another is a comparison the overlay exists to draw.
  it("shares the target and the ability, and never the source", () => {
    expect(LINKED_DIMS.has("target")).toBe(true);
    expect(LINKED_DIMS.has("ability")).toBe(true);
    expect(LINKED_DIMS.has("source")).toBe(false);
  });
});

describe("pinChangesOf", () => {
  it("reports only the dimension that moved", () => {
    expect(pinChangesOf(state({ source: 1, target: 3 }), pins({ source: 1, targets: [5] }))).toEqual([
      { dim: "target", value: 5 },
    ]);
  });

  // Re-selecting what is already pinned must run no transition at all: `pinRow`
  // keeps the auras anchored to an unchanged value, but a clear-and-repin would
  // drop them.
  it("reports nothing when the selection is unchanged", () => {
    expect(
      pinChangesOf(
        state({ source: 1, target: 3, ability: "skill:9" }),
        pins({ source: 1, targets: [3], ability: "skill:9" })
      )
    ).toEqual([]);
  });

  it("reads an emptied target list as a clear", () => {
    expect(pinChangesOf(state({ target: 3 }), pins({ targets: [] }))).toEqual([{ dim: "target", value: null }]);
  });

  it("reports every dimension that moved, in dimension order", () => {
    expect(pinChangesOf(state({}), pins({ source: 2, targets: [4], ability: "skill:9" }))).toEqual([
      { dim: "source", value: 2 },
      { dim: "target", value: 4 },
      { dim: "ability", value: "skill:9" },
    ]);
  });
});

describe("splitPinChanges", () => {
  const changes: PinChange[] = [
    { dim: "source", value: 2 },
    { dim: "target", value: 4 },
    { dim: "ability", value: "skill:9" },
  ];

  it("keeps everything with this pane when nothing is linked", () => {
    expect(splitPinChanges(changes, false)).toEqual({ own: changes, shared: [] });
  });

  it("sends the target and the ability on, and keeps the source", () => {
    expect(splitPinChanges(changes, true)).toEqual({
      own: [{ dim: "source", value: 2 }],
      shared: [
        { dim: "target", value: 4 },
        { dim: "ability", value: "skill:9" },
      ],
    });
  });
});

describe("applyPinChange", () => {
  it("pins a value and clears the by override so the drill advances", () => {
    const after = applyPinChange(state({ by: "source" }), { dim: "target", value: 4 });
    expect(after.target).toBe(4);
    expect(after.by).toBeNull();
  });

  it("clears the dimension on a null value", () => {
    expect(applyPinChange(state({ ability: "skill:9" }), { dim: "ability", value: null }).ability).toBeNull();
  });

  // The auras anchored to a pin belong to the actor it named, so a CHANGE of
  // actor drops them — the same rule `pinRow`/`clearPin` already carry, reached
  // through this router.
  it("drops the auras anchored to a target it moves", () => {
    const before = state({ target: 3, aura: ["tgt:status:4:1:unknown", "src:status:7:1:unknown"] });
    expect(applyPinChange(before, { dim: "target", value: 5 }).aura).toEqual(["src:status:7:1:unknown"]);
  });
});
