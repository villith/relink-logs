import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MetricBar } from "./MetricBar";

/** The suite has no jest-dom, so widths are read off the inline style rather
 * than through `toHaveStyle` — the same assertion, one dependency lighter. */
const segments = () => screen.getAllByTestId("metric-bar-segment") as HTMLElement[];

const renderBar = (props: React.ComponentProps<typeof MetricBar>) =>
  render(
    <MantineProvider>
      <MetricBar {...props} />
    </MantineProvider>
  );

describe("MetricBar", () => {
  it("draws one segment when nothing is supplementary", () => {
    renderBar({ value: 50, largest: 100, color: "red", variant: "row" });
    expect(segments()).toHaveLength(1);
    expect(segments()[0].style.width).toBe("50%");
  });

  it("splits into a direct and a supplementary segment", () => {
    renderBar({ value: 50, subValue: 20, largest: 100, color: "red", variant: "row" });
    expect(segments()).toHaveLength(2);
    // Direct part first: (50 - 20) / 100.
    expect(segments()[0].style.width).toBe("30%");
    expect(segments()[0].style.left).toBe("0%");
    // Supplementary picks up exactly where it ends and reaches value/largest.
    expect(segments()[1].style.width).toBe("20%");
    expect(segments()[1].style.left).toBe("30%");
  });

  it("renders at zero width rather than NaN when every peer is zero", () => {
    renderBar({ value: 0, largest: 0, color: "red", variant: "row" });
    expect((screen.getByTestId("metric-bar-segment") as HTMLElement).style.width).toBe("0%");
  });
});
