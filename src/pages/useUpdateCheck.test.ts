import { act, renderHook, waitFor } from "@testing-library/react";
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
import { checkUpdate, installUpdate } from "@tauri-apps/api/updater";
import toast from "react-hot-toast";

import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { useUpdateStatusStore } from "@/stores/useUpdateStatusStore";
import useUpdateCheck, { useManualUpdateCheck } from "./useUpdateCheck";

const checkUpdateMock = vi.mocked(checkUpdate);
const installUpdateMock = vi.mocked(installUpdate);
const openConfirmModalMock = vi.mocked(modals.openConfirmModal);

const update = (shouldUpdate: boolean) =>
  ({ shouldUpdate, manifest: { version: "1.11.0", date: "", body: "- Something new" } }) as Awaited<
    ReturnType<typeof checkUpdate>
  >;

describe("auto_check_updates setting", () => {
  it("defaults to on", () => {
    expect(useMeterSettingsStore.getState().auto_check_updates).toBe(true);
  });
});

describe("useUpdateCheck", () => {
  beforeEach(() => {
    checkUpdateMock.mockReset();
    installUpdateMock.mockReset();
    openConfirmModalMock.mockReset();
  });

  it("does not contact the update endpoint when disabled", () => {
    renderHook(() => useUpdateCheck(false));
    expect(checkUpdateMock).not.toHaveBeenCalled();
  });

  it("prompts when an update is available, and installs on confirm", async () => {
    checkUpdateMock.mockResolvedValue(update(true));
    installUpdateMock.mockResolvedValue(undefined);
    renderHook(() => useUpdateCheck(true));
    await waitFor(() => expect(openConfirmModalMock).toHaveBeenCalledTimes(1));
    const args = openConfirmModalMock.mock.calls[0][0];
    await act(async () => args.onConfirm?.());
    expect(installUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("does not prompt when the app is up to date", async () => {
    checkUpdateMock.mockResolvedValue(update(false));
    renderHook(() => useUpdateCheck(true));
    await waitFor(() => expect(checkUpdateMock).toHaveBeenCalledTimes(1));
    expect(openConfirmModalMock).not.toHaveBeenCalled();
  });

  it("prompts at most once even when the setting is toggled off and on", async () => {
    checkUpdateMock.mockResolvedValue(update(true));
    const { rerender } = renderHook(({ enabled }) => useUpdateCheck(enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(openConfirmModalMock).toHaveBeenCalledTimes(1));
    rerender({ enabled: false });
    rerender({ enabled: true });
    await waitFor(() => expect(checkUpdateMock.mock.calls.length).toBeGreaterThanOrEqual(1));
    expect(openConfirmModalMock).toHaveBeenCalledTimes(1);
  });

  it("swallows endpoint failures (offline, missing manifest)", async () => {
    checkUpdateMock.mockRejectedValue(new Error("offline"));
    renderHook(() => useUpdateCheck(true));
    await waitFor(() => expect(checkUpdateMock).toHaveBeenCalledTimes(1));
    expect(openConfirmModalMock).not.toHaveBeenCalled();
  });
});

describe("useManualUpdateCheck", () => {
  beforeEach(() => {
    checkUpdateMock.mockReset();
    openConfirmModalMock.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("prompts when the manual check finds an update", async () => {
    checkUpdateMock.mockResolvedValue(update(true));
    const { result } = renderHook(() => useManualUpdateCheck());
    await act(async () => result.current.checkNow());
    expect(openConfirmModalMock).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("the prompt is a centered modal", async () => {
    checkUpdateMock.mockResolvedValue(update(true));
    const { result } = renderHook(() => useManualUpdateCheck());
    await act(async () => result.current.checkNow());
    expect(openConfirmModalMock.mock.calls[0][0].centered).toBe(true);
  });

  it("toasts up-to-date when there is no newer release", async () => {
    checkUpdateMock.mockResolvedValue(update(false));
    const { result } = renderHook(() => useManualUpdateCheck());
    await act(async () => result.current.checkNow());
    expect(openConfirmModalMock).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("toasts an error when the endpoint is unreachable", async () => {
    checkUpdateMock.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useManualUpdateCheck());
    await act(async () => result.current.checkNow());
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(openConfirmModalMock).not.toHaveBeenCalled();
  });
});

describe("skipping an offered version", () => {
  beforeEach(() => {
    checkUpdateMock.mockReset();
    openConfirmModalMock.mockReset();
    useMeterSettingsStore.getState().set({ skipped_update_version: null });
  });

  it("the Skip button records the offered version", async () => {
    checkUpdateMock.mockResolvedValue(update(true));
    renderHook(() => useUpdateCheck(true));
    await waitFor(() => expect(openConfirmModalMock).toHaveBeenCalledTimes(1));
    const args = openConfirmModalMock.mock.calls[0][0];
    act(() => args.onCancel?.());
    expect(useMeterSettingsStore.getState().skipped_update_version).toBe("1.11.0");
  });

  it("the auto check stays quiet about a skipped version", async () => {
    useMeterSettingsStore.getState().set({ skipped_update_version: "1.11.0" });
    checkUpdateMock.mockResolvedValue(update(true));
    renderHook(() => useUpdateCheck(true));
    await waitFor(() => expect(checkUpdateMock).toHaveBeenCalledTimes(1));
    expect(openConfirmModalMock).not.toHaveBeenCalled();
  });

  it("the auto check prompts again for a different version", async () => {
    useMeterSettingsStore.getState().set({ skipped_update_version: "1.10.5" });
    checkUpdateMock.mockResolvedValue(update(true));
    renderHook(() => useUpdateCheck(true));
    await waitFor(() => expect(openConfirmModalMock).toHaveBeenCalledTimes(1));
  });

  it("a manual check prompts even for a skipped version", async () => {
    useMeterSettingsStore.getState().set({ skipped_update_version: "1.11.0" });
    checkUpdateMock.mockResolvedValue(update(true));
    const { result } = renderHook(() => useManualUpdateCheck());
    await act(async () => result.current.checkNow());
    expect(openConfirmModalMock).toHaveBeenCalledTimes(1);
  });
});

describe("update status recording (header indicator)", () => {
  beforeEach(() => {
    checkUpdateMock.mockReset();
    openConfirmModalMock.mockReset();
    useUpdateStatusStore.setState({ status: null });
  });

  it("is unknown until a check has answered", () => {
    expect(useUpdateStatusStore.getState().status).toBeNull();
  });

  it("records an available update with its version", async () => {
    checkUpdateMock.mockResolvedValue(update(true));
    renderHook(() => useUpdateCheck(true));
    await waitFor(() =>
      expect(useUpdateStatusStore.getState().status).toEqual({ upToDate: false, latestVersion: "1.11.0" })
    );
  });

  it("records up-to-date from a manual check", async () => {
    checkUpdateMock.mockResolvedValue(update(false));
    const { result } = renderHook(() => useManualUpdateCheck());
    await act(async () => result.current.checkNow());
    expect(useUpdateStatusStore.getState().status).toEqual({ upToDate: true, latestVersion: "1.11.0" });
  });

  it("stays unknown when the check fails", async () => {
    checkUpdateMock.mockRejectedValue(new Error("offline"));
    renderHook(() => useUpdateCheck(true));
    await waitFor(() => expect(checkUpdateMock).toHaveBeenCalledTimes(1));
    expect(useUpdateStatusStore.getState().status).toBeNull();
  });
});
