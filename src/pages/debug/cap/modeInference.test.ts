import { describe, expect, it } from "vitest";

import type { ChartWindow } from "@/types";

import { modeInferenceForHit } from "./modeInference";

const window = (
  kind: ChartWindow["kind"],
  startMs: number,
  endMs: number,
  actorIndex: number | null = null
): ChartWindow => ({ kind, startMs, endMs, actorIndex });

describe("modeInferenceForHit", () => {
  it("returns null when the log carries no mode windows at all", () => {
    expect(modeInferenceForHit([], 7, 1_000)).toBeNull();
    // Non-mode windows (sba/link) don't count as "the log has mode data".
    expect(modeInferenceForHit([window("sba", 0, 5_000), window("link", 0, 5_000)], 7, 1_000)).toBeNull();
  });

  it("reads overdrive true when the target's window covers the moment", () => {
    const windows = [window("overdrive", 1_000, 2_000, 7)];
    expect(modeInferenceForHit(windows, 7, 1_500)).toEqual({ overdrive: true, break: false });
  });

  it("reads break true when the target's window covers the moment", () => {
    const windows = [window("break", 1_000, 2_000, 7)];
    expect(modeInferenceForHit(windows, 7, 1_500)).toEqual({ overdrive: false, break: true });
  });

  it("is a real false, not null, when mode windows exist but none cover this hit", () => {
    const windows = [window("overdrive", 1_000, 2_000, 7)];
    // Outside the window's time span.
    expect(modeInferenceForHit(windows, 7, 5_000)).toEqual({ overdrive: false, break: false });
    // Right time, wrong target.
    expect(modeInferenceForHit(windows, 9, 1_500)).toEqual({ overdrive: false, break: false });
  });

  it("matches on the target's PARENT/actor index, not an unrelated actor", () => {
    const windows = [window("break", 0, 10_000, 3), window("overdrive", 0, 10_000, 4)];
    expect(modeInferenceForHit(windows, 3, 500)).toEqual({ overdrive: false, break: true });
    expect(modeInferenceForHit(windows, 4, 500)).toEqual({ overdrive: true, break: false });
  });

  it("disambiguates a reused actor index by time, without extra plumbing", () => {
    // The same actor index breaks twice, in two disjoint windows — a dead
    // boss's id reissued to a later spawn. The membership check alone picks
    // the window that actually covers the hit's moment.
    const windows = [window("break", 0, 1_000, 7), window("break", 5_000, 6_000, 7)];
    expect(modeInferenceForHit(windows, 7, 500)).toEqual({ overdrive: false, break: true });
    expect(modeInferenceForHit(windows, 7, 5_500)).toEqual({ overdrive: false, break: true });
    expect(modeInferenceForHit(windows, 7, 3_000)).toEqual({ overdrive: false, break: false });
  });

  it("the start bound is inclusive", () => {
    const windows = [window("overdrive", 1_000, 2_000, 7)];
    expect(modeInferenceForHit(windows, 7, 1_000)).toEqual({ overdrive: true, break: false });
  });

  it("a hit at the endMs of a fight-end-closed window reads as inside it", () => {
    // `assemble_chart_windows` (Rust) closes a window still open at the last
    // event AT that event's own timestamp, not one past it — so the killing
    // blow (the last event) can land exactly at `endMs`. Nothing else picks
    // up here for this actor, so this is an artificial close, not a real
    // hand-off, and the window must still cover it.
    const windows = [window("break", 1_000, 2_000, 7)];
    expect(modeInferenceForHit(windows, 7, 2_000)).toEqual({ overdrive: false, break: true });
  });

  it("a hit at a real hand-off boundary reads the NEW window's state, not the old one's", () => {
    // Overdrive ends exactly where Break begins for the same actor — a real
    // mode transition, not an artificial fight-end close. At that exact
    // millisecond the enemy is already in Break.
    const windows = [window("overdrive", 0, 1_000, 7), window("break", 1_000, 2_000, 7)];
    expect(modeInferenceForHit(windows, 7, 1_000)).toEqual({ overdrive: false, break: true });
  });
});
