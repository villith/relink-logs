import { Group, UnstyledButton } from "@mantine/core";
import { DotsSixVertical } from "@phosphor-icons/react";
import type { Editor } from "@tiptap/core";
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TOKEN_MIME } from "./TokenNode";
import "./tokenField.css";

type TokenPaletteContextValue = {
  setActiveEditor: (editor: Editor) => void;
  insert: (name: string) => void;
};

/** Default is inert rather than throwing: a TokenField outside a provider is a
 * field with no palette, which is a legitimate way to use one. */
const TokenPaletteContext = createContext<TokenPaletteContextValue>({
  setActiveEditor: () => {},
  insert: () => {},
});

export const useTokenPalette = () => useContext(TokenPaletteContext);

/**
 * Scopes a palette to the fields beneath it.
 *
 * The active editor is a ref, not state: it changes on every focus and nothing
 * renders from it, so storing it in state would re-render every field in the
 * section each time the user tabs between them.
 */
export const TokenPaletteProvider = ({ children }: { children: ReactNode }) => {
  const active = useRef<Editor | null>(null);

  const value = useMemo<TokenPaletteContextValue>(
    () => ({
      setActiveEditor: (editor) => {
        active.current = editor;
      },
      insert: (name) => {
        const editor = active.current;
        if (!editor || editor.isDestroyed) return;
        editor.chain().focus().insertToken(name).run();
      },
    }),
    []
  );

  return <TokenPaletteContext.Provider value={value}>{children}</TokenPaletteContext.Provider>;
};

export type TokenPaletteProps = {
  tokens: readonly string[];
  /** Tokens already placed in this section's fields. Shown spent rather than
   * hidden, so the list of what exists does not change shape as you build. */
  used?: readonly string[];
};

/**
 * The list of tokens a field accepts, as chips.
 *
 * Both affordances are real: drag places a token exactly where it is dropped,
 * and click appends it to whichever field was last focused. Click is not a
 * lesser fallback — it is the only path available from the keyboard, and it is
 * what most people will reach for.
 *
 * Each chip carries a grip glyph. A plain code-styled box reads as a label —
 * something to look at, not something to pick up — and the drag affordance was
 * being missed entirely. That glyph is also why the row needs no "Available:"
 * caption: a row of grippable chips above a field does not read as anything
 * else.
 */
export const TokenPalette = ({ tokens, used = [] }: TokenPaletteProps) => {
  const { t } = useTranslation();
  const { insert } = useTokenPalette();

  return (
    <Group gap={6}>
      {tokens.map((token) => {
        const spent = used.includes(token);
        return (
          // A button wrapping the chip rather than `Code component="button"`:
          // Mantine's Code is typed to <code>'s element props, so it rejects
          // `type="button"` — and a chip that submits a surrounding form is the
          // kind of bug that only shows up once one exists.
          <UnstyledButton
            key={token}
            type="button"
            // `draggable` is set from the same flag that disables the click, so
            // a spent token cannot be re-added by either route.
            draggable={!spent}
            disabled={spent}
            className={spent ? "token-source is-spent" : "token-source"}
            title={spent ? t("ui.token-already-used") : t("ui.token-insert-hint")}
            onDragStart={(event) => {
              event.dataTransfer.setData(TOKEN_MIME, token);
              event.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => insert(token)}
          >
            <DotsSixVertical size={12} weight="bold" className="token-source-grip" />
            <span className="token-source-name">{`{${token}}`}</span>
          </UnstyledButton>
        );
      })}
    </Group>
  );
};
