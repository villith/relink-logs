import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "overmastery-selections";
const katalina = "18e2f9f9";
const entry = {
  tier: "2",
  wanted: [
    { kind: "0", minLevel: 8 },
    { kind: null, minLevel: null },
    { kind: null, minLevel: 9 },
    { kind: null, minLevel: null },
  ],
};

/** Fresh module instance each time, as if the app had been restarted. */
const freshStore = async () => {
  vi.resetModules();
  return (await import("./useOvermasterySelectionsStore")).useOvermasterySelectionsStore;
};

describe("useOvermasterySelectionsStore persistence", () => {
  beforeEach(() => localStorage.clear());

  it("save() writes through to localStorage", async () => {
    const store = await freshStore();
    store.getState().save(katalina, entry);
    const raw = JSON.parse(localStorage.getItem(KEY)!);
    expect(raw.state.selections[katalina]).toEqual(entry);
  });

  it("selections survive an app reload (fresh store hydrates from localStorage)", async () => {
    (await freshStore()).getState().save(katalina, entry);
    const reloaded = await freshStore();
    expect(reloaded.getState().selections[katalina]).toEqual(entry);
  });

  it("remembers the last saved character across reloads", async () => {
    (await freshStore()).getState().save(katalina, entry);
    const reloaded = await freshStore();
    expect(reloaded.getState().lastCharacter).toBe(katalina);
  });
});
