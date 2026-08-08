import { Select } from "@mantine/core";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { EntityIcon } from "@/components/ui/EntityIcon";

/** The control, the dropdown and one option, in the view's own palette rather
 * than Mantine's stock dark input. The rows these sit in are built from the same
 * tokens — the window chip beside them, the chips below — and a default input
 * among those reads as two designs sharing one row.
 *
 * Plain utilities, no compound selectors: Mantine's stylesheet is a cascade
 * LAYER now, so every utility outranks it whatever the source order. This used
 * to need `.analysis .analysis-select-input` because `.mantine-Select-input` has
 * the same one-class specificity and the winner was the bundler's choice. */
const INPUT_CLASS = [
  "h-control min-h-control rounded-sm border border-line bg-panel text-md text-ink",
  // The controls grow to fit their names (see below), but nothing bounds a
  // name — so the one that still overruns truncates rather than turning the
  // input into a horizontal scroller you have to drag a caret through.
  "text-ellipsis placeholder:text-ink-3 hover:border-line-strong",
  // The accent ring the window chip and the selected aura chip already wear, so
  // "this control is live" looks the same everywhere in the view.
  "focus:border-accent focus-within:border-accent",
].join(" ");

const OPTION_CLASS = [
  "rounded-xs text-md text-ink-2",
  // Hover and keyboard-active read the same, as they do on a table row: the
  // dropdown is a list of things to land on, not two kinds of highlight.
  "hover:bg-raised hover:text-ink",
  "data-[combobox-active]:bg-raised data-[combobox-active]:text-ink",
  "data-[combobox-selected]:bg-raised data-[combobox-selected]:text-ink",
].join(" ");

/** One entry in a pin selector. `iconUrl` is optional because most of what the
 * lists carry has no art at all — trash mobs have no portrait, and bare kinds
 * (link attacks, echoes, DoT) are not ability casts (see `rowIcon.ts`).
 *
 * `color` is the option's ACTOR colour (see `actorColor.ts`) — the same one its
 * chart band and its table row take, so the dropdown you pick an enemy from
 * already agrees with everything you are about to look at. Absent for the
 * abilities, which name no actor. */
export type LabelledOption = { value: string; label: string; iconUrl?: string; color?: string };

export type PinSelectProps = {
  /** The control's width when the row has nothing to spare — its flex basis and
   * its floor, not its size. It GROWS from here to take a share of whatever the
   * row has left, because the thing it has to fit is a name, and names have no
   * upper bound a number here could honestly stand in for. */
  minWidth: number;
  /** A ceiling for a selector that shares its row with something else, so it
   * cannot grow until it crowds the neighbour out. Unbounded without one. */
  maxWidth?: number;
  data: LabelledOption[];
  value: string | null;
  placeholder: string;
  /** No visible label: the placeholder already names the dimension (see
   * PinBar), so this is what a screen reader is told instead. */
  ariaLabel: string;
  onChange: (value: string | null) => void;
};

/** One pin selector, wearing the Analysis view's own design and its art.
 *
 * A component rather than three configured `Select`s: the styling and the icon
 * resolution are the same two answers every time, and three copies of them is
 * three chances for one selector to drift from the others. */
export const PinSelect = ({ minWidth, maxWidth, data, value, placeholder, ariaLabel, onChange }: PinSelectProps) => {
  const { t } = useTranslation();
  // Art and colour by value, because the two places that need them are given
  // different things: `renderOption` gets a Mantine `ComboboxItem` (which drops
  // any field Mantine does not know about, `iconUrl` and `color` included), and
  // the input's own section gets nothing but the current value.
  const byValue = useMemo(() => new Map(data.map((option) => [option.value, option])), [data]);
  const selected = value === null ? undefined : byValue.get(value);
  const selectedIcon = selected?.iconUrl;

  return (
    <Select
      // Grows to share the row rather than sitting at a fixed width. A fixed
      // one made the input SCROLL every name longer than it — the pin was
      // there, but you could not read it without dragging the caret through it,
      // and every dimension here is named by strings we do not control (a
      // player's own label template, an enemy with a spawn number, a status
      // named through its cause).
      style={{ flex: `1 1 ${minWidth}px`, minWidth, ...(maxWidth === undefined ? {} : { maxWidth }) }}
      size="xs"
      data={data}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      clearable
      searchable
      // A searchable Select is a text input, and the browser spell-checks it:
      // every player name, boss name and ability in these lists is a proper
      // noun the dictionary has never seen, so the pinned value sat under a red
      // squiggle as if it were a typo. Nothing typed here is prose — it is a
      // filter over names we already know — so all three of the text
      // assistances are off, not just the underline.
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      // Wrapped rather than passed straight through: Mantine calls its
      // `onChange` with `(value, option)`, and a caller whose handler happens to
      // take a second parameter would silently receive a Mantine internal.
      onChange={(next) => onChange(next)}
      // Mantine ships the clear ✕ with no accessible name at all, so three of
      // them on one screen announce as three identical buttons. Named off the
      // dimension the control already carries — one string, not a third prop
      // every call site has to remember.
      clearButtonProps={{ "aria-label": t("ui.logs.selector-clear", { dimension: ariaLabel }) }}
      classNames={{
        input: INPUT_CLASS,
        // The chevron and the clear ✕. Mantine sizes the section from the font,
        // and the stock colour is a step brighter than anything else in the row.
        section: "text-ink-3",
      }}
      // The dropdown portals to document.body, outside `.analysis`. It needs no
      // token class of its own for that: the theme puts every token on :root,
      // and custom properties inherit down from there to a portal as readily as
      // to anything else.
      comboboxProps={{
        classNames: { dropdown: "rounded-sm border border-line-strong bg-panel", option: OPTION_CLASS },
      }}
      // Only where the selected option HAS art: an empty left section still
      // reserves its width, which would indent the placeholder of every
      // selector whose list happens to be artless.
      leftSection={selectedIcon === undefined ? undefined : <EntityIcon size="control" src={selectedIcon} alt="" />}
      // Mantine's default section is 36px, which around an 18px icon reads as a
      // gap rather than as art attached to a name. Left undefined without one so
      // no padding is reserved at all.
      leftSectionWidth={selectedIcon === undefined ? undefined : 26}
      // The pinned actor's own colour in the control itself, so the bar reads
      // as "this player" rather than as a text field that happens to hold a
      // name. Only the TEXT — the border and the chevron stay neutral, or the
      // control would compete with the plot below it.
      styles={selected?.color === undefined ? undefined : { input: { color: selected.color } }}
      renderOption={({ option }) => {
        const entry = byValue.get(option.value);
        return (
          // The name takes the slack and ellipsises — a long boss name must not
          // widen the dropdown past its input.
          <div data-option-row className="flex min-w-0 items-center gap-[7px]">
            {entry?.iconUrl !== undefined && <EntityIcon size="control" src={entry.iconUrl} alt="" />}
            {/* `title` because the dropdown is only as wide as its control: a
                name past that ellipsises, and hovering is then the only way
                left to read the rest of it. */}
            <span
              className="truncate"
              title={option.label}
              style={entry?.color === undefined ? undefined : { color: entry.color }}
            >
              {option.label}
            </span>
          </div>
        );
      }}
    />
  );
};
