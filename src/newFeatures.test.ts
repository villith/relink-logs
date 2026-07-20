import { describe, expect, it } from "vitest";

import { compareVersions, isNewVersion } from "./newFeatures";

describe("compareVersions", () => {
  it("orders version triples numerically", () => {
    expect(compareVersions("1.9.6", "1.9.6")).toBe(0);
    expect(compareVersions("1.9.6", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.9.10", "1.9.9")).toBeGreaterThan(0); // numeric, not lexicographic
  });
});

describe("isNewVersion", () => {
  it("a plain version is new until the app moves past it", () => {
    expect(isNewVersion("1.9.6", "1.9.5")).toBe(true); // staged ahead of the release
    expect(isNewVersion("1.9.6", "1.9.6")).toBe(true); // the shipping release itself
    expect(isNewVersion("1.9.6", "1.9.7")).toBe(false); // next release: chip expires
    expect(isNewVersion("1.9.6", "1.10.0")).toBe(false);
  });

  it("a range is new between its bounds, inclusive", () => {
    const range = { from: "1.9.6", until: "1.9.8" };
    expect(isNewVersion(range, "1.9.5")).toBe(false); // before the feature ships
    expect(isNewVersion(range, "1.9.6")).toBe(true);
    expect(isNewVersion(range, "1.9.7")).toBe(true);
    expect(isNewVersion(range, "1.9.8")).toBe(true);
    expect(isNewVersion(range, "1.9.9")).toBe(false);
  });

  it("range bounds are optional", () => {
    expect(isNewVersion({ until: "1.9.8" }, "1.0.0")).toBe(true);
    expect(isNewVersion({ until: "1.9.8" }, "1.9.9")).toBe(false);
    expect(isNewVersion({ from: "1.9.6" }, "1.9.5")).toBe(false);
    expect(isNewVersion({ from: "1.9.6" }, "2.0.0")).toBe(true);
  });
});
