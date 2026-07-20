import { describe, expect, it } from "vitest";

import { compareVersions, isNewVersion, NEW_FEATURES } from "./newFeatures";

describe("NEW_FEATURES", () => {
  it("shows the toolbox + overmastery predictor chips in the 1.10.0 release that ships them", () => {
    expect(isNewVersion(NEW_FEATURES["toolbox"], "1.10.0")).toBe(true);
    expect(isNewVersion(NEW_FEATURES["overmastery-predictor"], "1.10.0")).toBe(true);
  });
});

describe("compareVersions", () => {
  it("orders version triples numerically", () => {
    expect(compareVersions("1.9.6", "1.9.6")).toBe(0);
    expect(compareVersions("1.9.6", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.9.10", "1.9.9")).toBeGreaterThan(0); // numeric, not lexicographic
  });
});

describe("isNewVersion", () => {
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
