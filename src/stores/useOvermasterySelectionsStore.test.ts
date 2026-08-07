import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ROLLS } from "./useOvermasterySelectionsStore";

const KEY = "overmastery-selections";
const katalina = "18e2f9f9";
const rackam = "079df0cc";
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

  it("remembers the whole character selection across reloads", async () => {
    (await freshStore()).getState().setLastCharacters([katalina, rackam]);
    const reloaded = await freshStore();
    expect(reloaded.getState().lastCharacters).toEqual([katalina, rackam]);
  });

  it("save() leaves the remembered selection alone", async () => {
    // The form saves the shared goal under every selected character, so a
    // save must not claim to be the selection — that would leave the last
    // character of the loop as the whole remembered selection.
    const store = await freshStore();
    store.getState().setLastCharacters([katalina, rackam]);
    store.getState().save(rackam, entry);
    expect(store.getState().lastCharacters).toEqual([katalina, rackam]);
  });

  it("migrates a v1 row's single remembered character into a selection", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ state: { selections: { [katalina]: entry }, lastCharacter: katalina, rolls: 120 }, version: 1 })
    );
    const store = await freshStore();
    expect(store.getState().lastCharacters).toEqual([katalina]);
    expect(store.getState().selections[katalina]).toEqual(entry);
    expect(store.getState().rolls).toBe(120);
  });

  it("migrates a v1 row that never picked a character to an empty selection", async () => {
    localStorage.setItem(KEY, JSON.stringify({ state: { selections: {}, lastCharacter: null }, version: 1 }));
    expect((await freshStore()).getState().lastCharacters).toEqual([]);
  });

  it("remembers the roll count across reloads", async () => {
    (await freshStore()).getState().setRolls(120);
    const reloaded = await freshStore();
    expect(reloaded.getState().rolls).toBe(120);
  });

  it("keeps the default roll count for state persisted before it existed", async () => {
    // What a pre-upgrade user's row looks like: selections, no `rolls`.
    localStorage.setItem(KEY, JSON.stringify({ state: { selections: {}, lastCharacter: null }, version: 1 }));
    expect((await freshStore()).getState().rolls).toBe(DEFAULT_ROLLS);
  });
});
