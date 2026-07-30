import { mergeAttributes, Node, nodeInputRule } from "@tiptap/core";

/** How a dragged token travels between the palette and a field. A custom MIME
 * type rather than `text/plain` so the field's drop handler can tell one of our
 * tokens from arbitrary dragged text and ignore the latter. The constant only
 * names the channel — the ignoring is the drop handler's job. */
export const TOKEN_MIME = "application/x-relink-token";

/** A token name the `{token}` grammar in labelTemplate.ts would actually parse.
 * Kept in step with TOKEN_PATTERN there: a name outside this shape could not
 * survive `getText()` → stored string → reparse. */
const VALID_TOKEN_NAME = /^[a-zA-Z][a-zA-Z0-9]*$/;

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
 * Declaring no `content` makes this a leaf, and leafness is what makes it
 * behave as one object: it occupies a single position, so the caret has nowhere
 * inside to land and backspace takes the whole token rather than a character.
 * That is the entire point of chips over free text. `atom: true` does not cause
 * that — a leaf is atomic either way — but it says so explicitly and keeps the
 * behaviour if this ever gains a `content` spec.
 *
 * `renderText` is what keeps the stored value in the existing `{name}` format:
 * `editor.getText()` walks the doc through the text serializers collected from
 * each node's `renderText`, and so does the clipboard serializer, so copying a
 * chip as plain text also yields `{name}`.
 */
export type TokenNodeOptions = {
  /** The names this field accepts. Only the input rule reads it — a typed token
   * has to know whether it is one of them to mark itself, and the node is the
   * only place that runs while typing. Configure it per field. */
  allowed: readonly string[];
  /** Accessible name for a chip's remove button. Passed in rather than looked
   * up here because the node is created outside React, where `t` is not. */
  removeLabel: string;
};

export const TokenNode = Node.create<TokenNodeOptions>({
  name: "token",

  addOptions() {
    return { allowed: [], removeLabel: "Remove" };
  },

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
    return [
      {
        // BOTH the attribute and our own class, because `data-token` alone is
        // not ours: analytics and design systems use it too, so an ordinary
        // copy-paste from a web page would otherwise mint a chip. That paste is
        // destructive rather than merely wrong — the span's visible text is
        // DISCARDED and replaced by whatever the attribute said, turning
        // `<span data-token="tracking">Buy now</span>` into `{tracking}`.
        //
        // Requiring the class costs nothing if a clipboard strips it: our chip
        // then pastes as the literal text `{app}`, which is exactly the stored
        // representation, and becomes a chip again on the next load.
        tag: "span[data-token].token-chip",
        // A name outside the `{token}` grammar could not survive getText() →
        // stored string → reparse. Worse, one carrying braces round-trips as
        // MORE nodes than it started with: `data-token="a} evil {b"` writes out
        // as `{a} evil {b}`, which reparses as two tokens plus literal text.
        //
        // `false` rejects the rule and lets the span fall through to its text;
        // `null` accepts it and leaves the attribute parsers to fill the attrs.
        getAttrs: (element) => (VALID_TOKEN_NAME.test(element.getAttribute("data-token") ?? "") ? null : false),
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "token-chip" }), `{${node.attrs.name}}`];
  },

  renderText({ node }) {
    return `{${node.attrs.name}}`;
  },

  /**
   * The on-screen chip: its name, plus a button that removes it.
   *
   * A node view rather than plain `renderHTML` because a button needs a live
   * click handler. This affects only what is DRAWN — `getHTML`, `getText` and
   * the clipboard still go through `renderHTML`/`renderText`, so the stored
   * string and the paste guard are untouched by anything here.
   *
   * Without the button the only ways to remove a token are backspace and
   * select-then-delete, neither of which the chip advertises.
   */
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement("span");
      dom.className = "token-chip";
      dom.setAttribute("data-token", node.attrs.name);
      if (node.attrs.unknown) dom.setAttribute("data-unknown", "true");
      // A leaf inside a contenteditable: without this the caret can be placed
      // among the chip's own characters and typing would edit the label text.
      dom.contentEditable = "false";

      const label = document.createElement("span");
      label.className = "token-chip-label";
      label.textContent = `{${node.attrs.name}}`;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "token-chip-remove";
      remove.textContent = "×";
      remove.title = this.options.removeLabel;
      remove.setAttribute("aria-label", `${this.options.removeLabel}: {${node.attrs.name}}`);
      // The chip is `draggable`, so a mousedown on the button would otherwise
      // begin dragging the chip instead of arming the click.
      remove.addEventListener("mousedown", (event) => event.preventDefault());
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        const pos = typeof getPos === "function" ? getPos() : null;
        if (typeof pos !== "number") return;
        editor
          .chain()
          .focus()
          .deleteRange({ from: pos, to: pos + node.nodeSize })
          .run();
      });

      dom.append(label, remove);

      return {
        dom,
        // ONLY the remove button's events are withheld from ProseMirror.
        // Returning true unconditionally would also swallow the chip's own drag,
        // which `draggable: true` exists to allow.
        stopEvent: (event) => event.target instanceof Element && event.target.closest(".token-chip-remove") !== null,
      };
    };
  },

  /**
   * Typing `{name}` becomes a chip the moment the closing brace lands.
   *
   * Without this, the third of the three documented ways to add a token —
   * drag, click, type — produces literal text that only turns into a chip on
   * the next mount, so the field silently disagrees with itself about what a
   * token looks like. Input rules do not fire on paste, which is the behaviour
   * we want: pasted text is left exactly as pasted.
   */
  addInputRules() {
    return [
      nodeInputRule({
        // The capture spans the BRACES TOO, and that is not cosmetic:
        // `nodeInputRule` replaces the range of `match[1]`, not of `match[0]`,
        // so capturing only the name leaves the braces behind and `{app}` types
        // out as `{` + chip + `}` — which serializes to `{{app}}`.
        //
        // Anchored to the caret, and the same grammar as TOKEN_PATTERN: a name
        // this rejects could not survive the stored-string round trip anyway.
        find: /(\{[a-zA-Z][a-zA-Z0-9]*\})$/,
        type: this.type,
        getAttributes: (match) => {
          const name = match[1].slice(1, -1);
          return { name, unknown: !this.options.allowed.includes(name) };
        },
      }),
    ];
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
