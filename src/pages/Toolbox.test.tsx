import { describe, expect, it } from "vitest";
import { TOOLS, toolboxNewIds, visibleTools } from "./Toolbox";

const tools = [{ to: "/a", windowsOnly: true }, { to: "/b", windowsOnly: true }, { to: "/c" }];

describe("visibleTools", () => {
  it("windows keeps every tool", () => {
    expect(visibleTools(tools, false)).toHaveLength(3);
  });

  it("linux drops windows-only tools", () => {
    expect(visibleTools(tools, true).map((t) => t.to)).toEqual(["/c"]);
  });
});

describe("toolboxNewIds", () => {
  it("covers the toolbox itself plus every tool that flags a feature", () => {
    expect(toolboxNewIds([{ newId: "overmastery-predictor" as const }, {}], false)).toEqual([
      "toolbox",
      "overmastery-predictor",
    ]);
  });

  it("linux ignores windows-only tools", () => {
    expect(toolboxNewIds([{ newId: "overmastery-predictor" as const, windowsOnly: true }], true)).toEqual(["toolbox"]);
  });

  it("carries the real tool list, so a newly shipped tool reaches the tab", () => {
    expect(toolboxNewIds(TOOLS, false)).toContain("transmarvel-wishlist");
  });
});
