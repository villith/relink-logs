import { Code, Group, Text, UnstyledButton } from "@mantine/core";
import type { Editor } from "@tiptap/core";
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TOKEN_MIME } from "./TokenNode";

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

/**
 * The list of tokens a field accepts, as chips.
 *
 * Both affordances are real: drag places a token exactly where it is dropped,
 * and click appends it to whichever field was last focused. Click is not a
 * lesser fallback — it is the only path available from the keyboard, and it is
 * what most people will reach for.
 */
export const TokenPalette = ({ tokens }: { tokens: readonly string[] }) => {
  const { t } = useTranslation();
  const { insert } = useTokenPalette();

  return (
    <Group gap={6}>
      <Text size="xs" c="dimmed">
        {t("ui.template-tokens")}
      </Text>
      {tokens.map((token) => (
        // A button wrapping the Code rather than `Code component="button"`:
        // Mantine's Code is typed to <code>'s element props, so it rejects
        // `type="button"` — and a chip that submits a surrounding form is the
        // kind of bug that only shows up once one exists.
        <UnstyledButton
          key={token}
          type="button"
          draggable
          title={t("ui.token-insert-hint")}
          style={{ cursor: "grab" }}
          onDragStart={(event) => {
            event.dataTransfer.setData(TOKEN_MIME, token);
            event.dataTransfer.effectAllowed = "copy";
          }}
          onClick={() => insert(token)}
        >
          <Code>{`{${token}}`}</Code>
        </UnstyledButton>
      ))}
    </Group>
  );
};
