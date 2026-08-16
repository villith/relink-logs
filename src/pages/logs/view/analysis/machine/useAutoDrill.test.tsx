import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MetricRow } from "../../metrics/types";

import { DEFAULT_STATE, type AnalysisState } from "./state";
import type { PinValue } from "./transitions";
import { useAutoDrill } from "./useAutoDrill";

/** A stand-in for the pane: it arms the drill on mount, exactly as a click that
 * pins does, and hands its rows to the rule. */
const Pane = ({
  rows,
  state,
  setState,
  applyPin,
}: {
  rows: MetricRow[];
  state: AnalysisState;
  setState: (next: AnalysisState) => void;
  applyPin?: (pin: PinValue) => void;
}) => {
  const { armDrill } = useAutoDrill({
    rows,
    state,
    setState,
    settled: true,
    enabled: true,
    ...(applyPin ? { applyPin } : {}),
  });
  armDrill();
  return null;
};

const row = (key: string, pin: MetricRow["pinOnClick"]): MetricRow =>
  ({ key, label: key, value: 1, pinOnClick: pin }) as MetricRow;

describe("useAutoDrill", () => {
  // A single-row table under a fresh pin descends into that row too.
  it("pins the lone row through setState by default", () => {
    const setState = vi.fn();
    render(<Pane rows={[row("player:1", { source: 1 })]} state={DEFAULT_STATE} setState={setState} />);

    expect(setState).toHaveBeenCalledTimes(1);
    expect(setState.mock.calls[0][0].source).toBe(1);
  });

  // The compare overlay routes pins itself, because a drill onto a target or an
  // ability has to reach every pane — otherwise one run silently descends a
  // level further than the run it is drawn against.
  it("hands the pin to the caller's applier when there is one, and writes nothing itself", () => {
    const setState = vi.fn();
    const applyPin = vi.fn();
    render(
      <Pane rows={[row("player:1", { source: 1 })]} state={DEFAULT_STATE} setState={setState} applyPin={applyPin} />
    );

    expect(applyPin).toHaveBeenCalledWith({ dim: "source", value: 1 });
    expect(setState).not.toHaveBeenCalled();
  });

  it("drills nothing when the table offers a real choice", () => {
    const setState = vi.fn();
    const applyPin = vi.fn();
    render(
      <Pane
        rows={[row("player:1", { source: 1 }), row("player:2", { source: 2 })]}
        state={DEFAULT_STATE}
        setState={setState}
        applyPin={applyPin}
      />
    );

    expect(applyPin).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });
});
