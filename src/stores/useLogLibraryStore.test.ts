import { invoke } from "@tauri-apps/api";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useLogLibraryStore } from "./useLogLibraryStore";

vi.mock("@tauri-apps/api", () => ({ invoke: vi.fn() }));
vi.mock("react-hot-toast", () => ({ default: { error: vi.fn() } }));

const row = (id: number) => ({
  id,
  time: 1,
  duration: 1,
  questId: null,
  questElapsedTime: null,
  p1Type: null,
  p2Type: null,
  p3Type: null,
  p4Type: null,
  repeatGroup: null,
});

describe("useLogLibraryStore", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useLogLibraryStore.setState({ logs: [], loaded: false, loading: false, invalidations: 0 });
  });

  it("loads the library once, however many pickers ask", async () => {
    vi.mocked(invoke).mockResolvedValue([row(1)]);
    await Promise.all([
      useLogLibraryStore.getState().load(),
      useLogLibraryStore.getState().load(),
      useLogLibraryStore.getState().load(),
    ]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(useLogLibraryStore.getState().logs).toHaveLength(1);
  });

  // The concurrent case above only exercises the in-flight guard. A pane opened
  // later mounts a picker long after the first load settled, and that one has to
  // read what is already in hand rather than refetch the whole library.
  it("does not refetch once the library is in hand", async () => {
    vi.mocked(invoke).mockResolvedValue([row(1)]);
    await useLogLibraryStore.getState().load();
    await useLogLibraryStore.getState().load();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  // What makes the cache follow the database: a run recorded (or logs deleted)
  // after the load is what the picker is most likely to be asked for next, and
  // without this it can never see it — the window lives in the tray all session.
  it("asks again after an invalidation", async () => {
    vi.mocked(invoke).mockResolvedValue([row(1)]);
    await useLogLibraryStore.getState().load();
    useLogLibraryStore.getState().invalidate();
    vi.mocked(invoke).mockResolvedValue([row(1), row(2)]);
    await useLogLibraryStore.getState().load();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(useLogLibraryStore.getState().logs).toHaveLength(2);
  });

  // A save landing while the first fetch is in flight would otherwise be lost:
  // the invalidation it raised is swallowed by the in-flight guard, and the
  // response that arrives after it was already missing the run.
  it("asks again when an invalidation races the fetch", async () => {
    vi.mocked(invoke).mockImplementationOnce(async () => {
      useLogLibraryStore.getState().invalidate();
      return [row(1)];
    });
    vi.mocked(invoke).mockResolvedValue([row(1), row(2)]);
    await useLogLibraryStore.getState().load();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(useLogLibraryStore.getState().logs).toHaveLength(2);
    expect(useLogLibraryStore.getState().loaded).toBe(true);
  });

  // A picker drawing the library it has must not blank while the refetch is in
  // flight; only `loaded` comes down.
  it("keeps the library it holds while the refetch is in flight", async () => {
    vi.mocked(invoke).mockResolvedValue([row(1)]);
    await useLogLibraryStore.getState().load();
    useLogLibraryStore.getState().invalidate();
    expect(useLogLibraryStore.getState().logs).toHaveLength(1);
  });

  it("degrades to an empty library when the running backend has no such command", async () => {
    vi.mocked(invoke).mockRejectedValue("no such command");
    await useLogLibraryStore.getState().load();
    expect(useLogLibraryStore.getState().logs).toEqual([]);
  });

  // A failed load that left EITHER flag set would wedge the picker empty for
  // the rest of the session, with no way to ask again: `loading` blocks the
  // guard directly, and `loaded` blocks it by claiming the library is already
  // in hand. Both have to come back down.
  it("does not stay wedged after a failure", async () => {
    vi.mocked(invoke).mockRejectedValue("no such command");
    await useLogLibraryStore.getState().load();
    expect(useLogLibraryStore.getState().loading).toBe(false);
    expect(useLogLibraryStore.getState().loaded).toBe(false);
  });

  // Which is the point of not latching: the next picker to mount retries, and a
  // transient failure costs one empty dropdown rather than the session.
  it("retries after a failure, and keeps what the retry found", async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce("locked")
      .mockResolvedValueOnce([row(1)]);
    await useLogLibraryStore.getState().load();
    await useLogLibraryStore.getState().load();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(useLogLibraryStore.getState().logs).toHaveLength(1);
  });
});
