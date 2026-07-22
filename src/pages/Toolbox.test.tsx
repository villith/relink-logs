import { describe, expect, it } from "vitest";
import { visibleTools } from "./Toolbox";

const tools = [{ to: "/a", windowsOnly: true }, { to: "/b", windowsOnly: true }, { to: "/c" }];

describe("visibleTools", () => {
  it("windows keeps every tool", () => {
    expect(visibleTools(tools, false)).toHaveLength(3);
  });

  it("linux drops windows-only tools", () => {
    expect(visibleTools(tools, true).map((t) => t.to)).toEqual(["/c"]);
  });
});
