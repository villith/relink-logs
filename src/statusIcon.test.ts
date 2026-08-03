import { describe, expect, it } from "vitest";
import { statusIconUrl } from "./statusIcon";

describe("statusIconUrl", () => {
  it("resolves a status id to its icon", () => {
    // 1000 is Poison, mapped by status.tbl to the wkn_006 sprite.
    expect(statusIconUrl(1000)).toMatch(/wkn_006\.png/);
  });

  it("resolves every id the lang table names", async () => {
    const statuses = (await import("../src-tauri/lang/en/statuses.json")).default;
    const missing = Object.keys(statuses).filter((id) => statusIconUrl(Number(id)) === undefined);
    expect(missing).toEqual([]);
  });

  it("shares one icon between statuses the game draws the same", () => {
    // 23 and 33 are distinct effects on one piece of art (str_021) — the
    // reason the lookup goes through status-map.json instead of filenames.
    expect(statusIconUrl(23)).toBeDefined();
    expect(statusIconUrl(33)).toBe(statusIconUrl(23));
  });

  it("returns undefined for an id with no icon", () => {
    expect(statusIconUrl(999999)).toBeUndefined();
  });
});
