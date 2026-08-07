import { describe, expect, it } from "vitest";

import type { ChartWindow } from "@/types";

import { WINDOW_BAND_COLOR, windowBandsFor } from "./chartWindowBands";

const span = (kind: ChartWindow["kind"], startMs: number, endMs: number, actorIndex: number | null = null) => ({
  kind,
  startMs,
  endMs,
  actorIndex,
});

const WINDOW = { startMs: 0, endMs: 60_000 };

describe("windowBandsFor", () => {
  it("maps each kind to its own colour and clips to the chart window", () => {
    const bands = windowBandsFor(
      [span("sba", 5_000, 12_000), span("link", 20_000, 30_000), span("break", 55_000, 90_000, 7)],
      WINDOW
    );
    expect(bands).toEqual([
      { kind: "sba", color: WINDOW_BAND_COLOR.sba, band: { startMs: 5_000, endMs: 12_000, stacks: 1 } },
      { kind: "link", color: WINDOW_BAND_COLOR.link, band: { startMs: 20_000, endMs: 30_000, stacks: 1 } },
      // Clipped at the window's end, exactly as an aura band would be.
      { kind: "break", color: WINDOW_BAND_COLOR.break, band: { startMs: 55_000, endMs: 60_000, stacks: 1 } },
    ]);
  });

  it("merges overlapping windows of one kind but never across kinds", () => {
    const bands = windowBandsFor(
      [span("break", 10_000, 20_000, 1), span("break", 15_000, 25_000, 2), span("link", 12_000, 18_000)],
      WINDOW
    );
    expect(bands).toEqual([
      { kind: "link", color: WINDOW_BAND_COLOR.link, band: { startMs: 12_000, endMs: 18_000, stacks: 1 } },
      { kind: "break", color: WINDOW_BAND_COLOR.break, band: { startMs: 10_000, endMs: 25_000, stacks: 1 } },
    ]);
  });

  it("rebases onto a scrubbed window and drops spans outside it", () => {
    const bands = windowBandsFor([span("sba", 5_000, 12_000), span("link", 40_000, 50_000)], {
      startMs: 30_000,
      endMs: 60_000,
    });
    expect(bands).toEqual([
      { kind: "link", color: WINDOW_BAND_COLOR.link, band: { startMs: 10_000, endMs: 20_000, stacks: 1 } },
    ]);
  });

  it("answers empty for a log with no windows", () => {
    expect(windowBandsFor([], WINDOW)).toEqual([]);
  });
});
