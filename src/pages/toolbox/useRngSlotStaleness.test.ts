import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api";

import useRngSlotStaleness, { RngSlotPrediction } from "./useRngSlotStaleness";

const invokeMock = vi.mocked(invoke);

const prediction = (slot: number, slotState: number, unpredictable = false): RngSlotPrediction => ({
  slot,
  slotState,
  unpredictable,
});

/** Live RNG state per slot, as `fetch_rng_slot` reports it. */
const liveSlots = (states: Record<number, number | null>) =>
  invokeMock.mockImplementation(async (_cmd, args) => states[(args as { slot: number }).slot] ?? null);

/** Drive one poll tick of the 5s watch. */
const tick = async () => {
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
};

describe("useRngSlotStaleness over a batch of predictions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays fresh while every watched slot still holds the state it simulated from", async () => {
    liveSlots({ 4: 100, 7: 200 });
    const watched = [prediction(4, 100), prediction(7, 200)];
    const { result } = renderHook(() => useRngSlotStaleness(watched));

    await tick();
    expect(result.current[0]).toBe(false);
  });

  it("goes stale when any one character's slot moves, not just the first", async () => {
    liveSlots({ 4: 100, 7: 999 });
    const watched = [prediction(4, 100), prediction(7, 200)];
    const { result } = renderHook(() => useRngSlotStaleness(watched));

    await tick();
    expect(result.current[0]).toBe(true);
  });

  it("reads each distinct slot once, however many characters share it", async () => {
    liveSlots({ 4: 100 });
    const watched = [prediction(4, 100), prediction(4, 100)];
    renderHook(() => useRngSlotStaleness(watched));

    await tick();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("watches nothing when every prediction is unpredictable", async () => {
    liveSlots({ 4: 999 });
    const watched = [prediction(4, 0, true)];
    const { result } = renderHook(() => useRngSlotStaleness(watched));

    await tick();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current[0]).toBe(false);
  });

  it("still watches a lone prediction passed on its own", async () => {
    liveSlots({ 4: 999 });
    const { result } = renderHook(() => useRngSlotStaleness(prediction(4, 100)));

    await tick();
    expect(result.current[0]).toBe(true);
  });
});
