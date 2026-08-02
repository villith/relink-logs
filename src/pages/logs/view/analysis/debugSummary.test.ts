import { describe, expect, it } from "vitest";

import { formatChartDebug } from "./debugSummary";

const FACTS = {
  metric: "damage",
  level: "players",
  chart: "base" as const,
  series: 4,
  len: 450,
  shown: 450,
  window: null,
  scoped: false,
  spans: 0,
  actions: 0,
  bands: 0,
};

describe("formatChartDebug", () => {
  it("prints every fact as key=value, in a fixed order", () => {
    expect(formatChartDebug(FACTS)).toBe(
      "metric=damage level=players window=full chart=base series=4 len=450 shown=450 scoped=0 spans=0 actions=0 bands=0"
    );
  });

  it("names the committed window by its bucket bounds", () => {
    expect(formatChartDebug({ ...FACTS, window: [12, 48], shown: 37 })).toContain("window=12-48 ");
  });

  it("distinguishes a scoped refetch that still draws the base series", () => {
    // Stun with a source pinned: the fetch is scoped, but no per-metric
    // decomposition exists, so the plot is still the base load's curves. A
    // chart=base line with scoped=1 is the fingerprint of that case.
    expect(formatChartDebug({ ...FACTS, metric: "stun", scoped: true, chart: "base" })).toContain("chart=base series=4");
    expect(formatChartDebug({ ...FACTS, metric: "stun", scoped: true, chart: "base" })).toContain("scoped=1");
  });

  it("reports a drilled plot's own series count and length", () => {
    expect(formatChartDebug({ ...FACTS, level: "skills", chart: "drill", series: 3, len: 312, shown: 312 })).toBe(
      "metric=damage level=skills window=full chart=drill series=3 len=312 shown=312 scoped=0 spans=0 actions=0 bands=0"
    );
  });

  it("keeps a pin that expands to no actions visible", () => {
    // An ability pin the party never landed narrows the fetch to nothing, and
    // the plot empties with no other sign of why.
    expect(formatChartDebug({ ...FACTS, chart: "scoped", scoped: true, actions: 0, shown: 0, len: 0 })).toContain(
      "actions=0"
    );
  });
});
