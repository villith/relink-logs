import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Dropcursor, Placeholder, UndoRedo } from "@tiptap/extensions";
import { describe, expect, it } from "vitest";
import { TokenNode } from "./TokenNode";
import { templateToDoc } from "./tokenDoc";

const ALLOWED = ["app", "version", "slot", "name", "character", "hpPercent", "hpCurrent", "hpMax"];

/**
 * The field's REAL extension set, not a reduced one.
 *
 * The round-trip guarantee is worth nothing if it is proved against a schema no
 * user ever runs, so this list has to stay identical to TokenField's. Kept in
 * one place precisely so that when the field's extensions change, this suite
 * changes with it rather than silently drifting into testing a fiction.
 */
const EXTENSIONS = [
  Document.extend({ content: "paragraph" }),
  Paragraph,
  Text,
  TokenNode.configure({ allowed: ALLOWED }),
  UndoRedo,
  Dropcursor,
  Placeholder.configure({ placeholder: "" }),
];

const editorWith = (content: unknown) =>
  new Editor({
    element: document.createElement("div"),
    extensions: EXTENSIONS,
    content: content as never,
    enableContentCheck: true,
  });

const roundTrip = (template: string): string => {
  const editor = editorWith(templateToDoc(template, ALLOWED));
  const text = editor.getText();
  editor.destroy();
  return text;
};

/**
 * Runs HTML through the schema's parse rules and reports the resulting text.
 *
 * Deliberately without `enableContentCheck`: that flag guards the `setContent`
 * path and throws on anything its rules reject, which is the opposite of what
 * we want to observe here — the whole question is what a REJECTED element falls
 * through to. The clipboard uses these same parse rules, so this covers the
 * rule; the end-to-end paste gesture is on A8's manual checklist.
 */
const parseHtml = (html: string): string => {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: EXTENSIONS,
    content: `<p>${html}</p>`,
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

  it("survives an undo/redo cycle", () => {
    const editor = editorWith(templateToDoc("HP {hpPercent}", ALLOWED));
    editor.commands.focus("end");
    editor.commands.insertToken("hpMax");
    expect(editor.getText()).toBe("HP {hpPercent}{hpMax}");
    editor.commands.undo();
    expect(editor.getText()).toBe("HP {hpPercent}");
    editor.commands.redo();
    expect(editor.getText()).toBe("HP {hpPercent}{hpMax}");
    editor.destroy();
  });

  it("renders a token as a chip carrying its name", () => {
    const editor = editorWith(templateToDoc("{app}", ALLOWED));
    expect(editor.getHTML()).toContain('data-token="app"');
    expect(editor.getHTML()).not.toContain("data-unknown");
    editor.destroy();
  });

  it("marks a token outside the whitelist in the rendered chip", () => {
    const editor = editorWith(templateToDoc("{bogus}", ALLOWED));
    expect(editor.getHTML()).toContain('data-unknown="true"');
    editor.destroy();
  });

  it("inserts a token via the insertToken command", () => {
    const editor = editorWith(templateToDoc("HP ", ALLOWED));
    editor.commands.focus("end");
    editor.commands.insertToken("hpPercent");
    expect(editor.getText()).toBe("HP {hpPercent}");
    editor.destroy();
  });
});

/**
 * Types text the way ProseMirror does, one character at a time through
 * `handleTextInput` — the hook input rules attach to.
 *
 * `insertText` alone would NOT do: it bypasses that hook, so a rule could be
 * broken and every test that used it would still pass.
 */
const typeText = (editor: Editor, text: string) => {
  for (const char of text) {
    const { from, to } = editor.state.selection;
    // The fifth argument is the transaction ProseMirror would apply by itself;
    // input rules take it as their fallback.
    const plainInsert = () => editor.state.tr.insertText(char, from, to);
    const handled = editor.view.someProp("handleTextInput", (rule) => rule(editor.view, from, to, char, plainInsert));
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to));
  }
};

describe("TokenNode input rule", () => {
  it("turns a typed {name} into a chip", () => {
    const editor = editorWith(templateToDoc("", ALLOWED));
    editor.commands.focus("end");
    typeText(editor, "{app}");
    expect(editor.getHTML()).toContain('data-token="app"');
    expect(editor.getText()).toBe("{app}");
    editor.destroy();
  });

  it("marks a typed token outside the whitelist as unknown", () => {
    const editor = editorWith(templateToDoc("", ALLOWED));
    editor.commands.focus("end");
    typeText(editor, "{bogus}");
    expect(editor.getHTML()).toContain('data-unknown="true"');
    editor.destroy();
  });

  it("leaves a shape the token grammar rejects as plain text", () => {
    const editor = editorWith(templateToDoc("", ALLOWED));
    editor.commands.focus("end");
    typeText(editor, "{1bad}");
    expect(editor.getHTML()).not.toContain("data-token");
    expect(editor.getText()).toBe("{1bad}");
    editor.destroy();
  });

  it("keeps typing around an existing token intact", () => {
    const editor = editorWith(templateToDoc("HP ", ALLOWED));
    editor.commands.focus("end");
    typeText(editor, "{hpPercent} left");
    expect(editor.getText()).toBe("HP {hpPercent} left");
    editor.destroy();
  });
});

describe("TokenNode paste guard", () => {
  it("keeps our own chips when they are pasted back", () => {
    expect(parseHtml('<span data-token="app" class="token-chip">{app}</span>')).toBe("{app}");
  });

  it("preserves the unknown marker through a paste", () => {
    expect(parseHtml('<span data-token="bogus" data-unknown="true" class="token-chip">{bogus}</span>')).toBe("{bogus}");
  });

  // `data-token` is used in the wild by analytics and design systems, so this
  // is an ordinary copy-paste from a web page, not a crafted attack. Note the
  // name here is a perfectly VALID token name — validating the name alone does
  // not save us, which is why the rule requires our own class. Without that,
  // the span's visible text is DISCARDED and "Buy now" comes back "{tracking}".
  it("parses a foreign span as its text, not as a chip", () => {
    expect(parseHtml('<span data-token="tracking">Buy now</span>')).toBe("Buy now");
  });

  it("ignores a foreign span whose name is not even well formed", () => {
    expect(parseHtml('<span data-token="track-id-99">Buy now</span>')).toBe("Buy now");
  });

  it("does not mint an empty chip from an empty attribute", () => {
    expect(parseHtml('<span data-token="">zzz</span>')).toBe("zzz");
  });

  // A name carrying braces would serialize to text that reparses as MORE nodes
  // than it started with, so the document would not be stable under its own
  // round trip. Rejected even when it carries our class.
  it("rejects a name that would break the token grammar", () => {
    expect(parseHtml('<span data-token="a} evil {b" class="token-chip">q</span>')).toBe("q");
  });
});
