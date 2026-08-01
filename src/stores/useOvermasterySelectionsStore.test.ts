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

/** Fresh module instance each time, as if the app had been restarted. The
 * store is built with `skipHydration`, so the reload has to rehydrate the way
 * a real launch does — via `bootstrapDurableSettings()`, which runs every
 * registered key's handler once settings.db has had its say. */
const freshStore = async () => {
  vi.resetModules();
  const store = (await import("./useOvermasterySelectionsStore")).useOvermasterySelectionsStore;
  await store.persist.rehydrate();
  return store;
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
