import { sectionNewIds } from "@/newFeatures";
import { describe, expect, it } from "vitest";
import { TOOLS, visibleTools } from "./Toolbox";

const tools = [{ to: "/a", windowsOnly: true }, { to: "/b", windowsOnly: true }, { to: "/c" }];

describe("visibleTools", () => {
  it("windows keeps every tool", () => {
    expect(visibleTools(tools, false)).toHaveLength(3);
  });

  it("linux drops windows-only tools", () => {
    expect(visibleTools(tools, true).map((t) => t.to)).toEqual(["/c"]);
  });
});

// What the Logs header actually renders on the Toolbox tab.
describe("the toolbox tab's new-feature ids", () => {
  it("cover the toolbox itself plus every tool that flags a feature", () => {
    expect(sectionNewIds("toolbox", [{ newId: "overmastery-predictor" as const }, {}])).toEqual([
      "toolbox",
      "overmastery-predictor",
    ]);
  });

  it("ignore windows-only tools on linux", () => {
    const linuxTools = visibleTools([{ newId: "overmastery-predictor" as const, windowsOnly: true }], true);
    expect(sectionNewIds("toolbox", linuxTools)).toEqual(["toolbox"]);
  });

  it("carry the real tool list, so a newly shipped tool reaches the tab", () => {
    expect(sectionNewIds("toolbox", visibleTools(TOOLS, false))).toContain("transmarvel-wishlist");
  });
});
