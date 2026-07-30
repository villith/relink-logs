import { describe, expect, it } from "vitest";
import { renderTemplate, unknownTokens } from "./labelTemplate";

describe("renderTemplate", () => {
  it("substitutes known tokens", () => {
    expect(renderTemplate("{a} and {b}", { a: "one", b: "two" })).toBe("one and two");
  });

  it("leaves an unknown token literal so a typo is visible", () => {
    expect(renderTemplate("{a} {nope}", { a: "one" })).toBe("one {nope}");
  });

  it("returns a template with no tokens verbatim", () => {
    expect(renderTemplate("Relink Logs", {})).toBe("Relink Logs");
  });

  // Rule 1: a bracket group left with no content is removed entirely.
  it("removes a bracket group left empty", () => {
    expect(renderTemplate("Lv {lvl} ({rank})", { lvl: "5", rank: "" })).toBe("Lv 5");
  });

  it("removes an empty square-bracket group", () => {
    expect(renderTemplate("[{slot}] {character}", { slot: "", character: "Io" })).toBe("Io");
  });

  // Rule 2: a bracket group directly after an emptied token loses its brackets.
  it("unwraps a bracket group following an emptied token", () => {
    expect(renderTemplate("[{slot}] {name} ({character})", { slot: "1", name: "", character: "Io" })).toBe("[1] Io");
  });

  it("keeps the brackets when the preceding token is present", () => {
    expect(renderTemplate("[{slot}] {name} ({character})", { slot: "1", name: "Scott", character: "Io" })).toBe(
      "[1] Scott (Io)"
    );
  });

  // Rule 3
  it("collapses whitespace and trims", () => {
    expect(renderTemplate("  {a}   {b}  ", { a: "x", b: "y" })).toBe("x y");
  });

  it("renders empty when every token is empty", () => {
    expect(renderTemplate("{a} ({b})", { a: "", b: "" })).toBe("");
  });

  it("returns empty for an empty template", () => {
    expect(renderTemplate("", { a: "x" })).toBe("");
  });

  it("does not treat a bare brace or percent as a token", () => {
    expect(renderTemplate("100% {a}", { a: "x" })).toBe("100% x");
    expect(renderTemplate("{} {a}", { a: "x" })).toBe("{} x");
  });

  it("substitutes a repeated token everywhere it appears", () => {
    expect(renderTemplate("{a}-{a}", { a: "x" })).toBe("x-x");
  });
});

describe("unknownTokens", () => {
  it("lists tokens not in the allowed set", () => {
    expect(unknownTokens("{a} {b} {c}", ["a", "c"])).toEqual(["b"]);
  });

  it("returns an empty array when all tokens are known", () => {
    expect(unknownTokens("{a} literal", ["a", "b"])).toEqual([]);
  });

  it("does not report a token twice", () => {
    expect(unknownTokens("{x} {x}", [])).toEqual(["x"]);
  });
});
