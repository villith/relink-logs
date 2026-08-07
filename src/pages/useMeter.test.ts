import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners: Record<string, (e: { payload: unknown }) => void> = {};
const listen = vi.fn((event: string, cb: (e: { payload: unknown }) => void) => {
  listeners[event] = cb;
  // Only drop the entry if it is still ours: React runs the cleanup before the
  // next effect, but the unlisten resolves a microtask later, so a naive delete
  // would remove the freshly registered handler instead.
  return Promise.resolve(() => {
    if (listeners[event] === cb) delete listeners[event];
  });
});

const invoke = vi.fn(() => Promise.resolve());

vi.mock("@tauri-apps/api/event", () => ({ listen: (...a: Parameters<typeof listen>) => listen(...a) }));
vi.mock("@tauri-apps/api", () => ({ invoke: (...a: unknown[]) => invoke(...(a as [])) }));
vi.mock("react-hot-toast", () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/useMeterSettingsStore", () => ({
  useMeterSettingsStore: (sel: (s: { transparency: number }) => unknown) => sel({ transparency: 0.5 }),
}));

import useMeter from "./useMeter";

/** One party slot; only the fields the hook passes through matter here. */
const player = (actorIndex: number) => ({ actorIndex, displayName: `p${actorIndex}` });

const pushPartyUpdate = async (actorIndex: number) => {
  await act(async () => {
    listeners["encounter-party-update"]({ payload: [player(actorIndex), null, null, null] });
  });
};

describe("useMeter", () => {
  beforeEach(() => {
    listen.mockClear();
    invoke.mockClear();
    for (const k of Object.keys(listeners)) delete listeners[k];
  });

  // The backend only emits the party and its verdicts when they actually
  // change, so a meter mounting mid-fight has already missed them and would
  // draw four blank rows for the rest of a quest whose party never changes
  // again. Asking once on mount is what replaces the old per-hit broadcast.
  it("asks the backend to republish the live state on mount", async () => {
    renderHook(() => useMeter());

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("request_live_republish"));
  });

  // `listen` is async: the handler is not actually registered until its promise
  // resolves. Asking any earlier races the backend's reply against our own
  // registration, and losing that race puts us back to blank rows -- the exact
  // failure the republish exists to prevent.
  it("does not ask for a republish until every listener is registered", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    listen.mockImplementationOnce((event: string, cb: (e: { payload: unknown }) => void) => {
      listeners[event] = cb;
      return gate.then(() => () => {
        if (listeners[event] === cb) delete listeners[event];
      });
    });

    renderHook(() => useMeter());
    await act(async () => {});

    expect(invoke).not.toHaveBeenCalledWith("request_live_republish");

    await act(async () => {
      release();
    });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("request_live_republish"));
  });

  // The backend re-emits `encounter-party-update` on every damage hit
  // (parser/v1/mod.rs insert_player_data), so any listener churn keyed on party
  // data runs at combat rate. Tauri v1's `listen` leaks a `window._<uid>`
  // closure per call that `unlisten` never removes, so re-registering is an
  // unbounded renderer leak -- ~275k leaked callbacks after 70 minutes.
  it("does not re-register event listeners when party data changes", async () => {
    renderHook(() => useMeter());
    await waitFor(() => expect(listen).toHaveBeenCalled());
    const registrationsAfterMount = listen.mock.calls.length;

    await pushPartyUpdate(1);
    await pushPartyUpdate(2);
    await pushPartyUpdate(3);

    expect(listen.mock.calls.length).toBe(registrationsAfterMount);
  });

  it("still applies party updates to the returned state", async () => {
    const { result } = renderHook(() => useMeter());
    await waitFor(() => expect(listeners["encounter-party-update"]).toBeDefined());

    await pushPartyUpdate(7);

    expect(result.current.partyData[0]).toMatchObject({ actorIndex: 7 });
  });
});
