import { describe, expect, it } from "vitest";
import { characterIconUrl } from "./characterIcon";

describe("characterIconUrl", () => {
  it("resolves a character id to its icon", () => {
    expect(characterIconUrl("Pl1400")).toMatch(/Pl1400\.png/);
  });

  it("resolves every id the lang table names", async () => {
    const characters = (await import("../src-tauri/lang/en/characters.json")).default;
    const missing = Object.keys(characters).filter((id) => characterIconUrl(id) === undefined);
    expect(missing).toEqual([]);
  });

  /**
   * Pl2000 is the id the parser remaps to Pl1900 for recruited Id, and the
   * atlas has no art under it. Falling back here rather than at the call site
   * keeps the remap in one place — a caller that forgot it would silently show
   * no icon for a real party member.
   */
  it("falls back to Pl1900 for the recruited-Id alias", () => {
    expect(characterIconUrl("Pl2000")).toBe(characterIconUrl("Pl1900"));
  });

  it("returns undefined for an id with no icon", () => {
    expect(characterIconUrl("Pl9999")).toBeUndefined();
  });

  it("returns undefined for an empty id", () => {
    expect(characterIconUrl("")).toBeUndefined();
  });
});
