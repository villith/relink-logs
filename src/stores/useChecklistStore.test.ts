import { beforeEach, describe, expect, it } from "vitest";
import { useChecklistStore } from "./useChecklistStore";

describe("useChecklistStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useChecklistStore.getState().reset();
  });

  it("seeds from the bundled defaults with every entry enabled", () => {
    const { build, ai } = useChecklistStore.getState();
    expect(build).toHaveLength(13);
    expect(build.find((entry) => entry.ids[0] === 0x57ab5b10)!.level).toBe(45);
    expect(build.every((entry) => entry.enabled)).toBe(true);
    expect(ai).toEqual([{ ids: [0xa8a3163b], level: 15, enabled: true }]);
    const dmgCap = build.find((entry) => entry.ids[0] === 0xdc584f60)!;
    expect(dmgCap.ids).toEqual([0xdc584f60, 0x0151cf9e, 0x3b71af12, 0xaefeb1bc, 0xfff8cf64]);
    expect(dmgCap.level).toBe(65);
  });

  it("setLevel changes only the targeted entry, keyed by first id", () => {
    useChecklistStore.getState().setLevel("build", 0xdc584f60, 55);
    const { build } = useChecklistStore.getState();
    expect(build.find((entry) => entry.ids[0] === 0xdc584f60)!.level).toBe(55);
    expect(build.find((entry) => entry.ids[0] === 0x4c588c27)!.level).toBe(15);
  });

  it("toggle flips enabled without touching other fields", () => {
    useChecklistStore.getState().toggle("ai", 0xa8a3163b);
    expect(useChecklistStore.getState().ai).toEqual([{ ids: [0xa8a3163b], level: 15, enabled: false }]);
    useChecklistStore.getState().toggle("ai", 0xa8a3163b);
    expect(useChecklistStore.getState().ai[0].enabled).toBe(true);
  });

  it("remove drops the entry", () => {
    useChecklistStore.getState().remove("build", 0x4c588c27);
    expect(useChecklistStore.getState().build).toHaveLength(12);
    expect(useChecklistStore.getState().build.some((entry) => entry.ids[0] === 0x4c588c27)).toBe(false);
  });

  it("add appends a single-id enabled entry and rejects duplicates", () => {
    useChecklistStore.getState().add("build", 0x12345678, 20);
    let { build } = useChecklistStore.getState();
    expect(build).toHaveLength(14);
    expect(build[build.length - 1]).toEqual({ ids: [0x12345678], level: 20, enabled: true });

    // Duplicate of a new entry and of a default entry: both rejected.
    useChecklistStore.getState().add("build", 0x12345678, 30);
    useChecklistStore.getState().add("build", 0x4c588c27, 30);
    build = useChecklistStore.getState().build;
    expect(build).toHaveLength(14);
    expect(build[build.length - 1].level).toBe(20);

    // Duplicate of a secondary id within a multi-id entry (DMG Cap group): rejected.
    useChecklistStore.getState().add("build", 0x0151cf9e, 30);
    build = useChecklistStore.getState().build;
    expect(build).toHaveLength(14);
  });

  it("reset restores the bundled defaults", () => {
    useChecklistStore.getState().remove("build", 0x4c588c27);
    useChecklistStore.getState().setLevel("build", 0xdc584f60, 1);
    useChecklistStore.getState().add("ai", 0x12345678, 20);
    useChecklistStore.getState().reset();
    const { build, ai } = useChecklistStore.getState();
    expect(build).toHaveLength(13);
    expect(build.find((entry) => entry.ids[0] === 0xdc584f60)!.level).toBe(65);
    expect(ai).toHaveLength(1);
  });
});
