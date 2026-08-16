import { describe, expect, it } from "vitest";

import { WINDOW_BAND_COLOR, type WindowBand, type WindowKind } from "./chartWindowBands";
import type { WindowTooltipEntry } from "./chartWindowTooltip";
import { compareWindowBands, compareWindowTooltips } from "./compareWindows";

const band = (kind: WindowKind, startMs: number, endMs: number): WindowBand => ({
  kind,
  color: WINDOW_BAND_COLOR[kind],
  band: { startMs, endMs, stacks: 1 },
});

const tooltip = (kind: WindowKind, startMs: number, endMs: number, text: string): WindowTooltipEntry => ({
  kind,
  startMs,
  endMs,
  color: WINDOW_BAND_COLOR[kind],
  text,
});

describe("compareWindowBands", () => {
  it("keeps every pane's spans, still coloured by kind", () => {
    const merged = compareWindowBands([[band("break", 10_000, 20_000)], [band("break", 12_000, 25_000)]]);

    expect(merged).toEqual([band("break", 10_000, 20_000), band("break", 12_000, 25_000)]);
  });

  // Two runs' Breaks are two facts. Merged into one span the overlay would
  // claim a single Break running from the earlier start to the later end, which
  // happened in neither fight.
  it("never fuses two panes' overlapping spans into one", () => {
    const merged = compareWindowBands([[band("sba", 0, 5_000)], [band("sba", 1_000, 4_000)]]);

    expect(merged).toHaveLength(2);
  });

  // The single-log chart draws sba → link → overdrive → break, and the overlay
  // has to shade in the same order or two plots of one fight layer differently.
  it("walks the kinds in draw order, not pane order", () => {
    const merged = compareWindowBands([
      [band("break", 0, 1_000)],
      [band("sba", 2_000, 3_000), band("overdrive", 4_000, 5_000)],
    ]);

    expect(merged.map((entry) => entry.kind)).toEqual(["sba", "overdrive", "break"]);
  });

  it("answers empty with no panes and with no windows", () => {
    expect(compareWindowBands([])).toEqual([]);
    expect(compareWindowBands([[], []])).toEqual([]);
  });
});

const tagOf = (paneIndex: number) => ({ text: `#${2657 + paneIndex}`, color: `pane-${paneIndex}` });

describe("compareWindowTooltips", () => {
  // A span reading "1:20–1:31 · 11s" says when and how long and nothing about
  // whose fight — so on one axis two runs' Breaks read as one run's four.
  it("tags each line with the log it came from", () => {
    const merged = compareWindowTooltips(
      [[tooltip("break", 0, 1_000, "1:20–1:31 · 11s")], [tooltip("break", 500, 1_500, "1:22–1:29 · 7s")]],
      tagOf
    );

    expect(merged.map((entry) => entry.tag)).toEqual([
      { text: "#2657", color: "pane-0" },
      { text: "#2658", color: "pane-1" },
    ]);
  });

  // The tag is its own field, not folded into the text: the row's swatch is
  // already the KIND's colour, so the id is the only thing that can wear the
  // log's — and it cannot if it is buried in a string.
  it("leaves the span, the wording and the kind colour the pane resolved alone", () => {
    const entry = tooltip("sba", 3_000, 9_000, "0:03–0:09 · 6s");
    const [merged] = compareWindowTooltips([[entry]], tagOf);

    expect(merged.kind).toBe("sba");
    expect(merged.startMs).toBe(3_000);
    expect(merged.endMs).toBe(9_000);
    expect(merged.text).toBe("0:03–0:09 · 6s");
    expect(merged.color).toBe(WINDOW_BAND_COLOR.sba);
  });
});
