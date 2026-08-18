import { describe, expect, it } from "vitest";

import { SBA_MARKER_COLOR, type ChartMarker } from "./chartMarkers";
import { compareMarkers } from "./compareMarkers";

const sba = (atMs: number, label: string): ChartMarker => ({
  kind: "sba",
  atMs,
  color: SBA_MARKER_COLOR,
  label,
});

const death = (atMs: number, label: string): ChartMarker => ({ kind: "death", atMs, color: "#f00", label });

const tagOf = (paneIndex: number) => ({ text: `#${2657 + paneIndex}`, color: `pane-${paneIndex}` });

describe("compareMarkers", () => {
  // An SBA chain is four casts, and the SBA shading merges them into one span —
  // so on the overlay these lines are the only thing saying how many Skybound
  // Arts a run got off.
  it("keeps every pane's casts rather than folding them together", () => {
    const merged = compareMarkers([[sba(1_000, "Rain — Skybound Art")], [sba(1_000, "Ferry — Skybound Art")]], tagOf);

    expect(merged).toHaveLength(2);
    expect(merged.map((marker) => marker.label)).toEqual(["Rain — Skybound Art", "Ferry — Skybound Art"]);
  });

  // Every SBA line wears one colour by design, so the swatch cannot say which
  // run cast it. The tag does, in that run's own line colour.
  it("tags each marker with the log it came from", () => {
    const merged = compareMarkers([[sba(1_000, "Rain — Skybound Art")], [sba(2_000, "Ferry — Skybound Art")]], tagOf);

    expect(merged.map((marker) => marker.tag)).toEqual([
      { text: "#2657", color: "pane-0" },
      { text: "#2658", color: "pane-1" },
    ]);
  });

  it("leaves the time, the wording and the kind colour the pane resolved alone", () => {
    const [merged] = compareMarkers([[sba(4_500, "Rain — Skybound Art")]], tagOf);

    expect(merged.kind).toBe("sba");
    expect(merged.atMs).toBe(4_500);
    expect(merged.label).toBe("Rain — Skybound Art");
    expect(merged.color).toBe(SBA_MARKER_COLOR);
  });

  // Pane order would put one run's whole fight ahead of the other's inside a
  // card that lists them, which reads as a chronology and is not one.
  it("orders the merged markers by time, not by pane", () => {
    const merged = compareMarkers([[death(9_000, "Rain died")], [sba(1_000, "Ferry — Skybound Art")]], tagOf);

    expect(merged.map((marker) => marker.atMs)).toEqual([1_000, 9_000]);
  });

  it("answers empty with no panes and with no markers", () => {
    expect(compareMarkers([], tagOf)).toEqual([]);
    expect(compareMarkers([[], []], tagOf)).toEqual([]);
  });
});
