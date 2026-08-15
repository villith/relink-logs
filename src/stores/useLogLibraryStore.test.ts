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
    useLogLibraryStore.setState({ logs: [], loaded: false, loading: false });
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

  it("degrades to an empty library when the running backend has no such command", async () => {
    vi.mocked(invoke).mockRejectedValue("no such command");
    await useLogLibraryStore.getState().load();
    expect(useLogLibraryStore.getState().logs).toEqual([]);
    expect(useLogLibraryStore.getState().loaded).toBe(true);
  });

  // A failed load that left `loading` true would wedge the picker empty for the
  // rest of the session, with no way to ask again.
  it("does not stay wedged in loading after a failure", async () => {
    vi.mocked(invoke).mockRejectedValue("no such command");
    await useLogLibraryStore.getState().load();
    expect(useLogLibraryStore.getState().loading).toBe(false);
  });
});
