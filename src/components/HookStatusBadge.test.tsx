import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
let status: unknown = null;
let encounterState: unknown = null;
vi.mock("@tauri-apps/api", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@/useHookStatus", () => ({ useHookStatus: () => status }));
vi.mock("@mantine/modals", () => ({ modals: { openConfirmModal: vi.fn() } }));
vi.mock("@/stores/useEncounterStore", () => ({
  useEncounterStore: { getState: () => ({ encounterState }) },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { modals } from "@mantine/modals";

import HookStatusBadge from "./HookStatusBadge";

const renderBadge = (ui: ReactElement) => render(<MantineProvider>{ui}</MantineProvider>);

describe("HookStatusBadge", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.mocked(modals.openConfirmModal).mockReset();
    status = null;
    encounterState = null;
  });

  it("renders nothing until status loads", () => {
    // No MantineProvider needed: the badge returns null before rendering
    // any Mantine component, and the provider would inject a <style> tag.
    const { container } = render(<HookStatusBadge />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a Refresh button when out of date and eject-capable", () => {
    status = { state: "outOfDate", hookVersion: "0.9.0", appVersion: "1.0.0", supportsEject: true };
    renderBadge(<HookStatusBadge />);
    expect(screen.getByRole("button", { name: "ui.hook-status.refresh" })).toBeTruthy();
  });

  it("shows restart-game copy when out of date and NOT eject-capable", () => {
    status = { state: "outOfDate", hookVersion: "0.9.0", appVersion: "1.0.0", supportsEject: false };
    renderBadge(<HookStatusBadge />);
    expect(screen.queryByRole("button", { name: "ui.hook-status.refresh" })).toBeNull();
    expect(screen.getByText("ui.hook-status.restart-game")).toBeTruthy();
  });

  it("shows a Reconnect button when disconnected", () => {
    status = { state: "disconnected", hookVersion: null, appVersion: "1.0.0", supportsEject: false };
    renderBadge(<HookStatusBadge />);
    expect(screen.getByRole("button", { name: "ui.hook-status.reconnect" })).toBeTruthy();
  });

  it("refreshes immediately when not in an encounter", async () => {
    encounterState = null;
    status = { state: "outOfDate", hookVersion: "0.9.0", appVersion: "1.0.0", supportsEject: true };
    invoke.mockResolvedValue(undefined);
    renderBadge(<HookStatusBadge />);
    fireEvent.click(screen.getByRole("button", { name: "ui.hook-status.refresh" }));
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith("refresh_hook");
    expect(modals.openConfirmModal).not.toHaveBeenCalled();
  });

  it("opens a confirm modal (no immediate invoke) when an encounter is in progress", () => {
    encounterState = { status: "InProgress" };
    status = { state: "outOfDate", hookVersion: "0.9.0", appVersion: "1.0.0", supportsEject: true };
    renderBadge(<HookStatusBadge />);
    fireEvent.click(screen.getByRole("button", { name: "ui.hook-status.refresh" }));
    expect(modals.openConfirmModal).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("shows no action buttons in connected or reconnecting states", () => {
    for (const state of ["connected", "reconnecting"]) {
      status = { state, hookVersion: "1.0.0", appVersion: "1.0.0", supportsEject: true };
      const { unmount } = renderBadge(<HookStatusBadge />);
      expect(screen.queryByRole("button")).toBeNull();
      unmount();
    }
  });
});
