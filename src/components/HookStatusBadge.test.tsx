import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
let status: unknown = null;
vi.mock("@tauri-apps/api", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@/useHookStatus", () => ({ useHookStatus: () => status }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import HookStatusBadge from "./HookStatusBadge";

const renderBadge = (ui: ReactElement) => render(<MantineProvider>{ui}</MantineProvider>);

describe("HookStatusBadge", () => {
  beforeEach(() => {
    invoke.mockReset();
    status = null;
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
});
