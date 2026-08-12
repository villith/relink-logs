import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NuqsAdapter } from "nuqs/adapters/react-router/v6";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const emit = vi.fn();
const listen = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock("@tauri-apps/api", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: (...a: unknown[]) => emit(...a),
  listen: (...a: unknown[]) => listen(...a),
}));
vi.mock("@/useHookStatus", () => ({ useHookStatus: () => null }));
vi.mock("react-hot-toast", () => ({
  default: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}));
// Keys pass through verbatim; interpolation values are appended so a toast's
// arguments (which action failed, with which error) can be asserted.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
  }),
}));

import DebugPage from "./Debug";

/** Frames the hook reports as queued; 0 is the invariant-violation path. */
let scenarioFrames = 3;
/** Commands that should reject, mapped to the slug they reject with. */
let failures: Record<string, string> = {};

// MemoryRouter because the page links out to the dev-only legality audit; a
// bare render has no router context for that link to resolve against.
// NuqsAdapter because the page's tab selection lives in the URL as `?tab=`.
const renderPage = () =>
  render(
    <MantineProvider>
      <MemoryRouter>
        <NuqsAdapter>
          <DebugPage />
        </NuqsAdapter>
      </MemoryRouter>
    </MantineProvider>
  );

const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};

const HOOK_BUTTONS = [
  "ui.debug.hook-refresh",
  "ui.debug.hook-eject-hold",
  "ui.debug.hook-allow-reinject",
  "ui.debug.hook-eject-once",
  "ui.debug.hook-force-out-of-date",
  "ui.debug.hook-force-restart-required",
  "ui.debug.hook-clear-override",
  "ui.debug.hook-clear-override-quietly",
];

const ENCOUNTER_BUTTONS = [
  "ui.debug.encounter-start",
  "ui.debug.encounter-tick",
  "ui.debug.encounter-end",
  "ui.debug.encounter-reset",
];

describe("Debug page", () => {
  beforeEach(() => {
    invoke.mockReset();
    emit.mockReset();
    listen.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
    scenarioFrames = 3;
    failures = {};

    listen.mockResolvedValue(() => {});
    invoke.mockImplementation((command: string) => {
      if (Object.hasOwn(failures, command)) return Promise.reject(failures[command]);
      switch (command) {
        case "get_full_assist_unlock":
        case "debug_hold_out_state":
          return Promise.resolve(false);
        case "debug_broadcast_scenario":
          return Promise.resolve(scenarioFrames);
        default:
          return Promise.resolve(undefined);
      }
    });
  });

  // The thesis of this page: it drives the real hook and only listens. A
  // frontend `emit` would fabricate the very state the page exists to display.
  it("never emits an event — every button goes to the backend", async () => {
    await act(async () => {
      renderPage();
    });

    for (const name of [...HOOK_BUTTONS, ...ENCOUNTER_BUTTONS]) {
      await click(name);
    }

    expect(emit).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalled();
  });

  it("invokes the expected command and arguments for each hook-state button", async () => {
    await act(async () => {
      renderPage();
    });

    await click("ui.debug.hook-refresh");
    expect(invoke).toHaveBeenCalledWith("refresh_hook", undefined);

    await click("ui.debug.hook-eject-hold");
    expect(invoke).toHaveBeenCalledWith("debug_eject_hook", { hold: true });

    await click("ui.debug.hook-eject-once");
    expect(invoke).toHaveBeenCalledWith("debug_eject_hook", { hold: false });

    await click("ui.debug.hook-allow-reinject");
    expect(invoke).toHaveBeenCalledWith("debug_allow_reinject", undefined);

    // camelCase on the wire; Tauri snake_cases these into the Rust command.
    await click("ui.debug.hook-force-out-of-date");
    expect(invoke).toHaveBeenCalledWith("debug_set_hello_override", { hookVersion: "0.0.1", supportsEject: true });

    await click("ui.debug.hook-force-restart-required");
    expect(invoke).toHaveBeenCalledWith("debug_set_hello_override", { hookVersion: "0.0.1", supportsEject: false });

    await click("ui.debug.hook-clear-override");
    expect(invoke).toHaveBeenCalledWith("debug_clear_hello_override", { resync: true });

    // Same command, deliberately NOT resynced: it leaves the app holding the
    // stale verdict so the heartbeat's recovery is observable on the badge
    // instead of being masked by an immediate app-side refresh.
    await click("ui.debug.hook-clear-override-quietly");
    expect(invoke).toHaveBeenCalledWith("debug_clear_hello_override", { resync: false });
  });

  it("sends each encounter scenario by name", async () => {
    await act(async () => {
      renderPage();
    });

    for (const kind of ["start", "tick", "end", "reset"]) {
      await click(`ui.debug.encounter-${kind}`);
      expect(invoke).toHaveBeenCalledWith("debug_broadcast_scenario", { kind });
    }
    expect(toastError).not.toHaveBeenCalled();
  });

  it("treats a zero-frame broadcast as a failure, not a success", async () => {
    scenarioFrames = 0;
    await act(async () => {
      renderPage();
    });

    await click("ui.debug.encounter-start");

    expect(toastError).toHaveBeenCalledWith("ui.debug.sent-nothing");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("names the failing action in its error toast", async () => {
    failures = { refresh_hook: "game-not-running" };
    await act(async () => {
      renderPage();
    });

    await click("ui.debug.hook-refresh");

    expect(toastError).toHaveBeenCalledWith(
      // The mapped slug ("No game found") alone would not say which of the
      // eleven buttons produced it.
      `ui.debug.action-failed:${JSON.stringify({
        action: "ui.debug.hook-refresh",
        error: "ui.hook-status.no-game",
      })}`
    );
  });
});
