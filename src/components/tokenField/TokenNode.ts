import { mergeAttributes, Node } from "@tiptap/core";

/** How a dragged token travels between the palette and a field. A custom MIME
 * type rather than `text/plain`: dropping a token must not look like dropping
 * arbitrary text, and a foreign drop from outside the app must be ignored. */
export const TOKEN_MIME = "application/x-relink-token";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    token: {
      /** Insert a token chip at the cursor. */
      insertToken: (name: string, unknown?: boolean) => ReturnType;
    };
  }
}

/**
 * A `{token}` as an atomic inline chip.
 *
 * `atom: true` is what makes it behave as one object: the caret cannot land
 * inside it and backspace removes the whole token, which is the entire point of
 * chips over free text. `renderText` is what keeps the stored value in the
 * existing `{name}` format — `editor.getText()` walks the doc through the text
 * serializers collected from each node's `renderText`.
 */
export const TokenNode = Node.create({
  name: "token",

  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      name: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-token") ?? "",
        renderHTML: (attributes) => ({ "data-token": attributes.name }),
      },
      // Set when the name is outside the field's whitelist. Carried as an
      // attribute rather than recomputed at render time because renderHTML has
      // no access to the field's token list.
      unknown: {
        default: false,
        parseHTML: (element) => element.getAttribute("data-unknown") === "true",
        renderHTML: (attributes) => (attributes.unknown ? { "data-unknown": "true" } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-token]" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: "token-chip", "data-testid": "token-chip" }),
      `{${node.attrs.name}}`,
    ];
  },

  renderText({ node }) {
    return `{${node.attrs.name}}`;
  },

  addCommands() {
    return {
      insertToken:
        (name, unknown = false) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { name, unknown } }),
    };
  },
});
