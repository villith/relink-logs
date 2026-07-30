import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { describe, expect, it } from "vitest";
import { TokenNode } from "./TokenNode";
import { templateToDoc } from "./tokenDoc";

const ALLOWED = ["app", "version", "slot", "name", "character", "hpPercent", "hpCurrent", "hpMax"];

/** The real single-line schema the field will use. */
const roundTrip = (template: string): string => {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [Document.extend({ content: "paragraph" }), Paragraph, Text, TokenNode],
    content: templateToDoc(template, ALLOWED),
    enableContentCheck: true,
  });
  const text = editor.getText();
  editor.destroy();
  return text;
};

describe("TokenNode round trip", () => {
  // The load-bearing promise of this whole feature: what the editor emits is
  // byte-identical to what was stored, so no migration is needed and a user's
  // saved template survives a trip through the chip editor untouched.
  it.each([
    "",
    "plain text",
    "{app}",
    "{app}{version}",
    "{app} {version}",
    "HP {hpPercent} ({hpCurrent} / {hpMax})",
    "[{slot}] {name} ({character})",
    "{app}{app}text{app}",
    "100% {app} {} {1bad}",
    "  leading and trailing  ",
    "日本語 {app} 😀",
    "{bogus}",
  ])("round-trips %j unchanged", (template) => {
    expect(roundTrip(template)).toBe(template);
  });

  it("renders a token as an atomic chip carrying its name", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: [Document.extend({ content: "paragraph" }), Paragraph, Text, TokenNode],
      content: templateToDoc("{app}", ALLOWED),
    });
    expect(editor.getHTML()).toContain('data-token="app"');
    expect(editor.getHTML()).not.toContain("data-unknown");
    editor.destroy();
  });

  it("marks a token outside the whitelist in the rendered chip", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: [Document.extend({ content: "paragraph" }), Paragraph, Text, TokenNode],
      content: templateToDoc("{bogus}", ALLOWED),
    });
    expect(editor.getHTML()).toContain('data-unknown="true"');
    editor.destroy();
  });

  it("inserts a token via the insertToken command", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: [Document.extend({ content: "paragraph" }), Paragraph, Text, TokenNode],
      content: templateToDoc("HP ", ALLOWED),
    });
    editor.commands.focus("end");
    editor.commands.insertToken("hpPercent");
    expect(editor.getText()).toBe("HP {hpPercent}");
    editor.destroy();
  });
});
