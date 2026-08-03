import { describe, expect, it } from "vitest";
import { sigilIconUrl } from "./sigilIcon";

describe("sigilIconUrl", () => {
  it("resolves a shape and tier to its medallion", () => {
    expect(sigilIconUrl(1, 0)).toMatch(/01_00\.png/);
  });

  it("resolves every base tier of every shape", () => {
    const missing: string[] = [];
    for (let shape = 1; shape <= 5; shape++)
      for (let tier = 0; tier <= 4; tier++)
        if (sigilIconUrl(shape, tier) === undefined) missing.push(`${shape}/${tier}`);
    expect(missing).toEqual([]);
  });

  it("resolves the variants the atlas draws", () => {
    expect(sigilIconUrl(1, 4, { plus: true })).toMatch(/01_04_plus\.png/);
    expect(sigilIconUrl(1, 4, { ex: true })).toMatch(/01_04_ex01\.png/);
    expect(sigilIconUrl(1, 4, { ex: true, plus: true })).toMatch(/01_04_ex01_plus\.png/);
    expect(sigilIconUrl(5, 4, { chr: true })).toMatch(/05_04_chr\.png/);
  });

  it("returns undefined for a variant the game never sells", () => {
    // plus art starts at tier 2; a tier-0 plus is absence-as-data, not an error
    expect(sigilIconUrl(1, 0, { plus: true })).toBeUndefined();
  });

  it("returns undefined outside the shape range", () => {
    expect(sigilIconUrl(6, 0)).toBeUndefined();
  });
});
