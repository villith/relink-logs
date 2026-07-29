import { beforeEach, describe, expect, it } from "vitest";
import { migrateV1, useChecklistStore } from "./useChecklistStore";

const groupById = (id: string) => useChecklistStore.getState().groups.find((group) => group.id === id)!;

describe("useChecklistStore entries", () => {
  beforeEach(() => {
    localStorage.clear();
    useChecklistStore.getState().reset();
  });

  it("seeds three enabled, auto-ordered groups from the bundled defaults", () => {
    const { groups } = useChecklistStore.getState();
    expect(groups.map((group) => group.id)).toEqual(["build", "computed", "ai"]);
    expect(groups.every((group) => group.enabled && !group.manualOrder)).toBe(true);
    expect(groupById("build").entries).toHaveLength(13);
    expect(groupById("build").entries.every((entry) => entry.enabled)).toBe(true);
    expect(groupById("build").entries.find((entry) => entry.ids[0] === 0x57ab5b10)!.level).toBe(45);
    expect(groupById("ai").entries).toEqual([{ ids: [0xa8a3163b], level: 15, enabled: true }]);
  });

  it("setLevel changes only the targeted entry in the targeted group", () => {
    useChecklistStore.getState().setLevel("build", 0xdc584f60, 55);
    expect(groupById("build").entries.find((entry) => entry.ids[0] === 0xdc584f60)!.level).toBe(55);
    expect(groupById("build").entries.find((entry) => entry.ids[0] === 0x4c588c27)!.level).toBe(15);
  });

  it("toggle flips an entry's enabled without touching other fields", () => {
    useChecklistStore.getState().toggle("ai", 0xa8a3163b);
    expect(groupById("ai").entries).toEqual([{ ids: [0xa8a3163b], level: 15, enabled: false }]);
    useChecklistStore.getState().toggle("ai", 0xa8a3163b);
    expect(groupById("ai").entries[0].enabled).toBe(true);
  });

  it("remove drops the entry", () => {
    useChecklistStore.getState().remove("build", 0x4c588c27);
    expect(groupById("build").entries).toHaveLength(12);
    expect(groupById("build").entries.some((entry) => entry.ids[0] === 0x4c588c27)).toBe(false);
  });

  it("add appends an enabled entry and rejects duplicates within the group", () => {
    useChecklistStore.getState().add("build", 0x12345678, 20);
    expect(groupById("build").entries).toHaveLength(14);
    expect(groupById("build").entries[13]).toEqual({ ids: [0x12345678], level: 20, enabled: true });

    useChecklistStore.getState().add("build", 0x12345678, 30);
    useChecklistStore.getState().add("build", 0x4c588c27, 30);
    // A secondary id inside a multi-id entry counts as present.
    useChecklistStore.getState().add("build", 0x0151cf9e, 30);
    expect(groupById("build").entries).toHaveLength(14);
    expect(groupById("build").entries[13].level).toBe(20);
  });

  it("add allows the same trait in a different group", () => {
    useChecklistStore.getState().add("ai", 0x4c588c27, 15);
    expect(groupById("ai").entries).toHaveLength(2);
  });

  it("add is a no-op on the computed group", () => {
    useChecklistStore.getState().add("computed", 0x12345678, 20);
    expect(groupById("computed").entries).toEqual([]);
  });

  it("reset restores the bundled defaults", () => {
    useChecklistStore.getState().remove("build", 0x4c588c27);
    useChecklistStore.getState().setLevel("build", 0xdc584f60, 1);
    useChecklistStore.getState().reset();
    expect(groupById("build").entries).toHaveLength(13);
    expect(groupById("build").entries.find((entry) => entry.ids[0] === 0xdc584f60)!.level).toBe(65);
  });
});

describe("migrateV1", () => {
  it("maps build/ai into three groups in Builds-tab order", () => {
    const groups = migrateV1({
      build: [{ ids: [0x4c588c27], level: 15, enabled: true }],
      ai: [{ ids: [0xa8a3163b], level: 15, enabled: false }],
    });
    expect(groups.map((group) => group.id)).toEqual(["build", "computed", "ai"]);
    expect(groups.map((group) => group.kind)).toEqual(["custom", "computed", "custom"]);
  });

  it("preserves every level, enabled flag and user-added entry", () => {
    const groups = migrateV1({
      build: [
        { ids: [0xdc584f60, 0x0151cf9e], level: 55, enabled: false },
        { ids: [0x12345678], level: 20, enabled: true },
      ],
      ai: [],
    });
    expect(groups.find((group) => group.id === "build")!.entries).toEqual([
      { ids: [0xdc584f60, 0x0151cf9e], level: 55, enabled: false },
      { ids: [0x12345678], level: 20, enabled: true },
    ]);
    expect(groups.find((group) => group.id === "ai")!.entries).toEqual([]);
  });

  it("leaves every migrated group enabled and auto-ordered, so nothing visibly moves", () => {
    const groups = migrateV1({ build: [], ai: [] });
    expect(groups.every((group) => group.enabled && !group.manualOrder)).toBe(true);
    expect(groups.map((group) => group.nameKey)).toEqual([
      "ui.checklist.sigils",
      "ui.checklist.computed",
      "ui.checklist.ai",
    ]);
  });

  it("falls back to the bundled defaults for a missing or malformed key", () => {
    const groups = migrateV1({ ai: [{ ids: [0xa8a3163b], level: 15, enabled: true }] });
    expect(groups.find((group) => group.id === "build")!.entries).toHaveLength(13);
  });
});

describe("useChecklistStore groups", () => {
  beforeEach(() => {
    localStorage.clear();
    useChecklistStore.getState().reset();
  });

  it("addGroup appends an empty custom group with a unique id", () => {
    const first = useChecklistStore.getState().addGroup("New group");
    const second = useChecklistStore.getState().addGroup("New group");
    expect(first).toBe("g-1");
    expect(second).toBe("g-2");
    const group = groupById("g-1");
    expect(group).toMatchObject({ name: "New group", kind: "custom", enabled: true, manualOrder: false });
    expect(group.entries).toEqual([]);
    expect(group.nameKey).toBeUndefined();
  });

  it("renameGroup sets the literal name and drops the i18n key", () => {
    useChecklistStore.getState().renameGroup("build", "  Offense  ");
    expect(groupById("build").name).toBe("Offense");
    expect(groupById("build").nameKey).toBeUndefined();
  });

  it("renameGroup ignores an empty name", () => {
    useChecklistStore.getState().renameGroup("build", "   ");
    expect(groupById("build").nameKey).toBe("ui.checklist.sigils");
  });

  it("toggleGroup flips the group switch", () => {
    useChecklistStore.getState().toggleGroup("ai");
    expect(groupById("ai").enabled).toBe(false);
  });

  it("removeGroup drops a custom group but never the computed one", () => {
    useChecklistStore.getState().removeGroup("ai");
    expect(useChecklistStore.getState().groups.map((group) => group.id)).toEqual(["build", "computed"]);
    useChecklistStore.getState().removeGroup("computed");
    expect(useChecklistStore.getState().groups.map((group) => group.id)).toEqual(["build", "computed"]);
  });

  it("reorderGroups moves a group within the list", () => {
    useChecklistStore.getState().reorderGroups(2, 0);
    expect(useChecklistStore.getState().groups.map((group) => group.id)).toEqual(["ai", "build", "computed"]);
  });

  it("reorderEntries writes the given order and switches the group to manual", () => {
    const ids = groupById("build").entries.map((entry) => entry.ids[0]);
    useChecklistStore.getState().reorderEntries("build", [ids[2], ids[0], ids[1]]);
    const group = groupById("build");
    expect(group.manualOrder).toBe(true);
    expect(group.entries.slice(0, 3).map((entry) => entry.ids[0])).toEqual([ids[2], ids[0], ids[1]]);
    // Entries the order did not name keep their relative position, at the end.
    expect(group.entries).toHaveLength(13);
  });

  it("sortGroup returns the group to automatic alphabetical order", () => {
    useChecklistStore.getState().reorderEntries("build", [0x4c588c27]);
    expect(groupById("build").manualOrder).toBe(true);
    useChecklistStore.getState().sortGroup("build");
    expect(groupById("build").manualOrder).toBe(false);
  });

  it("moveEntry moves an entry across groups in the given destination order", () => {
    useChecklistStore.getState().moveEntry("build", "ai", 0x4c588c27, [0x4c588c27, 0xa8a3163b]);
    expect(groupById("build").entries.some((entry) => entry.ids[0] === 0x4c588c27)).toBe(false);
    expect(groupById("ai").entries.map((entry) => entry.ids[0])).toEqual([0x4c588c27, 0xa8a3163b]);
    expect(groupById("ai").manualOrder).toBe(true);
  });

  it("moveEntry rejects a destination that already holds one of the trait ids", () => {
    useChecklistStore.getState().add("ai", 0x4c588c27, 15);
    useChecklistStore.getState().moveEntry("build", "ai", 0x4c588c27, [0x4c588c27]);
    expect(groupById("build").entries.some((entry) => entry.ids[0] === 0x4c588c27)).toBe(true);
    expect(groupById("ai").entries).toHaveLength(2);
  });

  it("moveEntry refuses the computed group as a destination", () => {
    useChecklistStore.getState().moveEntry("build", "computed", 0x4c588c27, [0x4c588c27]);
    expect(groupById("computed").entries).toEqual([]);
    expect(groupById("build").entries).toHaveLength(13);
  });
});

describe("persisted v1 rehydration", () => {
  it("migrates a real v1 payload through the persist middleware", async () => {
    // The shape the shipped app writes at version 1: two lists, no groups.
    localStorage.setItem(
      "checklist-settings",
      JSON.stringify({
        state: {
          build: [
            { ids: [0x4c588c27], level: 15, enabled: true },
            { ids: [0xdc584f60, 0x0151cf9e], level: 55, enabled: false },
            { ids: [0x12345678], level: 20, enabled: true },
          ],
          ai: [{ ids: [0xa8a3163b], level: 15, enabled: true }],
        },
        version: 1,
      })
    );

    await useChecklistStore.persist.rehydrate();

    const { groups } = useChecklistStore.getState();
    expect(groups.map((group) => group.id)).toEqual(["build", "computed", "ai"]);
    expect(groups.every((group) => group.enabled && !group.manualOrder)).toBe(true);
    expect(groupById("build").entries).toEqual([
      { ids: [0x4c588c27], level: 15, enabled: true },
      { ids: [0xdc584f60, 0x0151cf9e], level: 55, enabled: false },
      { ids: [0x12345678], level: 20, enabled: true },
    ]);
    expect(groupById("ai").entries).toEqual([{ ids: [0xa8a3163b], level: 15, enabled: true }]);
    // The actions must survive the merge, or the editor is dead on arrival.
    expect(typeof useChecklistStore.getState().addGroup).toBe("function");
  });

  it("leaves an already-migrated v2 payload alone", async () => {
    localStorage.setItem(
      "checklist-settings",
      JSON.stringify({
        state: {
          groups: [
            { id: "g-1", name: "Offense", kind: "custom", enabled: false, manualOrder: true, entries: [] },
          ],
        },
        version: 2,
      })
    );

    await useChecklistStore.persist.rehydrate();

    expect(useChecklistStore.getState().groups).toEqual([
      { id: "g-1", name: "Offense", kind: "custom", enabled: false, manualOrder: true, entries: [] },
    ]);
  });
});
