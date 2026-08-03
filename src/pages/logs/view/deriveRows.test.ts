import { describe, expect, it } from "vitest";

import { rowLevelFor } from "./deriveRows";

describe("rowLevelFor", () => {
  it("gives players when nothing is pinned", () => {
    expect(rowLevelFor({ source: null, targets: [], ability: null })).toBe("players");
  });

  it("gives abilities when only the source is pinned", () => {
    expect(rowLevelFor({ source: 1, targets: [], ability: null })).toBe("abilities");
  });

  it("gives skills when source and ability are both pinned", () => {
    expect(rowLevelFor({ source: 1, targets: [], ability: "Normal:100" })).toBe("skills");
  });

  it("treats a target pin as a scope, not a level", () => {
    // Pinning an enemy narrows what you are looking at; it does not change
    // whether rows are players. Only source and ability descend levels.
    expect(rowLevelFor({ source: null, targets: [2], ability: null })).toBe("players");
    expect(rowLevelFor({ source: 1, targets: [2], ability: null })).toBe("abilities");
  });

  it("gives skills when an ability is pinned without a source", () => {
    // Every member skill of that ability across the party — still the most
    // specific dimension left.
    expect(rowLevelFor({ source: null, targets: [], ability: "Normal:100" })).toBe("skills");
  });
});
