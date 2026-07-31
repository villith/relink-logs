import { describe, expect, it } from "vitest";
import { renderTemplate, renderTemplateNodes, splitTemplate, unknownTokens, usedTokens } from "./labelTemplate";

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

  // Rule 4: literal text is there to decorate a value. With every value gone
  // there is nothing left to decorate, so the whole template goes — otherwise
  // the default header segments read "/s" and "HP /" before a fight starts.
  it("renders empty when every token is empty, whatever literal text surrounds them", () => {
    expect(renderTemplate("{dps}/s", { dps: "" })).toBe("");
    expect(renderTemplate("HP {hpPercent} ({hpCurrent} / {hpMax})", { hpPercent: "", hpCurrent: "", hpMax: "" })).toBe(
      ""
    );
  });

  it("keeps the literal text once any one token has a value", () => {
    expect(renderTemplate("{dps}/s", { dps: "61.2k" })).toBe("61.2k/s");
    expect(
      renderTemplate("HP {hpPercent} ({hpCurrent} / {hpMax})", { hpPercent: "45.2%", hpCurrent: "", hpMax: "" })
    ).toBe("HP 45.2%");
  });

  it("does not count an unknown token as an empty one", () => {
    // `{nope}` stays literal, so the segment still has something to show and
    // the typo remains visible rather than silently blanking the whole thing.
    expect(renderTemplate("{nope}/s", {})).toBe("{nope}/s");
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

describe("usedTokens", () => {
  it("collects the tokens across several templates", () => {
    expect(usedTokens(["{a} text", "{b}"])).toEqual(["a", "b"]);
  });

  it("reports a token once however many templates use it", () => {
    expect(usedTokens(["{a} {a}", "{a}"])).toEqual(["a"]);
  });

  it("ignores shapes the token grammar rejects", () => {
    expect(usedTokens(["100% {} {1bad}"])).toEqual([]);
  });

  it("returns nothing for empty templates", () => {
    expect(usedTokens(["", ""])).toEqual([]);
  });
});

describe("splitTemplate", () => {
  it("splits text and tokens in order", () => {
    expect(splitTemplate("HP {hpPercent} left")).toEqual([
      { type: "text", value: "HP " },
      { type: "token", name: "hpPercent" },
      { type: "text", value: " left" },
    ]);
  });

  it("returns a single text part when there are no tokens", () => {
    expect(splitTemplate("plain")).toEqual([{ type: "text", value: "plain" }]);
  });

  it("returns nothing for an empty template", () => {
    expect(splitTemplate("")).toEqual([]);
  });

  it("emits adjacent tokens with no empty text between them", () => {
    expect(splitTemplate("{a}{b}")).toEqual([
      { type: "token", name: "a" },
      { type: "token", name: "b" },
    ]);
  });

  it("leaves shapes the token pattern rejects as literal text", () => {
    expect(splitTemplate("100% {} {1bad}")).toEqual([{ type: "text", value: "100% {} {1bad}" }]);
  });

  it("does not care whether a token is a known one", () => {
    expect(splitTemplate("{bogus}")).toEqual([{ type: "token", name: "bogus" }]);
  });

  /**
   * The whole reason the stored template format survives a trip through the
   * chip editor: split then rejoin has to be the identity. One property test
   * catches every cursor-arithmetic mistake at once — a dropped text run, an
   * off-by-one slice, a surrogate pair cut in half.
   */
  it("round-trips: rejoining the parts reproduces the template", () => {
    const rejoin = (template: string) =>
      splitTemplate(template)
        .map((part) => (part.type === "text" ? part.value : `{${part.name}}`))
        .join("");

    const cases = [
      "",
      "plain",
      "{a}",
      "{a}{b}",
      "HP {a}",
      "{a} left",
      "{x} {x}",
      "{a",
      "a}",
      "{{a}}",
      "{ a }",
      "{1bad}",
      "100% {} {x}",
      "🎉{a}🎉",
      "[{slot}] {name} ({character})",
      "HP {hpPercent} ({hpCurrent} / {hpMax})",
    ];

    for (const template of cases) expect(rejoin(template)).toBe(template);
  });

  /**
   * splitTemplate and unknownTokens walk the same pattern through the same
   * private helper. If someone gives one of them its own walk, this catches the
   * drift — which is the entire reason the parser lives in this module.
   */
  it("agrees with unknownTokens about which names are tokens", () => {
    const template = "[{slot}] {name} ({character}) {bogus} {1bad}";
    const found = splitTemplate(template).flatMap((part) => (part.type === "token" ? [part.name] : []));

    expect(found).toEqual(["slot", "name", "character", "bogus"]);
    expect(unknownTokens(template, ["slot", "name", "character"])).toEqual(["bogus"]);
  });
});

describe("renderTemplateNodes", () => {
  it("returns a node part for a node token, carrying its raw value", () => {
    expect(renderTemplateNodes("{icon} {name}", { icon: "Pl1400", name: "Scott" }, ["icon"])).toEqual([
      { type: "node", name: "icon", value: "Pl1400" },
      { type: "text", value: " Scott" },
    ]);
  });

  it("returns plain text when no node token is used", () => {
    expect(renderTemplateNodes("{name}", { name: "Scott" }, ["icon"])).toEqual([{ type: "text", value: "Scott" }]);
  });

  // An emptied node token has to behave exactly like an emptied text token,
  // or the collapse rules would apply to some tokens and not others.
  it("drops an emptied node token and leaves the rest", () => {
    expect(renderTemplateNodes("{icon} {name}", { icon: "", name: "Scott" }, ["icon"])).toEqual([
      { type: "text", value: "Scott" },
    ]);
  });

  it("unwraps a bracket group following an emptied node token (rule 2)", () => {
    expect(renderTemplateNodes("{icon} ({name})", { icon: "", name: "Scott" }, ["icon"])).toEqual([
      { type: "text", value: "Scott" },
    ]);
  });

  it("renders nothing when every token emptied (rule 3)", () => {
    expect(renderTemplateNodes("{icon} ({name})", { icon: "", name: "" }, ["icon"])).toEqual([]);
  });

  it("keeps a node token that repeats", () => {
    expect(renderTemplateNodes("{icon}{icon}", { icon: "Pl0000" }, ["icon"])).toEqual([
      { type: "node", name: "icon", value: "Pl0000" },
      { type: "node", name: "icon", value: "Pl0000" },
    ]);
  });

  it("leaves an unknown token literal, as the string renderer does", () => {
    expect(renderTemplateNodes("{nope} {name}", { name: "Scott" }, ["icon"])).toEqual([
      { type: "text", value: "{nope} Scott" },
    ]);
  });

  it("agrees with renderTemplate when no token is a node token", () => {
    const tokens = { slot: "1", name: "", character: "Io" };
    const parts = renderTemplateNodes("[{slot}] {name} ({character})", tokens, []);
    expect(parts).toEqual([{ type: "text", value: renderTemplate("[{slot}] {name} ({character})", tokens) }]);
  });
});
