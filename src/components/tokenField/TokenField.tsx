import { Input } from "@mantine/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Dropcursor, Placeholder, UndoRedo } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
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
  /** Drop the visible label, keeping it only as the field's accessible name.
   * For rows in a list where every field means the same thing and printing the
   * label on each one is noise — the accessible name still has to be there,
   * which is why this hides the label rather than removing it. */
  hideLabel?: boolean;
  /** Tokens already placed somewhere in this editor's section. A drop of one of
   * these is refused, so a token cannot be spent twice. */
  used?: readonly string[];
};

/**
 * A single-line template editor where every `{token}` is an atomic chip.
 *
 * Tokens arrive by dragging one from the palette, clicking one in the palette,
 * or typing the name — all three produce the same node, and `renderText` turns
 * the document back into the `{token}` string that gets persisted, so the
 * stored format is unchanged.
 */
export const TokenField = ({ label, value, onChange, tokens, placeholder, hideLabel, used = [] }: TokenFieldProps) => {
  const { t } = useTranslation();
  const { setActiveEditor } = useTokenPalette();
  const [dropTarget, setDropTarget] = useState(false);
  const removeLabel = t("ui.token-remove");

  const editor = useEditor(
    {
      extensions: [
        OneLineDocument,
        Paragraph,
        Text,
        // Per-field, so a typed `{name}` can mark itself unknown against THIS
        // field's whitelist. The editor is rebuilt when `tokens` changes, so the
        // configured copy never goes stale.
        TokenNode.configure({ allowed: tokens, removeLabel }),
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

  /**
   * Accepts the drag, which is what makes the WHOLE box a drop target.
   *
   * ProseMirror only accepts drops over its own element, and that element is
   * inset by the field's padding — a ~6px band top and bottom and ~11px each
   * side of what looks like one uniform input. Releasing there produced no drop
   * event at all, so the token silently went nowhere. The handler sits on the
   * wrapper so the bordered box the user aims at is the box that accepts.
   */
  const allowDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(TOKEN_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropTarget(true);
  };

  const dropToken = (event: DragEvent<HTMLDivElement>) => {
    setDropTarget(false);
    const name = event.dataTransfer.getData(TOKEN_MIME);
    if (!name || !editor || editor.isDestroyed) return;
    event.preventDefault();
    // The palette already refuses to drag a spent token; this is the same rule
    // enforced where the insert actually happens.
    if (used.includes(name)) return;

    const unknown = !tokens.includes(name);
    const at = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
    // No document position under the pointer means the drop landed on the
    // padding. "Into this box" means the end of the text, not nowhere.
    if (at) {
      editor.chain().focus().insertContentAt(at.pos, { type: "token", attrs: { name, unknown } }).run();
    } else {
      editor.chain().focus("end").insertToken(name, unknown).run();
    }
  };

  const field = (
    <div
      className={dropTarget ? "token-field is-drop-target" : "token-field"}
      onDragOver={allowDrop}
      onDragEnter={allowDrop}
      onDragLeave={() => setDropTarget(false)}
      onDrop={dropToken}
    >
      <EditorContent editor={editor} />
    </div>
  );

  return hideLabel ? field : <Input.Wrapper label={label}>{field}</Input.Wrapper>;
};
