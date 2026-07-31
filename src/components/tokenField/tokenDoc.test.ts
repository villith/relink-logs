import { describe, expect, it } from "vitest";
import { templateToDoc } from "./tokenDoc";

const ALLOWED = ["app", "version", "hpPercent"];

describe("templateToDoc", () => {
  it("wraps a plain string in one paragraph", () => {
    expect(templateToDoc("hello", ALLOWED)).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
    });
  });

  it("turns a known token into a token node", () => {
    expect(templateToDoc("{app}", ALLOWED)).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "token", attrs: { name: "app", unknown: false } }] }],
    });
  });

  it("marks a token outside the whitelist as unknown", () => {
    expect(templateToDoc("{bogus}", ALLOWED)).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "token", attrs: { name: "bogus", unknown: true } }] }],
    });
  });

  it("interleaves text and tokens", () => {
    expect(templateToDoc("HP {hpPercent}!", ALLOWED)).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "HP " },
            { type: "token", attrs: { name: "hpPercent", unknown: false } },
            { type: "text", text: "!" },
          ],
        },
      ],
    });
  });

  it("produces an empty paragraph for an empty template", () => {
    expect(templateToDoc("", ALLOWED)).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
  });
});
