import { Input } from "@mantine/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Dropcursor, Placeholder, UndoRedo } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect } from "react";
import { TOKEN_MIME, TokenNode } from "./TokenNode";
import { useTokenPalette } from "./TokenPalette";
import { templateToDoc } from "./tokenDoc";
import "./tokenField.css";

/** Exactly one paragraph: the document cannot be split, so Enter has nothing to
 * do and the field stays one line without a keymap fighting the user. */
const OneLineDocument = Document.extend({ content: "paragraph" });

export type TokenFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Token names this field accepts — anything else renders as a broken chip. */
  tokens: readonly string[];
  placeholder?: string;
};

/**
 * A single-line template editor where every `{token}` is an atomic chip.
 *
 * Tokens arrive by dragging one from the palette, clicking one in the palette,
 * or typing the name — all three produce the same node, and `renderText` turns
 * the document back into the `{token}` string that gets persisted, so the
 * stored format is unchanged.
 */
export const TokenField = ({ label, value, onChange, tokens, placeholder }: TokenFieldProps) => {
  const { setActiveEditor } = useTokenPalette();

  const editor = useEditor(
    {
      extensions: [
        OneLineDocument,
        Paragraph,
        Text,
        TokenNode,
        UndoRedo,
        Dropcursor.configure({ width: 2 }),
        Placeholder.configure({ placeholder: placeholder ?? "" }),
      ],
      content: templateToDoc(value, tokens),
      // TipTap does NOT throw on malformed content. It logs a warning and
      // silently replaces the WHOLE document with an empty paragraph — so a
      // template that failed to parse would erase itself the instant the field
      // mounted, and `onUpdate` would then persist the empty string over the
      // user's saved value. `templateToDoc` cannot currently emit invalid
      // content (no empty text nodes are reachable), so this is a backstop
      // against a future change, not a live bug. Keep the raw string as
      // literal text rather than lose it.
      enableContentCheck: true,
      onContentError: ({ editor: instance, error }) => {
        console.error("[TokenField] template did not parse; showing it as plain text:", value, error);
        if (value === "") return; // an empty text node would fail the same check
        instance.commands.setContent(
          { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] },
          { emitUpdate: false }
        );
      },
      editorProps: {
        // `role`/`aria-multiline` because a contenteditable div carries no
        // implicit role: without them this is an unlabelled generic to a screen
        // reader rather than the single-line text box it behaves as.
        attributes: {
          class: "token-field-input",
          role: "textbox",
          "aria-multiline": "false",
          "aria-label": label,
        },
        // A Document pinned to one paragraph DROPS every line after the first
        // on a multi-line paste, silently and with no feedback — paste
        // "one\ntwo" and only "one" arrives. Flatten instead of losing it.
        transformPastedText: (text) => text.replace(/\s*\n\s*/g, " "),
        // ProseMirror-level so we can claim the event and stop the default
        // text-insert path. posAtCoords resolves the drop point to a document
        // position — the browser's own caret-from-point, but in doc space.
        handleDrop: (view, event) => {
          const name = event.dataTransfer?.getData(TOKEN_MIME);
          if (!name) return false;

          const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (!at) return false;

          const node = view.state.schema.nodes.token.create({ name, unknown: !tokens.includes(name) });
          view.dispatch(view.state.tr.insert(at.pos, node));
          event.preventDefault();
          return true;
        },
      },
      onUpdate: ({ editor: instance }) => onChange(instance.getText()),
      onFocus: ({ editor: instance }) => setActiveEditor(instance),
    },
    // Rebuild only when the whitelist itself changes. `value` is deliberately
    // absent: this editor owns its content once mounted, and re-seeding it on
    // every keystroke would fight the user's caret.
    [tokens]
  );

  // An external change — a reset, or a sync from the overlay window — still has
  // to reach the field. Compare against what the editor would emit so our own
  // onUpdate never triggers a re-seed.
  useEffect(() => {
    if (editor && !editor.isDestroyed && editor.getText() !== value) {
      editor.commands.setContent(templateToDoc(value, tokens), { emitUpdate: false });
    }
  }, [editor, value, tokens]);

  return (
    <Input.Wrapper label={label}>
      <div className="token-field">
        <EditorContent editor={editor} />
      </div>
    </Input.Wrapper>
  );
};
