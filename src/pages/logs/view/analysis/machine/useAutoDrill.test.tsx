import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MetricRow } from "../../metrics/types";

import { DEFAULT_STATE, type AnalysisState } from "./state";
import { useAutoDrill, type AutoDrillInput } from "./useAutoDrill";

const state = (over: Partial<AnalysisState>): AnalysisState => ({ ...DEFAULT_STATE, ...over });

const row = (key: string, pinOnClick: MetricRow["pinOnClick"]): MetricRow => ({
  key,
  label: key,
  value: 1,
  columns: [],
  pinOnClick,
  colorSlot: -1,
});

const ONE_TARGET = () => [row("target:3", { targets: [3] })];
const TWO_TARGETS = () => [row("target:3", { targets: [3] }), row("target:4", { targets: [4] })];

type Props = Omit<AutoDrillInput, "setState">;

const setup = (initial: Props) => {
  const setState = vi.fn();
  const { result, rerender } = renderHook((props: Props) => useAutoDrill({ ...props, setState }), {
    initialProps: initial,
  });
  return { setState, result, rerender };
};

describe("useAutoDrill", () => {
  it("does not drill a lone row nobody drilled into — a landing on this address is not a drill", () => {
    const { setState, rerender } = setup({ rows: ONE_TARGET(), state: DEFAULT_STATE, settled: true, enabled: true });
    rerender({ rows: ONE_TARGET(), state: DEFAULT_STATE, settled: true, enabled: true });
    expect(setState).not.toHaveBeenCalled();
  });

  it("drills the lone row the pin left behind", () => {
    const pinned = state({ source: 1, ability: "skill:9" });
    const { setState, result, rerender } = setup({
      rows: TWO_TARGETS(),
      state: DEFAULT_STATE,
      settled: true,
      enabled: true,
    });

    act(() => result.current.armDrill());
    rerender({ rows: ONE_TARGET(), state: pinned, settled: true, enabled: true });

    expect(setState).toHaveBeenCalledTimes(1);
    expect(setState.mock.calls[0][0]).toMatchObject({ source: 1, ability: "skill:9", target: 3 });
  });

  it("keeps drilling while each new table is left with one row", () => {
    const afterSource = state({ source: 1 });
    const afterAbility = state({ source: 1, ability: "skill:9" });
    const { setState, result, rerender } = setup({
      rows: [row("player:1", { source: 1 })],
      state: DEFAULT_STATE,
      settled: true,
      enabled: true,
    });

    act(() => result.current.armDrill());
    rerender({ rows: [row("skill:9", { ability: "skill:9" })], state: afterSource, settled: true, enabled: true });
    expect(setState.mock.calls[0][0]).toMatchObject({ ability: "skill:9" });

    rerender({ rows: ONE_TARGET(), state: afterAbility, settled: true, enabled: true });
    expect(setState.mock.calls[1][0]).toMatchObject({ target: 3 });
  });

  it("waits for rows that answer the CURRENT grouping rather than drilling stale ones", () => {
    const pinned = state({ source: 1, ability: "skill:9" });
    const { setState, result, rerender } = setup({
      rows: TWO_TARGETS(),
      state: DEFAULT_STATE,
      settled: true,
      enabled: true,
    });

    act(() => result.current.armDrill());
    // The response for the new grouping has not landed: one stale row.
    rerender({ rows: [row("player:1", { source: 1 })], state: pinned, settled: false, enabled: true });
    expect(setState).not.toHaveBeenCalled();

    rerender({ rows: ONE_TARGET(), state: pinned, settled: true, enabled: true });
    expect(setState).toHaveBeenCalledTimes(1);
  });

  it("stops at the first table that offers a choice, and stays stopped", () => {
    const pinned = state({ source: 1 });
    const { setState, result, rerender } = setup({
      rows: [row("player:1", { source: 1 })],
      state: DEFAULT_STATE,
      settled: true,
      enabled: true,
    });

    act(() => result.current.armDrill());
    rerender({ rows: TWO_TARGETS(), state: pinned, settled: true, enabled: true });
    expect(setState).not.toHaveBeenCalled();

    // A later single-row table — a window filter narrowing the fight, a pin
    // cleared — is not a drill, so it must not pin itself.
    rerender({ rows: ONE_TARGET(), state: pinned, settled: true, enabled: true });
    expect(setState).not.toHaveBeenCalled();
  });

  it("drills nothing while the rows are not the body on screen", () => {
    const pinned = state({ source: 1, ability: "skill:9" });
    const { setState, result, rerender } = setup({
      rows: TWO_TARGETS(),
      state: DEFAULT_STATE,
      settled: true,
      enabled: false,
    });

    act(() => result.current.armDrill());
    rerender({ rows: ONE_TARGET(), state: pinned, settled: true, enabled: false });
    expect(setState).not.toHaveBeenCalled();

    // And it disarmed rather than waiting: switching to the table later is not
    // a drill either.
    rerender({ rows: ONE_TARGET(), state: pinned, settled: true, enabled: true });
    expect(setState).not.toHaveBeenCalled();
  });
});
