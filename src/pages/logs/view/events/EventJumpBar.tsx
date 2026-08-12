import { TextInput } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { Figure } from "@/components/ui/Figure";
import { Strip } from "@/components/ui/Strip";

/** The control, in the view's own palette rather than Mantine's stock input —
 * the same declaration the pin selectors wear, because this sits two rows above
 * them and a default input among token-built ones reads as two designs sharing
 * a screen. */
const INPUT_CLASS = [
  "h-control min-h-control rounded-sm border border-line bg-panel text-md text-ink",
  "text-ellipsis placeholder:text-ink-3 hover:border-line-strong",
  "focus:border-accent focus-within:border-accent",
].join(" ");

export type EventJumpBarProps = {
  text: string;
  onTextChange: (text: string) => void;
  /** Commit what is typed — Enter. */
  onCommit: (text: string) => void;
  /** The last commit landed nowhere: the text named no time, or named one past
   * the end of the stream. Before any commit this is false, because "no match"
   * would read as a failed search nobody ran. */
  missed: boolean;
};

/** Jump to a moment in the stream, without scrolling for it.
 *
 * A time and nothing else (see `parseTimeInput`): the four spellings it takes
 * cover how a fight is talked about, and narrowing to a player, an ability or
 * an effect is the column funnels' job rather than this one's. */
export const EventJumpBar = ({ text, onTextChange, onCommit, missed }: EventJumpBarProps) => {
  const { t } = useTranslation();

  return (
    <Strip rule="none" className="pb-1">
      <TextInput
        aria-label={t("ui.logs.events-jump-label")}
        placeholder={t("ui.logs.events-jump-placeholder")}
        value={text}
        // Sized to what it holds, not to the strip: a clock reading is a handful
        // of characters, and nothing typed here would ever have filled a
        // full-width control.
        className="w-[calc(160px*var(--density))] min-w-0"
        classNames={{ input: INPUT_CLASS }}
        onChange={(event) => onTextChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          onCommit(event.currentTarget.value);
        }}
      />

      {missed && (
        <Figure size="sm" tone="dim" data-jump-none>
          {t("ui.logs.events-jump-none")}
        </Figure>
      )}
    </Strip>
  );
};
