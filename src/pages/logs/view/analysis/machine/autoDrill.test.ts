import { describe, expect, it } from "vitest";

import type { MetricRow } from "../../metrics/types";

import { autoDrillPin } from "./autoDrill";
import { DEFAULT_STATE, type AnalysisState } from "./state";

const state = (over: Partial<AnalysisState>): AnalysisState => ({ ...DEFAULT_STATE, ...over });

const row = (key: string, pinOnClick: MetricRow["pinOnClick"]): MetricRow => ({
  key,
  label: key,
  value: 1,
  columns: [],
  pinOnClick,
  colorSlot: -1,
});

describe("autoDrillPin", () => {
  it("drills the one row a table is left with", () => {
    const rows = [row("target:3", { targets: [3] })];
    expect(autoDrillPin(rows, state({ source: 1, ability: "skill:9" }))).toEqual({ dim: "target", value: 3 });
  });

  it("reads each dimension's own grammar", () => {
    expect(autoDrillPin([row("player:2", { source: 2 })], DEFAULT_STATE)).toEqual({ dim: "source", value: 2 });
    expect(autoDrillPin([row("skill:9", { ability: "skill:9" })], DEFAULT_STATE)).toEqual({
      dim: "ability",
      value: "skill:9",
    });
  });

  it("leaves a table that still offers a choice alone", () => {
    const rows = [row("target:3", { targets: [3] }), row("target:4", { targets: [4] })];
    expect(autoDrillPin(rows, DEFAULT_STATE)).toBeNull();
  });

  it("leaves an empty table alone", () => {
    expect(autoDrillPin([], DEFAULT_STATE)).toBeNull();
  });

  it("leaves a row that pins nothing alone", () => {
    expect(autoDrillPin([row("enemy:{}", null)], DEFAULT_STATE)).toBeNull();
  });

  it("never repins a dimension that is already pinned — the terminal row, and the loop it would spin", () => {
    const rows = [row("target:3", { targets: [3] })];
    expect(autoDrillPin(rows, state({ target: 3 }))).toBeNull();
    // Even a DIFFERENT value on a pinned dimension: the rows are that pin's
    // own reading, not a drill past it.
    expect(autoDrillPin(rows, state({ target: 7 }))).toBeNull();
  });
});
