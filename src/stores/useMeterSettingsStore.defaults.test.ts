import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Locks the claim that the label-template and bar-appearance settings need no
 * store migration: `merge` spreads the current defaults *under* the persisted
 * state, so a localStorage copy written before those fields existed must
 * hydrate with them filled in rather than left undefined.
 *
 * Exercises the real persist/rehydrate path rather than simulating it with a
 * spread — a simulated merge cannot catch a mistake in `merge` itself.
 */
describe("meter settings defaults", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("fills in the new appearance fields for a store persisted before they existed", async () => {
    // A v2 payload from a release that predates bar appearance and label templates.
    localStorage.setItem(
      "meter-settings",
      JSON.stringify({ version: 2, state: { color_1: "#123456", transparency: 0.5 } })
    );

    const { useMeterSettingsStore, DEFAULT_PLAYER_LABEL } = await import("./useMeterSettingsStore");
    const state = useMeterSettingsStore.getState();

    // What the user had saved survives untouched.
    expect(state.color_1).toBe("#123456");
    expect(state.transparency).toBe(0.5);

    // What they never had takes its default rather than arriving undefined.
    expect(state.player_label_template).toBe(DEFAULT_PLAYER_LABEL);
    expect(state.bar_fill_mode).toBe("total");
    expect(state.bar_texture).toBe("solid");
    expect(state.bar_height).toBe(27);
    expect(state.bar_spacing).toBe(0);
    expect(state.header_segments.length).toBeGreaterThan(0);
  });

  it("ships defaults that leave the meter looking exactly as it did before", async () => {
    const { useMeterSettingsStore, DEFAULT_PLAYER_LABEL } = await import("./useMeterSettingsStore");
    const state = useMeterSettingsStore.getState();

    // Every default here exists to make this feature a no-op for anyone who
    // never opens the settings page.
    expect(state.player_label_template).toBe(DEFAULT_PLAYER_LABEL);
    expect(state.bar_fill_mode).toBe("total");
    expect(state.bar_texture).toBe("solid");
    expect(state.bar_height).toBe(27);
    expect(state.bar_spacing).toBe(0);
  });

  it("seeds header segments that reproduce the original header", async () => {
    const { useMeterSettingsStore } = await import("./useMeterSettingsStore");
    const segments = useMeterSettingsStore.getState().header_segments;

    expect(segments.map((segment) => segment.id)).toEqual(["brand", "damage", "dps", "hp", "status"]);
    expect(segments.filter((segment) => segment.side === "right").map((segment) => segment.template)).toEqual([
      "{status}",
    ]);
    // The three that used to disappear on a narrow overlay still do.
    expect(segments.filter((segment) => segment.hideWhenNarrow).map((segment) => segment.id)).toEqual([
      "damage",
      "dps",
      "hp",
    ]);
  });
});
