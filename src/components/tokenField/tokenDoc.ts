import { splitTemplate } from "@/labelTemplate";
import type { JSONContent } from "@tiptap/core";

/**
 * Converts a stored `{token}` template into the editor's document.
 *
 * The reverse direction needs no code: the token node's `renderText` emits
 * `{name}`, so `editor.getText()` returns the original template shape and what
 * we persist never changes.
 */
export const templateToDoc = (template: string, allowed: readonly string[]): JSONContent => {
  const content: JSONContent[] = splitTemplate(template).map((part) =>
    part.type === "text"
      ? { type: "text", text: part.value }
      : { type: "token", attrs: { name: part.name, unknown: !allowed.includes(part.name) } }
  );

  // The empty case omits `content` rather than passing `[]`. ProseMirror
  // accepts either — they load identically — but `editor.getJSON()` only ever
  // emits the absent key, so matching it keeps this function's output directly
  // comparable to the editor's for a dirty check.
  return { type: "doc", content: [content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" }] };
};
