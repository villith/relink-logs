import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/updater", () => ({ checkUpdate: vi.fn(), installUpdate: vi.fn() }));
vi.mock("@mantine/modals", () => ({ modals: { openConfirmModal: vi.fn() } }));
vi.mock("react-hot-toast", () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === "string" ? fallback : key),
    i18n: { language: "en" },
  }),
}));

import { modals } from "@mantine/modals";
import { checkUpdate } from "@tauri-apps/api/updater";

import { useUpdateStatusStore } from "@/stores/useUpdateStatusStore";
import UpdateAvailableButton from "./UpdateAvailableButton";

const renderButton = () =>
  render(
    <MantineProvider>
      <UpdateAvailableButton />
    </MantineProvider>
  );

describe("UpdateAvailableButton", () => {
  beforeEach(() => {
    vi.mocked(checkUpdate).mockReset();
    vi.mocked(modals.openConfirmModal).mockReset();
    useUpdateStatusStore.setState({ status: null });
  });

  it("renders nothing until a check has answered", () => {
    renderButton();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing when the app is up to date", () => {
    useUpdateStatusStore.setState({ status: { upToDate: true, latestVersion: "1.10.0" } });
    renderButton();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows while an update is available; clicking reopens the update prompt", async () => {
    useUpdateStatusStore.setState({ status: { upToDate: false, latestVersion: "1.11.0" } });
    vi.mocked(checkUpdate).mockResolvedValue({
      shouldUpdate: true,
      manifest: { version: "1.11.0", date: "", body: "- Notes" },
    } as Awaited<ReturnType<typeof checkUpdate>>);
    renderButton();
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(modals.openConfirmModal).toHaveBeenCalledTimes(1));
  });
});
