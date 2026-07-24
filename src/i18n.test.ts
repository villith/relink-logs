import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/fs", () => ({ readTextFile: vi.fn().mockResolvedValue("{}") }));
vi.mock("@tauri-apps/api/path", () => ({
  resolveResource: vi.fn().mockResolvedValue("lang/en/ui.json"),
}));

import { syncTrayLabels } from "./i18n";

// No resources are loaded under test, so i18next echoes each key back. That
// makes the assertion cover both the invoke argument names and the i18n keys.
const ipc = window as unknown as { __TAURI_IPC__?: () => void };

describe("syncTrayLabels", () => {
  beforeEach(() => {
    invoke.mockClear();
    delete ipc.__TAURI_IPC__;
  });

  it("does nothing outside a Tauri webview", async () => {
    await syncTrayLabels();

    expect(invoke).not.toHaveBeenCalled();
  });

  it("pushes every tray label, including the dev-only reload hook", async () => {
    ipc.__TAURI_IPC__ = () => {};

    await syncTrayLabels();

    expect(invoke).toHaveBeenCalledWith("update_tray_labels", {
      openMeter: "ui.tray-open-meter",
      openLogs: "ui.tray-open-logs",
      alwaysOnTop: "ui.tray-always-on-top",
      alwaysOnTopActive: "ui.tray-always-on-top-active",
      clickthrough: "ui.tray-clickthrough",
      clickthroughActive: "ui.tray-clickthrough-active",
      resetWindows: "ui.tray-reset-windows",
      reloadHook: "ui.tray-reload-hook",
      quit: "ui.tray-quit",
    });
  });

  it("swallows a failing invoke", async () => {
    ipc.__TAURI_IPC__ = () => {};
    invoke.mockRejectedValueOnce(new Error("tray gone"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(syncTrayLabels()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
