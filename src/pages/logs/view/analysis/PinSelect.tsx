import { Select } from "@mantine/core";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import "./analysis.css";

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
 * A component rather than three configured `Select`s: the styling, the icon
 * resolution and the dropdown's token class are the same three answers every
 * time, and three copies of them is three chances for one selector to drift
 * from the others.
 *
 * The dropdown carries `analysis-tokens` because it PORTALS to document.body,
 * outside `.analysis` — the `--an-*` custom properties inherit down the tree,
 * so a dropdown styled with them and rendered outside the view resolves them to
 * nothing and paints itself blank. The same reason the hover card carries it. */
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
      classNames={{ input: "analysis-select-input", section: "analysis-select-section" }}
      comboboxProps={{
        classNames: { dropdown: "analysis-tokens analysis-select-dropdown", option: "analysis-select-option" },
      }}
      // Only where the selected option HAS art: an empty left section still
      // reserves its width, which would indent the placeholder of every
      // selector whose list happens to be artless.
      leftSection={
        selectedIcon === undefined ? undefined : <img className="analysis-select-icon" src={selectedIcon} alt="" />
      }
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
          <div className="analysis-select-option-row">
            {entry?.iconUrl !== undefined && <img className="analysis-select-icon" src={entry.iconUrl} alt="" />}
            {/* `title` because the dropdown is only as wide as its control: a
                name past that ellipsises, and hovering is then the only way
                left to read the rest of it. */}
            <span
              className="analysis-select-option-label"
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
