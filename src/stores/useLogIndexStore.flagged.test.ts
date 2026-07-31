import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn<[command: string, args?: unknown], Promise<unknown>>(() =>
  Promise.resolve({ logs: [], page: 1, pageCount: 0, logCount: 0 })
);
vi.mock("@tauri-apps/api", () => ({ invoke: (...a: Parameters<typeof invoke>) => invoke(...a) }));

import { useMeterSettingsStore } from "./useMeterSettingsStore";

import { useLogIndexStore } from "./useLogIndexStore";

/** The `flaggedOnly` argument of the last `fetch_logs` call. */
const flaggedArgument = () => {
  const calls = invoke.mock.calls.filter(([command]: [string, unknown?]) => command === "fetch_logs");
  return (calls[calls.length - 1]?.[1] as { flaggedOnly?: boolean } | undefined)?.flaggedOnly;
};

describe("the quest list's flagged filter", () => {
  beforeEach(() => {
    invoke.mockClear();
    act(() => {
      useMeterSettingsStore.setState({ show_flagged_builds: true });
      useLogIndexStore.setState({ filters: { ...useLogIndexStore.getState().filters, flaggedOnly: false } });
    });
  });

  it("asks for only the flagged runs when the filter is on", async () => {
    act(() => useLogIndexStore.getState().setFilters({ flaggedOnly: true }));
    await useLogIndexStore.getState().fetchLogs();

    expect(flaggedArgument()).toBe(true);
  });

  it("asks for every run when the filter is off", async () => {
    await useLogIndexStore.getState().fetchLogs();

    expect(flaggedArgument()).toBe(false);
  });

  /** The control is hidden while flagged builds are hidden app-wide, so a
   * remembered choice must not go on filtering results the user can no longer
   * see a reason for. */
  it("ignores a remembered choice while flagged builds are hidden app-wide", async () => {
    act(() => useLogIndexStore.getState().setFilters({ flaggedOnly: true }));
    act(() => {
      useMeterSettingsStore.setState({ show_flagged_builds: false });
    });
    await useLogIndexStore.getState().fetchLogs();

    expect(flaggedArgument()).toBe(false);
  });

  /** Ignored, not forgotten: turning the setting back on restores what the user
   * had chosen rather than silently resetting it. */
  it("restores the remembered choice when flagged builds are shown again", async () => {
    act(() => useLogIndexStore.getState().setFilters({ flaggedOnly: true }));
    act(() => {
      useMeterSettingsStore.setState({ show_flagged_builds: false });
    });
    await useLogIndexStore.getState().fetchLogs();
    act(() => {
      useMeterSettingsStore.setState({ show_flagged_builds: true });
    });
    await useLogIndexStore.getState().fetchLogs();

    expect(useLogIndexStore.getState().filters.flaggedOnly).toBe(true);
    expect(flaggedArgument()).toBe(true);
  });
});
