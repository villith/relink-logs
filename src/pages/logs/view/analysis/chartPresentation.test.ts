import { describe, expect, it } from "vitest";

import { chartPresentation } from "./chartPresentation";
import type { DrillSeries } from "./statusChart";

const series = (key: string): DrillSeries[] => [{ key, label: key, values: [1, 2] }];

/** The friendly groups-path source grouping: the case that draws independent
 * per-player LINES, which is the only place a Total series belongs. */
const base = {
  statusSeries: null,
  effectSeries: null,
  groupOverlay: null,
  abilitySeries: null,
  groupPlayerSeries: null,
  groupsPath: true,
  groupBy: "source" as const,
  hostility: "friendly" as const,
  metricKey: "damage" as const,
  level: "players" as const,
  metricLabelKey: "ui.logs.chart-dps-label",
  metricFormat: "amount" as const,
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

  it("reads 'stacks' for the unpinned effect series too", () => {
    // BOTH aura plots are stacks: the pinned effect's holder depths and the
    // top-level effects-as-holder-counts chart. Only the group bands drill.
    expect(chartPresentation({ ...base, effectSeries: series("status:12") }).chartSource).toBe("stacks");
  });

  it("reads 'drill' for the fetched aggregates' bands", () => {
    expect(chartPresentation({ ...base, groupOverlay: series("skill:1") }).chartSource).toBe("drill");
  });

  it("prefers the status series over the effect and group series", () => {
    const statusSeries = series("player:0");
    const result = chartPresentation({
      ...base,
      statusSeries,
      effectSeries: series("status:12"),
      groupOverlay: series("skill:1"),
    });
    expect(result.overlay).toBe(statusSeries);
    expect(result.chartSource).toBe("stacks");
  });

  it("classifies by REFERENCE, so a rebuilt array is not mistaken for another series", () => {
    // `overlay` is whichever input won, and the "stacks" test is
    // `overlay === statusSeries || overlay === effectSeries`. A tidy-up that
    // copied the arrays on the way in — or on the way out — would leave the
    // group bands matching nothing and every stacks chart reading as a drill.
    const effectSeries = series("status:12");
    const groupOverlay = [...series("skill:1")];
    const stacks = chartPresentation({ ...base, effectSeries });
    const drill = chartPresentation({ ...base, groupOverlay });

    expect(stacks.overlay).toBe(effectSeries);
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
    expect(chartPresentation({ ...base, effectSeries: series("status:12") }).withTotal).toBe(false);
  });

  it("withholds the Total from any grouping other than source", () => {
    expect(chartPresentation({ ...base, groupBy: "ability" }).withTotal).toBe(false);
    expect(chartPresentation({ ...base, groupBy: "target" }).withTotal).toBe(false);
  });

  it("withholds the Total off the groups path, where the lines are the base chart's", () => {
    expect(chartPresentation({ ...base, groupsPath: false }).withTotal).toBe(false);
  });
});

describe("chartPresentation — labelKey", () => {
  it("titles the base chart after the metric itself", () => {
    expect(chartPresentation({ ...base, metricLabelKey: "ui.logs.chart-sba-label" }).labelKey).toBe(
      "ui.logs.chart-sba-label"
    );
  });

  it("keeps the metric's title over the groups path's per-player lines", () => {
    expect(chartPresentation({ ...base, groupPlayerSeries: { 0: [1, 2] } }).labelKey).toBe("ui.logs.chart-dps-label");
  });

  it("names the pinned effect's plot as stack depths", () => {
    expect(chartPresentation({ ...base, statusSeries: series("player:0") }).labelKey).toBe(
      "ui.logs.chart-stacks-label"
    );
  });

  it("names the unpinned aura plot as the effects themselves", () => {
    // The split is `statusSeries !== null`: with no effect pinned the series
    // ARE the effects, counted by holder.
    expect(chartPresentation({ ...base, effectSeries: series("status:12") }).labelKey).toBe(
      "ui.logs.chart-effects-label"
    );
  });

  it("names a friendly drill after the level it decomposed to", () => {
    const bands = series("skill:1");
    expect(chartPresentation({ ...base, groupOverlay: bands, level: "players" }).labelKey).toBe(
      "ui.logs.chart-dps-label"
    );
    expect(chartPresentation({ ...base, groupOverlay: bands, level: "abilities" }).labelKey).toBe(
      "ui.logs.chart-drill-ability-label"
    );
    expect(chartPresentation({ ...base, groupOverlay: bands, level: "skills" }).labelKey).toBe(
      "ui.logs.chart-drill-target-label"
    );
  });

  it("names a taken drill after the incoming damage, whatever the level", () => {
    expect(
      chartPresentation({ ...base, groupOverlay: series("taken:1"), metricKey: "taken", level: "skills" }).labelKey
    ).toBe("ui.logs.chart-taken-drill-label");
  });

  it("names both ends on the enemy side, per metric", () => {
    // The toggle swaps the plotted quantity for its opposite, so reusing the
    // friendly titles would leave the heading unchanged across it.
    const bands = series("enemy:1");
    expect(chartPresentation({ ...base, groupOverlay: bands, hostility: "enemy", metricKey: "damage" }).labelKey).toBe(
      "ui.logs.chart-enemy-dealt-label"
    );
    expect(chartPresentation({ ...base, groupOverlay: bands, hostility: "enemy", metricKey: "taken" }).labelKey).toBe(
      "ui.logs.chart-enemy-received-label"
    );
  });

  it("titles the stacks after the plot even on the enemy side", () => {
    // `chartSource === "stacks"` is checked first: the enemy-side aura tabs
    // still draw stack depths, not a damage flow.
    expect(chartPresentation({ ...base, statusSeries: series("actor:1"), hostility: "enemy" }).labelKey).toBe(
      "ui.logs.chart-stacks-label"
    );
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
    expect(chartPresentation({ ...base, effectSeries: series("status:12") }).format).toBe("count");
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
    expect(chartPresentation({ ...base, effectSeries: series("status:12") }).stacked).toBe(true);
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
    const sba = { ...base, metricKey: "sba" as const, metricFormat: "percent" as const };

    expect(chartPresentation(sba).format).toBe("percent");
    expect(chartPresentation({ ...sba, abilitySeries: series("skill:1") }).format).toBe("amount");
  });

  it("titles the drill after the metric it decomposes", () => {
    const stun = { ...base, metricKey: "stun" as const, abilitySeries: series("skill:1") };
    const sba = { ...base, metricKey: "sba" as const, abilitySeries: series("skill:1") };

    expect(chartPresentation(stun).labelKey).toBe("ui.logs.chart-stun-drill-label");
    expect(chartPresentation(sba).labelKey).toBe("ui.logs.chart-sba-drill-label");
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
