import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock("./DpsChart", () => ({
  DpsChart: ({ stacked, data, labels }: { stacked?: boolean; data: unknown[]; labels: { name: string }[] }) => (
    <div
      data-testid="chart"
      data-stacked={String(!!stacked)}
      data-points={data.length}
      data-series={labels.map((series) => series.name).join(",")}
    />
  ),
}));

import { CompareChart } from "./CompareChart";

const render2 = (perPaneTotals: number[][]) =>
  render(
    <CompareChart
      perPaneTotals={perPaneTotals}
      paneLogIds={perPaneTotals.map((_, index) => 2657 + index)}
      format="amount"
      onScope={vi.fn()}
    />
  );

describe("CompareChart", () => {
  it("draws one plot, whatever the pane count", () => {
    render2([
      [1, 2],
      [3, 4],
    ]);
    expect(screen.getAllByTestId("chart")).toHaveLength(1);
  });

  // A stacked area of two runs would sum two different fights into one height,
  // which is not a quantity anybody asked for.
  it("never stacks — a stacked area of two runs sums two fights", () => {
    render2([
      [1, 2],
      [3, 4],
    ]);
    expect(screen.getByTestId("chart").dataset.stacked).toBe("false");
  });

  it("gives every pane its own series", () => {
    render2([
      [1, 2],
      [3, 4],
    ]);
    expect(screen.getByTestId("chart").dataset.series).toBe("pane0,pane1");
  });

  it("spans the longest run", () => {
    render2([[1, 2, 3], [9]]);
    expect(screen.getByTestId("chart").dataset.points).toBe("3");
  });
});
