import { describe, expect, it } from "vitest";

import { chartPresentation } from "./chartPresentation";
import type { DrillSeries } from "./statusChart";

const series = (key: string): DrillSeries[] => [{ key, label: key, values: [1, 2] }];

/** The friendly groups-path source grouping: the case that draws independent
 * per-player LINES, which is the only place a Total series belongs. */
const base = {
  statusSeries: null,
  groupOverlay: null,
  abilitySeries: null,
  groupPlayerSeries: null,
  groupsPath: true,
  groupBy: "source" as const,
  hostility: "friendly" as const,
  metricFormat: "amount" as const,
  rateSmoothing: 10,
};

describe("chartPresentation — chartSource", () => {
  it("reads 'base' with no overlay and no group series", () => {
    expect(chartPresentation(base).chartSource).toBe("base");
  });

  it("reads 'scoped' when the groups path supplied per-player lines", () => {
    expect(chartPresentation({ ...base, groupPlayerSeries: { 0: [1, 2] } }).chartSource).toBe("scoped");
  });

  it("reads 'stacks' for the pinned effect's per-holder series", () => {
    expect(chartPresentation({ ...base, statusSeries: series("player:0") }).chartSource).toBe("stacks");
  });

  it("reads 'base' on a status tab with no effect pinned", () => {
    // The aura tabs used to overlay the effects THEMSELVES as holder counts
    // here. They no longer do: with nothing pinned the tab keeps the metric's
    // own damage plot as the context for reading the table beneath it, and
    // only a pinned effect switches the chart to stack depths.
    expect(chartPresentation({ ...base, groupsPath: false }).chartSource).toBe("base");
  });

  it("reads 'drill' for the fetched aggregates' bands", () => {
    expect(chartPresentation({ ...base, groupOverlay: series("skill:1") }).chartSource).toBe("drill");
  });

  it("prefers the status series over the group series", () => {
    const statusSeries = series("player:0");
    const result = chartPresentation({
      ...base,
      statusSeries,
      groupOverlay: series("skill:1"),
    });
    expect(result.overlay).toBe(statusSeries);
    expect(result.chartSource).toBe("stacks");
  });

  it("classifies by REFERENCE, so a rebuilt array is not mistaken for another series", () => {
    // `overlay` is whichever input won, and the "stacks" test is
    // `overlay === statusSeries`. A tidy-up that copied the arrays on the way
    // in — or on the way out — would leave the group bands matching nothing
    // and every stacks chart reading as a drill.
    const statusSeries = series("player:0");
    const groupOverlay = [...series("skill:1")];
    const stacks = chartPresentation({ ...base, statusSeries });
    const drill = chartPresentation({ ...base, groupOverlay });

    expect(stacks.overlay).toBe(statusSeries);
    expect(drill.overlay).toBe(groupOverlay);
    // Structurally identical bands still classify by which input they came
    // from, never by their shape.
    expect(chartPresentation({ ...base, groupOverlay: series("status:12") }).chartSource).toBe("drill");
  });

  it("plots no overlay when every series is absent", () => {
    expect(chartPresentation(base).overlay).toBeNull();
  });
});

describe("chartPresentation — withTotal", () => {
  it("draws the Total on the friendly groups path grouped by source", () => {
    expect(chartPresentation(base).withTotal).toBe(true);
  });

  it("draws the Total over the groups path's own per-player lines", () => {
    // "scoped" is still independent lines, so the Total is still meaningful.
    expect(chartPresentation({ ...base, groupPlayerSeries: { 0: [1, 2] } }).withTotal).toBe(true);
  });

  it("withholds the Total on the enemy side", () => {
    expect(chartPresentation({ ...base, hostility: "enemy" }).withTotal).toBe(false);
  });

  it("withholds the Total from a drill, where it would double the stack", () => {
    // A Total series inside a Mantine stacked AreaChart is ADDED to the stack.
    const drill = chartPresentation({ ...base, groupOverlay: series("skill:1") });
    expect(drill.stacked).toBe(true);
    expect(drill.withTotal).toBe(false);
  });

  it("withholds the Total from the aura stacks", () => {
    expect(chartPresentation({ ...base, statusSeries: series("player:0") }).withTotal).toBe(false);
  });

  it("withholds the Total from any grouping other than source", () => {
    expect(chartPresentation({ ...base, groupBy: "ability" }).withTotal).toBe(false);
    expect(chartPresentation({ ...base, groupBy: "target" }).withTotal).toBe(false);
  });

  it("withholds the Total off the groups path, where the lines are the base chart's", () => {
    expect(chartPresentation({ ...base, groupsPath: false }).withTotal).toBe(false);
  });
});

describe("chartPresentation — format and stacked", () => {
  it("keeps the metric's own format for the base chart", () => {
    expect(chartPresentation({ ...base, metricFormat: "percent" }).format).toBe("percent");
    expect(chartPresentation({ ...base, metricFormat: "amount" }).format).toBe("amount");
  });

  it("reads a stack depth as a plain count", () => {
    // A percent sign would misdescribe it and humanizeNumber would print "3.0".
    expect(chartPresentation({ ...base, statusSeries: series("player:0"), metricFormat: "percent" }).format).toBe(
      "count"
    );
  });

  it("reads a drill's bands as an amount", () => {
    expect(chartPresentation({ ...base, groupOverlay: series("skill:1"), metricFormat: "percent" }).format).toBe(
      "amount"
    );
  });

  it("stacks exactly when there is an overlay", () => {
    expect(chartPresentation(base).stacked).toBe(false);
    expect(chartPresentation({ ...base, groupPlayerSeries: { 0: [1, 2] } }).stacked).toBe(false);
    expect(chartPresentation({ ...base, statusSeries: series("player:0") }).stacked).toBe(true);
    expect(chartPresentation({ ...base, groupOverlay: series("skill:1") }).stacked).toBe(true);
  });
});

describe("chartPresentation — the ability drill", () => {
  it("stacks the derived tabs' per-ability bands", () => {
    const result = chartPresentation({ ...base, abilitySeries: series("skill:1") });

    expect(result.chartSource).toBe("ability");
    expect(result.stacked).toBe(true);
  });

  it("switches a drilled SBA chart from the gauge level to an amount", () => {
    // Undrilled the SBA chart plots a LEVEL (percent), which cannot be
    // decomposed by contributor; drilled it plots generation, which is a rate.
    const sba = { ...base, metricFormat: "percent" as const };

    expect(chartPresentation(sba).format).toBe("percent");
    expect(chartPresentation({ ...sba, abilitySeries: series("skill:1") }).format).toBe("amount");
  });

  it("never draws a Total beside the stack", () => {
    // A Total inside a Mantine stacked AreaChart is ADDED to the stack and
    // doubles its height.
    expect(chartPresentation({ ...base, abilitySeries: series("skill:1") }).withTotal).toBe(false);
  });

  it("yields to an aura overlay", () => {
    // The aura tabs never drill by ability; this only pins the precedence.
    const result = chartPresentation({
      ...base,
      statusSeries: series("player:0"),
      abilitySeries: series("skill:1"),
    });

    expect(result.chartSource).toBe("stacks");
  });
});

describe("chartPresentation — smoothing", () => {
  it("smooths a rate chart over the trailing window", () => {
    expect(chartPresentation(base).smoothing).toBe(10);
  });

  it("leaves the SBA gauge LEVEL untouched", () => {
    // Smoothing would round off the discharge that IS the reading.
    const sba = { ...base, metricKey: "sba" as const, metricFormat: "percent" as const };

    expect(chartPresentation(sba).smoothing).toBe(1);
  });

  it("smooths a DRILLED SBA chart — it plots generation, which is a rate", () => {
    // The axis switch is not only the format: undrilled this is a level and must
    // not be smoothed, drilled it is a per-second rate like DPS and stun. Left
    // unsmoothed it drew raw per-hit gain bursts, one spike per bucket.
    const sba = { ...base, metricKey: "sba" as const, metricFormat: "percent" as const };

    expect(chartPresentation({ ...sba, abilitySeries: series("skill:1") }).smoothing).toBe(10);
  });

  it("leaves stack counts untouched", () => {
    // A stack count is a level too: averaged, a buff held one second at four
    // stacks reads as one, and every edge of a step function becomes a ramp.
    expect(chartPresentation({ ...base, statusSeries: series("player:0") }).smoothing).toBe(1);
  });

  it("honours a custom window on a rate chart", () => {
    // The chart's smoothing control feeds `rateSmoothing`, so the user's choice
    // reaches every RATE chart through the one existing decision.
    expect(chartPresentation({ ...base, rateSmoothing: 30 }).smoothing).toBe(30);
  });

  it("ignores a custom window on a LEVEL chart", () => {
    // Smoothing a level is wrong at any window, so the control cannot reach one
    // — which is why the choice rides `rateSmoothing` rather than overriding
    // the result.
    const sba = { ...base, metricKey: "sba" as const, metricFormat: "percent" as const, rateSmoothing: 30 };

    expect(chartPresentation(sba).smoothing).toBe(1);
    expect(chartPresentation({ ...base, statusSeries: series("player:0"), rateSmoothing: 30 }).smoothing).toBe(1);
  });

  it("smooths the damage drill's bands", () => {
    expect(chartPresentation({ ...base, groupOverlay: series("skill:1") }).smoothing).toBe(10);
  });
});
