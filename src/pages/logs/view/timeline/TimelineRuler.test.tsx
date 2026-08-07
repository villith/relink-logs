import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TimelineRuler, tickTimes } from "./TimelineRuler";

describe("tickTimes", () => {
  it("places a tick every step across the domain", () => {
    expect(tickTimes(30_000, 10_000)).toEqual([0, 10_000, 20_000, 30_000]);
  });

  // The last tick must not sit past the end, where it would render outside the
  // track and widen the scroller.
  it("does not place a tick past the end of the domain", () => {
    expect(tickTimes(25_000, 10_000)).toEqual([0, 10_000, 20_000]);
  });

  it("places a single tick for an empty domain", () => {
    expect(tickTimes(0, 10_000)).toEqual([0]);
  });
});

describe("TimelineRuler", () => {
  // Labels are ABSOLUTE fight time, not offsets into the window: a scrubbed
  // window starting at 1:20 must say 1:20, or the timeline and the chart above
  // it name the same moment two different ways.
  it("labels ticks in absolute fight time", () => {
    render(<TimelineRuler domainMs={30_000} startMs={80_000} stepMs={10_000} />);
    expect(screen.getByText("01:20")).toBeTruthy();
    expect(screen.getByText("01:30")).toBeTruthy();
  });

  it("positions each tick as a percentage of the domain", () => {
    const { container } = render(<TimelineRuler domainMs={30_000} startMs={0} stepMs={10_000} />);
    const ticks = container.querySelectorAll(".timeline-ruler-tick");
    expect((ticks[1] as HTMLElement).style.left).toBe("33.3333%");
  });
});
