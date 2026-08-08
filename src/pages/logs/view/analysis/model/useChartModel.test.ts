import { describe, expect, it } from "vitest";

import type { DrillSeries } from "../statusChart";

import { overlayOf } from "../chartPresentation";

const series = (key: string): DrillSeries[] => [{ key, label: key, values: [1] }];

describe("overlayOf", () => {
  it("is null when no builder produced a series", () => {
    // The per-player lines keep the plot; nothing overlays them.
    expect(overlayOf(null, null, null)).toBeNull();
  });

  it("prefers the pinned effect's stacks over every other overlay", () => {
    expect(overlayOf(series("status"), series("group"), series("ability"))?.[0].key).toBe("status");
  });

  it("falls through the chain in order", () => {
    expect(overlayOf(null, series("group"), series("ability"))?.[0].key).toBe("group");
    expect(overlayOf(null, null, series("ability"))?.[0].key).toBe("ability");
  });

  it("returns the winning array BY REFERENCE", () => {
    // Load-bearing: `chartPresentation` recognises which plot it is by
    // comparing `overlay === statusSeries` and friends. Rebuilding the array
    // here would silently reclassify the chart — and with it the title, the
    // axis format and whether a Total series is drawn.
    const status = series("status");
    expect(overlayOf(status, null, null)).toBe(status);
    const ability = series("ability");
    expect(overlayOf(null, null, ability)).toBe(ability);
  });

  it("treats an EMPTY series array as a real overlay, not as absent", () => {
    // The builders return null for "nothing to draw" and never an empty array,
    // so `[]` reaching here would mean a builder changed its contract — it must
    // not silently fall through to the next one.
    const empty: DrillSeries[] = [];
    expect(overlayOf(empty, series("group"), null)).toBe(empty);
  });
});
