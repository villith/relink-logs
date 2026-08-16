import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { StatusInterval } from "@/types";

import { statusPinKey } from "../../statusUptime";
import { DEFAULT_STATE, type AnalysisState } from "../machine/state";

import { combineMasks, intersectMasks, useFilterChips } from "./useFilterWindows";

describe("combineMasks", () => {
  it("is undefined when neither filter is active", () => {
    // Undefined means "no filter at all", which is the only value that leaves
    // the fight whole. It must never be confused with an empty mask.
    expect(combineMasks(undefined, undefined)).toBeUndefined();
  });

  it("passes either filter through alone, by reference", () => {
    // By reference on purpose: the caller memoises these, and rebuilding one
    // here would give every consumer a fresh identity each render.
    const aura = [{ fromMs: 0, upToMs: 10 }];
    const windows = [{ fromMs: 5, upToMs: 20 }];
    expect(combineMasks(aura, undefined)).toBe(aura);
    expect(combineMasks(undefined, windows)).toBe(windows);
  });

  it("intersects when both are active", () => {
    expect(combineMasks([{ fromMs: 0, upToMs: 10 }], [{ fromMs: 5, upToMs: 20 }])).toEqual([{ fromMs: 5, upToMs: 10 }]);
  });

  it("keeps an EMPTY mask, which narrows to nothing", () => {
    // An empty array is a real answer — the effect was never up inside the
    // window, or the chip resolved to a stale index — and the aggregator masks
    // everything for it. Narrowing, never widening.
    expect(combineMasks([], undefined)).toEqual([]);
    expect(combineMasks(undefined, [])).toEqual([]);
  });

  it("intersects an empty mask to empty rather than falling back to the other", () => {
    // The trap this guards: treating [] as falsy would widen the fight back to
    // the other filter's spans, showing damage the active filter excluded.
    expect(combineMasks([], [{ fromMs: 0, upToMs: 10 }])).toEqual([]);
  });

  it("drops spans that do not overlap at all", () => {
    expect(combineMasks([{ fromMs: 0, upToMs: 5 }], [{ fromMs: 10, upToMs: 20 }])).toEqual([]);
  });
});

describe("intersectMasks", () => {
  it("is undefined with no masks — no aura filter, rather than an empty one", () => {
    expect(intersectMasks([])).toBeUndefined();
  });

  it("passes a lone mask through by reference", () => {
    const only = [{ fromMs: 0, upToMs: 10 }];
    expect(intersectMasks([only])).toBe(only);
  });

  it("folds three masks into the time ALL of them were up", () => {
    // What the multi-select is for: "what did we do under the full stack",
    // which a union could not answer.
    expect(
      intersectMasks([[{ fromMs: 0, upToMs: 100 }], [{ fromMs: 20, upToMs: 80 }], [{ fromMs: 50, upToMs: 200 }]])
    ).toEqual([{ fromMs: 50, upToMs: 80 }]);
  });

  it("a stack that never lined up is EMPTY, not absent", () => {
    // Empty narrows the view to nothing, which is the honest reading — falling
    // back to a wider mask would show damage the filter excluded.
    expect(intersectMasks([[{ fromMs: 0, upToMs: 10 }], [{ fromMs: 50, upToMs: 60 }]])).toEqual([]);
  });

  it("keeps every disjoint stretch where the stack held", () => {
    expect(
      intersectMasks([
        [
          { fromMs: 0, upToMs: 30 },
          { fromMs: 60, upToMs: 90 },
        ],
        [
          { fromMs: 10, upToMs: 70 },
          { fromMs: 80, upToMs: 100 },
        ],
      ])
    ).toEqual([
      { fromMs: 10, upToMs: 30 },
      { fromMs: 60, upToMs: 70 },
      { fromMs: 80, upToMs: 90 },
    ]);
  });
});

describe("useFilterChips — the aura strips", () => {
  const interval = (over: Partial<StatusInterval>): StatusInterval => ({
    actorIndex: 1,
    casterIndex: null,
    statusId: 4,
    abilityId: null,
    statusClass: null,
    casterActionId: null,
    startMs: 0,
    endMs: 5_000,
    maxStacks: 1,
    targetSegment: null,
    applications: 1,
    ...over,
  });

  const chips = (state: Partial<AnalysisState>, intervals: StatusInterval[]) => {
    const { result } = renderHook(() =>
      useFilterChips({
        state: { ...DEFAULT_STATE, ...state },
        hostility: "friendly",
        supportsAuraFilter: true,
        windowedIntervals: intervals,
        fightDurationMs: 10_000,
        chartWindows: [],
        statusDisplayLabel: (key) => key,
        breakEnemyOf: () => null,
      })
    );
    return result.current.sourceAuraChips;
  };

  const HELD = statusPinKey({ statusId: 4, abilityId: null, statusClass: null });
  const NEVER = statusPinKey({ statusId: 9, abilityId: null, statusClass: null });

  it("offers what the pinned actor held, with its uptime", () => {
    const shown = chips({ source: 1 }, [interval({})]);
    expect(shown.map((chip) => chip.aura)).toEqual([`src:${HELD}`]);
    expect(shown[0].uptimePercent).toBe(50);
  });

  // The filter is live either way — an effect this actor never held masks the
  // fight to nothing — so without the chip the pane empties with nothing on
  // screen saying why and nothing to click to undo it. Reachable by scrubbing
  // past the effect, and by a single-chart comparison whose panes pick their
  // sources independently while sharing one aura filter.
  it("still shows a SELECTED effect this actor never held, at 0%", () => {
    const shown = chips({ source: 1, aura: [`src:${NEVER}`] }, [interval({})]);
    expect(shown.map((chip) => chip.aura)).toEqual([`src:${HELD}`, `src:${NEVER}`]);
    expect(shown[1]).toMatchObject({ selected: true, uptimePercent: 0 });
  });

  it("keeps the other strip's selection off this one", () => {
    const shown = chips({ source: 1, aura: [`tgt:${NEVER}`] }, [interval({})]);
    expect(shown.map((chip) => chip.aura)).toEqual([`src:${HELD}`]);
  });
});
