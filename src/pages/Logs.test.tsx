import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("1.0.0") }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/api/shell", () => ({ open: vi.fn() }));
vi.mock("@/stores/useMeterFilterSync", () => ({ useMeterFilterSync: () => {} }));
vi.mock("@/stores/useMeterSettingsStore", () => ({
  useMeterSettingsStore: (select: (s: unknown) => unknown) =>
    select({ open_log_on_save: false, auto_check_updates: false }),
}));
vi.mock("@/stores/useUpdateStatusStore", () => ({
  useUpdateStatusStore: (select: (s: unknown) => unknown) => select({ status: null }),
}));
vi.mock("@/useUpdateCheck", () => ({ default: () => {} }));
vi.mock("@/components/HookStatusBadge", () => ({ default: () => null }));
vi.mock("@/components/UpdateAvailableButton", () => ({ default: () => null }));
vi.mock("@/platform", () => ({ useIsLinux: () => false }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { MemoryRouter, Route, Routes } from "react-router-dom";

import { useNavMemoryStore } from "@/stores/useNavMemoryStore";
import Layout from "./Logs";

/** Mounts the logs shell at `entry`, replacing any previous mount — one shell
 * at a time, the way the window really works. */
let mounted: { unmount: () => void } | null = null;
const renderAt = (entry: string) => {
  mounted?.unmount();
  mounted = render(
    <MantineProvider>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/logs/*" element={<Layout />} />
        </Routes>
      </MemoryRouter>
    </MantineProvider>
  );
};

const tabHref = (name: RegExp) => screen.getByRole("link", { name }).getAttribute("href");

// Matched loosely: the Toolbox tab carries a "New" chip inside its label, which
// lands in the accessible name.
const LOGS_TAB = /^ui\.logs-tab/;
const TOOLBOX_TAB = /^ui\.toolbox\.title/;
const SETTINGS_TAB = /^ui\.settings$/;

describe("logs window header tabs", () => {
  beforeEach(() => {
    mounted = null;
    useNavMemoryStore.setState({ locations: {} });
  });

  it("points every tab at its section root before anything has been visited", () => {
    renderAt("/logs");

    expect(tabHref(TOOLBOX_TAB)).toBe("/logs/toolbox");
    expect(tabHref(SETTINGS_TAB)).toBe("/logs/settings");
  });

  it("returns to the page that was open under a tab, query string included", () => {
    renderAt("/logs/123?tab=builds");
    renderAt("/logs/settings/checklist");

    // Back on Settings, the Logs tab still points at the quest detail — and at
    // the tab that was open inside it.
    expect(tabHref(LOGS_TAB)).toBe("/logs/123?tab=builds");
    expect(tabHref(SETTINGS_TAB)).toBe("/logs/settings");
  });

  it("remembers the section a nav rail was left on", () => {
    renderAt("/logs/toolbox/overmastery");
    renderAt("/logs");

    expect(tabHref(TOOLBOX_TAB)).toBe("/logs/toolbox/overmastery");
  });

  it("sends the active tab to its root so re-clicking it starts over", () => {
    renderAt("/logs/123");

    expect(tabHref(LOGS_TAB)).toBe("/logs");
  });
});
