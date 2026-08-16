import { CloseButton, Combobox, Pill, PillsInput, Select, useCombobox } from "@mantine/core";
import { ArrowDown, ArrowUp } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { characterIconUrl } from "@/characterIcon";
import { EntityIcon } from "@/components/ui/EntityIcon";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import type { CharacterType, LogSortType, LogSummary } from "@/types";
import {
  epochToLocalTime,
  hasQuestElapsedTime,
  millisecondsToElapsedFormat,
  translateCharacterType,
  translateQuestId,
} from "@/utils";

import { CHIP_BUTTON_SELECTED_CLASS, CHIP_SELECTED_CLASS } from "./chipAnatomy";
import {
  EMPTY_FACETS,
  EMPTY_GROUPS,
  NO_QUEST,
  capPickerGroups,
  formatRunSpan,
  logPickerGroups,
  pickerFacets,
  type LogPickerGroup,
  type PickerFilters,
  type PickerSort,
} from "./logPickerOptions";

export type LogPickerProps = {
  logs: LogSummary[];
  /** The log this picker currently shows, or null while a new pane is empty. */
  value: number | null;
  onChange: (id: number) => void;
};

/** The party art, at a size of its own rather than one of `EntityIcon`'s: the
 * row is two lines tall, and 32px is what stands level with them — the scales
 * the component ships are sized for a ONE-line row, the largest of them (22px)
 * included.
 *
 * It used to draw at `size-icon-xs` (15px), which on a character bust — tall,
 * and letterboxed into a square by `object-contain` — left a sliver too small
 * to recognise anyone by. Recognising the party at a glance is the whole reason
 * the row leads with art instead of names. */
const ICON_SIZE = "size-[calc(32px*var(--density))]";
/** The party block is exactly FOUR slots wide whatever the party holds: a trio
 * leaves its fourth slot empty rather than pulling the quest name left, which
 * would step the names in and out down the dropdown. Four busts and their three
 * gaps, scaling with `--density` like every other size in the view. */
const PARTY_W = "w-[calc(134px*var(--density))]";
/** The control grows into the header rather than sitting at one width — the
 * header beside it now carries only the total (see `QuestSummary`), and the
 * quest names this has to fit are long — but it stops at a width a name can
 * still be read across. Past that the row is mostly empty space with an id
 * stranded at the far edge.
 *
 * Growing between a floor and a ceiling still gives what a fixed width was for,
 * since the width follows the PANE and not the log being shown: it does not
 * resize when a library entry lands and the stand-in becomes a real row.
 *
 * Mantine sizes the dropdown from the target, so the option list follows. */
const CONTROL_W = "min-w-[calc(320px*var(--density))] max-w-[calc(600px*var(--density))] flex-1";

/** Roughly how tall the dropdown stands — the option list's own ceiling (360)
 * plus the filter bar above it. Only ever compared against the room below the
 * control to pick a SIDE, so approximate is all it has to be: a panel that
 * would be cramped either way still opens on the roomier one. */
const DROPDOWN_H = 480;

/** The control and the dropdown in the Analysis view's own palette rather than
 * Mantine's stock dark input — the same tokens `PinSelect` reads.
 *
 * Taller than a `h-control` row: this is the pane's TITLE, the thing that says
 * which log everything below it is about, so it carries the weight the quest
 * name used to (see `QuestSummary`) rather than reading as one more filter. */
const TARGET_CLASS = [
  // `cursor-pointer` explicitly: Tailwind's preflight no longer sets it on
  // `button`, so a bare one keeps the arrow and reads as a label rather than a
  // control. Every hand-built button in this view states it (see
  // `CHIP_BUTTON_CLASS`, `AuraStrip`, `ToggleSwitch`) — this one did not, which
  // is exactly how it came to look unclickable.
  "flex min-w-0 items-center gap-2 px-2.5 py-1 rounded-sm cursor-pointer",
  "border border-line bg-panel text-ink text-left",
  "hover:border-line-strong focus:border-accent",
].join(" ");

/** A filter dropdown, in the same palette the pin selectors wear. */
const FILTER_INPUT_CLASS = [
  "min-h-control rounded-sm border border-line bg-raised text-md text-ink",
  "text-ellipsis placeholder:text-ink-3 hover:border-line-strong",
  "focus:border-accent focus-within:border-accent",
].join(" ");

const FILTER_OPTION_CLASS = [
  "rounded-xs text-md text-ink-2",
  "hover:bg-panel hover:text-ink",
  "data-[combobox-active]:bg-panel data-[combobox-active]:text-ink",
  "data-[combobox-selected]:bg-panel data-[combobox-selected]:text-ink",
].join(" ");

/** One labelled clock on the row's second line. Both cells take it, so the
 * in-game time starts at the same x down the whole list whatever the duration
 * beside it reads — the pair are meant to be compared between runs, and a
 * column that moves is one you have to find again on every row.
 *
 * A FLOOR rather than a fixed width, sized to `Duration MM:SS`: fixed at the
 * worst case (`HH:MM:SS`, and the longest label a locale might give) it stood
 * a good 30px wider than anything it holds, and that slack read as a gap
 * between the two clocks. Set here, the hour-long run that overruns it pushes
 * only its own row's IGT across, rather than every row paying for it. */
const CLOCK_W = "min-w-[calc(96px*var(--density))]";

/** The two clocks the picker reads a run by. The kind IS its translation key —
 * the same two the quest list heads its columns with, so neither page can come
 * to call them something the other does not. */
type ClockKind = "duration" | "quest-elapsed-time";

/** One labelled clock: `Duration: 06:16`.
 *
 * One component for the run rows and the chain header both, so a figure and the
 * record it is being compared against are drawn by one author.
 *
 * `column` is what makes the RUN rows line up: their clocks hold `CLOCK_W`
 * whatever they read, so the in-game time starts at the same x down the list.
 * The header's do not — a chain's clocks follow the word "Best" and so cannot
 * sit in the rows' columns anyway, and held to a column width the shorter of
 * them trailed 30px of empty cell before the rule beside it.
 *
 * `best` tints the FIGURE, never the label: the accent means "this is the
 * record", and a label wearing it would say that about the word. The tint is
 * the quest list's `logs-chain-best` — the analysis accent rather than a green,
 * since green in this app means "cleared" and a green record time reads as an
 * outcome. */
const Clock = ({
  kind,
  value,
  best = false,
  column = true,
}: {
  kind: ClockKind;
  value: string;
  best?: boolean;
  column?: boolean;
}) => {
  const { t } = useTranslation();
  // Label and colon assembled in a string: punctuation is notation, and one
  // needs no key and no lint exemption to say so.
  const label = `${t(`ui.logs.${kind}`)}:`;

  return (
    <span className={`${column ? CLOCK_W : ""} shrink-0 whitespace-nowrap tabular-nums`}>
      <span className="text-ink">{label}</span>{" "}
      <span className={best ? "font-bold text-accent" : "text-ink-3"} {...(best ? { "data-best": kind } : {})}>
        {value}
      </span>
    </span>
  );
};

/** What a repeat chain came to, on the same column grid as the runs beneath it:
 * the best of each clock, and the stretch of wall-clock the chain was run over.
 *
 * No run COUNT — the rows under the header are the count, and a header that
 * spent its width restating them had nothing left for the figures that are
 * about the SET. Marked "best" once rather than on each clock: two labels
 * saying the same word is the wider way to say it.
 *
 * Its clocks size to their CONTENT rather than to the rows' columns (see
 * `Clock`'s `column`): they follow the word "Best" and so cannot line up with
 * the rows anyway, and a column width left the shorter of them trailing empty
 * cell before the rule beside it. */
const ChainHeader = ({ group }: { group: LogPickerGroup }) => {
  const { t } = useTranslation();
  const igt = group.bestQuestElapsedMs === null ? "—" : millisecondsToElapsedFormat(group.bestQuestElapsedMs);
  const span = formatRunSpan(group.firstTime, group.lastTime);

  return (
    <div data-testid="picker-chain-header" className="flex w-full min-w-0 items-baseline gap-2 text-sm">
      <span className="shrink-0 font-semibold" style={{ color: group.color }}>
        {t("ui.logs.picker-chain-best")}
      </span>
      {/* Tinted, both of them: every figure on this line IS the record it is
          marking on the row below. */}
      <Clock kind="duration" value={millisecondsToElapsedFormat(group.bestDurationMs)} best column={false} />
      <Clock kind="quest-elapsed-time" value={igt} best={group.bestQuestElapsedMs !== null} column={false} />
      {/* The rule Mantine draws beside a group caption, drawn here instead: its
          own is an `::after` on the label that takes `flex: 1`, which is what
          left nothing for the span to be pushed against (see `groupLabel`).
          Ours sits between the figures and the date, where it ties the two ends
          of the header together and takes the slack the row has spare.
          `self-center` because the row aligns on the BASELINE, which a 1px rule
          has none of. */}
      <span className="h-px flex-1 self-center bg-line" aria-hidden />
      <span className="min-w-0 shrink-0 truncate text-right text-ink-3" title={span}>
        {span}
      </span>
    </div>
  );
};

/** One group of the option list — a repeat chain, or a lone run. The gutter is
 * declared ONCE and worn by both, since a rule only one of them carries is what
 * puts the two kinds of row on different left edges.
 *
 * The left colour is set inline per group and so must be set as
 * `borderLeftColor`: `borderColor` writes all four sides, which would hand the
 * chain's own colour (or `transparent`) to the rule below it as well. */
const GROUP_CLASS = "rounded-xs border-l-2 pl-1";

/** What a CHAIN adds: room to breathe, and a rule underneath saying where the
 * block ends. The tint a chain wears is faint by design, and on its own it left
 * the run after the chain reading as one more of its runs.
 *
 * Only chains — a lone run is a group of one in the data, so an unconditional
 * rule would draw a line between every row in the list. Not on the last group
 * either: a rule under the final row closes nothing off, it underlines the
 * list. */
const CHAIN_CLASS = "my-0.5 border-b border-line pb-0.5 last:border-b-0";

/** One run in the list. The rules are worn TRANSPARENT here and coloured on the
 * selected run below, so marking a selection cannot change a row's height.
 *
 * Hover lives on this class rather than on the shared `option` one because the
 * selected run has a background of its own: declared in both places they are
 * two background utilities of equal specificity, and which of them wins would
 * be Tailwind's ordering rather than ours. */
const OPTION_CLASS = "border-y border-transparent hover:bg-raised hover:text-ink";

/** The run the pane is already reading. Three things say so, none of them a
 * highlight hover could be mistaken for:
 *
 * - the accent TINT the whole view marks a selected chip with (`chipAnatomy`),
 *   against hover's plain grey;
 * - rules above and below, which bracket the row out of the column;
 * - full-strength ink.
 *
 * No left bar: the option sits inside the group's own 2px gutter, so a second
 * rule down its left edge started the row's fill a few pixels in from every
 * other row's and read as an indent. */
const OPTION_SELECTED_CLASS = "border-y border-accent bg-accent-soft text-ink";

/** Rendered inside the picker's own dropdown rather than portalled to the body:
 * a filter's overlay opening OUTSIDE the dropdown it belongs to counts as a
 * click outside, and closes the picker the moment a filter is used. */
const FILTER_COMBOBOX_PROPS = {
  withinPortal: false,
  classNames: { dropdown: "rounded-sm border border-line-strong bg-panel", option: FILTER_OPTION_CLASS },
};

/** The four party slots, always four wide. A slot with no character — a trio, or
 * a character the atlas has no art for — draws its empty box, which is what
 * holds the sections after it in place.
 *
 * Icons rather than names: a party is recognised by its characters far faster
 * than it is read. */
const PartyIcons = ({ log }: { log: LogSummary }) => (
  <span className={`flex shrink-0 items-center gap-[2px] ${PARTY_W}`}>
    {[log.p1Type, log.p2Type, log.p3Type, log.p4Type].map((type, slot) => {
      const url = type ? characterIconUrl(type) : undefined;
      return url === undefined ? (
        <span key={slot} className={`${ICON_SIZE} shrink-0`} aria-hidden />
      ) : (
        // `className` over the size prop: `cn` is tailwind-merge, so the
        // arbitrary size wins over the scale `EntityIcon` would otherwise draw.
        <EntityIcon key={slot} src={url} alt="" className={ICON_SIZE} />
      );
    })}
  </span>
);

/** Which of a run's clocks are its chain's record. Absent for a run standing on
 * its own and for the closed control: a lone run is nobody's best, and there is
 * nothing on screen for it to be the best OF. */
type RunBests = { duration: boolean; questElapsed: boolean };

/** One log, as the closed control and as an option read it, on two lines: who
 * and what above, when and how long below.
 *
 * Two rather than one because the three fixed columns this used to be could not
 * hold a quest name, a date and two clocks between them — every one of them
 * ellipsised, and hovering for a `title` was the only way left to read a row.
 * Splitting them gives the quest name the whole width and puts the notation on
 * a line of its own, where nothing competes with it. */
const LogRow = ({ log, bests }: { log: LogSummary; bests?: RunBests }) => {
  const quest = log.questId === null ? "" : translateQuestId(log.questId);
  const duration = millisecondsToElapsedFormat(log.duration);
  // A dash where the quest timer never reported one — logs recorded before it
  // was read from the right offset stored a 1s placeholder, which would
  // otherwise read as the fastest clear in the library. A dash rather than an
  // empty cell, so the column holds its place and the label does not stand
  // alone looking like a value that failed to render. Built in a string, which
  // is where a bare glyph belongs: no key, no lint exemption.
  const igt = hasQuestElapsedTime(log.questElapsedTime)
    ? millisecondsToElapsedFormat(log.questElapsedTime * 1000)
    : "—";
  const stamp = epochToLocalTime(log.time);

  return (
    <span className="flex min-w-0 flex-1 items-center gap-2.5">
      <PartyIcons log={log} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          {/* `title` on the two that can outgrow their box — a quest name, and
              a locale date format wider than the column — since hovering is
              then the only way left to read the rest. */}
          <span className="truncate text-lg font-semibold" title={quest}>
            {quest}
          </span>
          {/* eslint-disable-next-line i18next/no-literal-string -- "#" plus a database id is notation */}
          <span className="ml-auto shrink-0 text-sm text-ink-3">#{log.id}</span>
        </span>
        <span className="flex min-w-0 items-baseline gap-2 text-sm text-ink-3">
          {/* The two clocks as CELLS: side by side and unlabelled, neither said
              which of the two it was, and set to their own widths they stepped
              in and out down the list. Tinted where this run holds its chain's
              record, which is what makes a block worth opening. */}
          <Clock kind="duration" value={duration} best={bests?.duration ?? false} />
          <Clock kind="quest-elapsed-time" value={igt} best={bests?.questElapsed ?? false} />
          {/* Under the id, at the row's right edge: the two notations that say
              WHICH run this is, rather than what it came to, read as a column
              of their own. */}
          <span className="ml-auto min-w-0 truncate text-right" title={stamp}>
            {stamp}
          </span>
        </span>
      </span>
    </span>
  );
};

/** How many entries a party filter takes. Not a rendering budget — a run has
 * four slots, so a fifth character or player could only ever match nothing, and
 * a filter that offers a fifth is offering an empty list. */
const PARTY_MAX = 4;

/** One entry a party filter can be narrowed to. `icon` is what tells the two
 * apart: a character has art, a player is a name the game gave us. */
type PartyOption = { value: string; label: string; icon?: string };

/** A picked entry, in the palette the rest of the bar wears. Square rather than
 * Mantine's stock pill radius, which is a full round — nothing else in this
 * view is. */
const PILL_CLASS = "rounded-xs border border-line bg-panel text-sm text-ink";

/** One party slot: a bust, and the box it is clicked out of. No frame around it
 * — the art is the thing, and four framed boxes in a row read as a toolbar
 * rather than as a party. Nothing is drawn for a slot nobody has filled either;
 * the control's width is fixed (`FILTER_ART_W`), so its geometry does not need
 * placeholders holding it open.
 *
 * The size follows from what we know: the art is one size and there are never
 * more than four of them, and 24px around a 22px bust keeps the input at
 * `min-h-control`, level with the player filter beside it. */
const SLOT_CLASS = "flex size-[calc(24px*var(--density))] shrink-0 cursor-pointer items-center justify-center";
/** What says the bust comes back out when clicked, now that no border can. */
const SLOT_HOVER_CLASS = "rounded-xs hover:bg-accent-soft hover:opacity-75";

/** The slots sit in a box built for a line of text, so it takes its height from
 * them instead. */
const PILLS_INPUT_CLASS = "h-auto py-[1px]";

/** How the two party filters split their row. The art filter is as wide as what
 * it holds and no wider — four 24px slots and their gaps, the input's own
 * padding, and a box long enough to type a name into. FIXED, because its
 * contents cannot grow: it can never hold a fifth slot, so a share of the row
 * is width it would only ever leave empty, taken from the filter beside it that
 * has variable-width names to fit. */
const FILTER_ART_W = "w-[calc(160px*var(--density))] shrink-0";
const FILTER_NAME_W = "min-w-0 flex-1";

/** One party filter: which characters, or which players, a run had.
 *
 * This was a Mantine `MultiSelect`, and it is built out of exactly what that is
 * built out of — `Combobox` + `PillsInput` + `Pill`. What `MultiSelect` does not
 * give is a say in what a PILL draws: its pill content is
 * `optionsLockup[item].label`, a plain string, with no render hook and no
 * attribute carrying the value, so a party shown as busts cannot be reached
 * through it (checked against 7.6.1). The cap is ours for the same reason it is
 * simpler here than `maxValues` would be: what happens at four is a message,
 * not a silently ignored click. */
const PartyFilter = ({
  options,
  value,
  onChange,
  placeholder,
  art = false,
}: {
  options: PartyOption[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder: string;
  /** Draw picked entries as their art. Characters have busts and are recognised
   * by them far faster than they are read; players have only a name. */
  art?: boolean;
}) => {
  const { t } = useTranslation();
  const searchRef = useRef<HTMLInputElement>(null);
  const combobox = useCombobox({
    // The art filter types into the DROPDOWN, so opening has to put the cursor
    // there — there is no box in the control to land in. On a timeout because
    // the dropdown is not on screen yet at this point, and by hand rather than
    // through `combobox.focusSearchInput()`, which focuses on the same timeout
    // with no null guard: this whole bar is unmounted the moment a log is
    // picked (`keepMounted={false}` on the picker), and the ref is gone before
    // the timer fires.
    onDropdownOpen: () => {
      if (art) window.setTimeout(() => searchRef.current?.focus(), 0);
    },
    onDropdownClose: () => {
      combobox.resetSelectedOption();
      setSearch("");
    },
  });
  const [search, setSearch] = useState("");

  const lookup = useMemo(() => new Map(options.map((option) => [option.value, option])), [options]);
  const full = value.length >= PARTY_MAX;
  // Picked entries leave the list rather than sitting in it ticked: with four
  // slots, what is left to pick is the whole of what the list is for.
  const query = search.trim().toLowerCase();
  const offered = options.filter(
    (option) => !value.includes(option.value) && option.label.toLowerCase().includes(query)
  );

  return (
    <Combobox
      store={combobox}
      // Rendered inside the picker's own dropdown, like every other control in
      // this bar: an overlay opening outside it counts as a click outside and
      // closes the picker (see `FILTER_COMBOBOX_PROPS`).
      withinPortal={false}
      // What `MultiSelect` was passing down for us. Without it the option rows
      // stand at Mantine's `sm` padding, which is half again the height of
      // every other option in this dropdown.
      size="xs"
      classNames={FILTER_COMBOBOX_PROPS.classNames}
      onOptionSubmit={(picked) => {
        const next = [...value, picked];
        onChange(next);
        setSearch("");
        // The list has nothing left to offer at four, so it goes rather than
        // standing open saying so.
        if (next.length >= PARTY_MAX) combobox.closeDropdown();
      }}
    >
      <Combobox.DropdownTarget>
        <PillsInput
          size="xs"
          className={art ? FILTER_ART_W : FILTER_NAME_W}
          classNames={{ input: `${FILTER_INPUT_CLASS} ${PILLS_INPUT_CLASS}`, section: "text-ink-3" }}
          // Nothing to drop at four: the list would open with every entry it
          // cannot add. Removing a pill puts it back within reach.
          onClick={() => !full && combobox.openDropdown()}
          // The art filter ends in a chevron, saying the four slots open
          // something — it has no ✕ because every slot is its own remove
          // button, and no text box to clear. The name filter is the other way
          // round: pills are removed one ✕ at a time, so it keeps the one that
          // empties the lot.
          rightSection={
            art ? (
              <Combobox.Chevron size="xs" />
            ) : value.length > 0 ? (
              <CloseButton
                size="xs"
                variant="transparent"
                aria-label={t("ui.logs.picker-party-clear")}
                // Without this the button takes focus on press, which is a blur
                // of the field — and a blur is what commits the bar (see the
                // filter bar below). Clearing would then apply itself.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onChange([])}
              />
            ) : undefined
          }
          rightSectionPointerEvents={!art && value.length > 0 ? "all" : "none"}
        >
          {/* The art filter never wraps: its four slots and the box you search
              in are one row by construction, and a field that dropped under
              them at a narrow width would put the control back to changing
              height. The name filter wraps as pills always have — a name is as
              wide as it is, and four of them do not fit on one line. */}
          <Pill.Group size="xs" className={art ? "flex-nowrap" : undefined}>
            {/* With nothing picked there is no art to show, so the control says
                what it filters — the placeholder its own field can no longer
                carry now that the field is hidden. Four busts is the most this
                ever holds, and the control is fixed at the width of them, so it
                cannot be pushed about by what it is given. */}
            {art && value.length === 0 && <span className="truncate text-md text-ink-3">{placeholder}</span>}
            {art &&
              value.map((entry) => {
                const option = lookup.get(entry);
                const name = option?.label ?? entry;
                return (
                  <button
                    key={entry}
                    type="button"
                    data-party-entry
                    title={name}
                    aria-label={t("ui.logs.picker-party-remove", { name })}
                    className={`${SLOT_CLASS} ${SLOT_HOVER_CLASS}`}
                    // Focus must not leave the field: leaving the bar is what
                    // commits it, and mousedown lands BEFORE the click that
                    // does the removing — the filter would apply itself one
                    // character out of date.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      // The input opens the list on click; a slot is a control
                      // of its own and answers for itself.
                      event.stopPropagation();
                      onChange(value.filter((held) => held !== entry));
                    }}
                  >
                    {option?.icon === undefined ? (
                      <span className="truncate px-1 text-sm">{name}</span>
                    ) : (
                      // Decorative: the button beside it is already named for
                      // the character it holds.
                      <EntityIcon src={option.icon} alt="" />
                    )}
                  </button>
                );
              })}
            {!art &&
              value.map((entry) => {
                const name = lookup.get(entry)?.label ?? entry;
                return (
                  <Pill
                    key={entry}
                    data-party-entry
                    withRemoveButton
                    radius="sm"
                    title={name}
                    classNames={{ root: PILL_CLASS }}
                    // Same reason the slots cancel theirs: mousedown is a blur,
                    // and a blur commits the bar.
                    removeButtonProps={{ onMouseDown: (event) => event.preventDefault() }}
                    onRemove={() => onChange(value.filter((held) => held !== entry))}
                  >
                    {name}
                  </Pill>
                );
              })}
            <Combobox.EventsTarget>
              <PillsInput.Field
                // HIDDEN on the art filter — Mantine's own spelling of "this
                // control is not a text box" (it is what `MultiSelect` does
                // when it is not searchable), and it keeps the focus and the
                // keyboard the control is reached by.
                //
                // Four slots hold the left of that control, so an inline box
                // had nowhere to sit: its own `min-width: 6.25rem` overflowed
                // what was left, and the placeholder stood stranded past the
                // empty slots rather than at the edge a label is read from.
                // Typing moved into the dropdown instead (`Combobox.Search`),
                // which is where the list being searched actually is.
                type={art ? "hidden" : "visible"}
                value={search}
                // The placeholder goes once there are pills: it would sit after
                // them as a second, contradictory reading of the same control.
                placeholder={art || value.length > 0 ? undefined : placeholder}
                aria-label={placeholder}
                // Every quest, boss and character name in these lists is a
                // proper noun no dictionary carries.
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                onFocus={() => !full && combobox.openDropdown()}
                // Only the name filter closes on its field's blur. The art
                // filter is typed into in the DROPDOWN, so opening it moves
                // focus off this field by design — closing on that blur shut
                // the list in the same tick it opened, over and over. It closes
                // on a click outside instead, which is Mantine's own default.
                onBlur={() => !art && combobox.closeDropdown()}
                onChange={(event) => {
                  if (!full) combobox.openDropdown();
                  setSearch(event.currentTarget.value);
                }}
                // Backspace on an empty box takes the last pill back off, which
                // is what every pill input does and what a hand reaching for it
                // expects.
                onKeyDown={(event) => {
                  if (event.key === "Backspace" && search.length === 0 && value.length > 0) {
                    event.preventDefault();
                    onChange(value.slice(0, -1));
                  }
                }}
              />
            </Combobox.EventsTarget>
          </Pill.Group>
        </PillsInput>
      </Combobox.DropdownTarget>

      <Combobox.Dropdown>
        {/* Where the art filter is typed into. In the dropdown rather than in
            the control, because the control is four slots wide and a search box
            belongs at the head of the list it searches. */}
        {art && (
          <Combobox.Search
            // What `onDropdownOpen` reaches for. Without it that focus call
            // resolves `null` and silently does nothing, leaving the art filter
            // — whose own field is `type="hidden"` — open with nothing focused.
            ref={searchRef}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            // Named by its placeholder alone: the control this belongs to is
            // already labelled (the hidden field above), and a second element
            // answering to the same name is one the reader has to tell apart.
            placeholder={placeholder}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            classNames={{ input: FILTER_INPUT_CLASS }}
          />
        )}
        {/* A ceiling and a scroller, which `MultiSelect` carried for us
            (`maxDropdownHeight`): a filter listing every player ever grouped
            with drew all of them, in one column taller than the window. */}
        <Combobox.Options mah={220} style={{ overflowY: "auto" }}>
          {offered.length === 0 && <Combobox.Empty>{t("ui.logs.picker-party-none")}</Combobox.Empty>}
          {offered.map((option) => (
            <Combobox.Option key={option.value} value={option.value}>
              <div className="flex min-w-0 items-center gap-1.5">
                {option.icon !== undefined && <EntityIcon src={option.icon} alt="" />}
                <span className="truncate">{option.label}</span>
              </div>
            </Combobox.Option>
          ))}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
};

/** The three columns the library can be read in, in the order the quest list
 * offers them. Same keys, so the two pages sort a log by the same rules. */
const SORT_KEYS: { key: LogSortType; labelKey: string }[] = [
  // The quest list's OWN column headers, not a second set: the picker sorts by
  // the same three columns that list is headed with, and a chip reading
  // "Duration" beside a clock labelled from `ui.logs.duration` must be the one
  // string, or a translator can make them disagree in the same dropdown.
  { key: "time", labelKey: "ui.logs.date" },
  { key: "duration", labelKey: "ui.logs.duration" },
  { key: "quest-elapsed-time", labelKey: "ui.logs.quest-elapsed-time" },
];

/** A sort key, built as a CHIP — the shape this view gives every small
 * self-toggling control, from the window strip to the events stream's kind
 * filters (`chipAnatomy`). The three keys were a button shape of their own,
 * which is the whole of why they read as foreign in a dropdown of token-built
 * controls.
 *
 * The chip's own surface is not reused, only its shape: `CHIP_CLASS` is
 * `bg-panel`, which is what a chip standing on the view's background wants and
 * which would be invisible here — this dropdown IS a panel. So it takes the
 * surface of the filters directly above it (`FILTER_INPUT_CLASS`) and the chip's
 * height, radius and type.
 *
 * Border, background and ink are all stated per state rather than defaulted
 * here and overridden there: two colour utilities of one property have equal
 * specificity, and which of them wins is Tailwind's ordering rather than ours. */
const SORT_CHIP_CLASS = "inline-flex h-chip cursor-pointer items-center gap-1.5 rounded-sm border px-2 text-sm";
const SORT_CHIP_IDLE_CLASS = "border-line bg-raised text-ink-2 hover:border-line-strong hover:text-ink";

/** Which column the list reads by, and which way.
 *
 * The quest list's own behaviour: picking the column already in use turns it
 * around, and picking another starts it ascending — fastest and oldest first,
 * which is what someone reaching for "duration" is usually after. */
const SortPicker = ({ sort, onChange }: { sort: PickerSort; onChange: (sort: PickerSort) => void }) => {
  const { t } = useTranslation();
  return (
    // Its own row under the filters, and pushed to the right edge: the three
    // keys are named Date, Duration and IGT, which is already what they are —
    // a "Sort" in front of them only spent the row's left end saying so, and
    // left the buttons floating in the middle of it.
    <div className="flex items-center justify-end gap-1.5">
      {SORT_KEYS.map(({ key, labelKey }) => {
        const active = sort.key === key;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            // Which one is sorting is said by the accent — the same two classes
            // every selected chip in this view wears — and NOT by dimming the
            // other two out of the way: a key you might sort by next is one
            // click from being the answer, and greyed out it reads as disabled.
            className={[
              SORT_CHIP_CLASS,
              active ? `${CHIP_SELECTED_CLASS} ${CHIP_BUTTON_SELECTED_CLASS}` : SORT_CHIP_IDLE_CLASS,
            ].join(" ")}
            onClick={() =>
              onChange(
                active ? { key, direction: sort.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" }
              )
            }
          >
            <span>{t(labelKey)}</span>
            {/* An ARROW rather than a caret: a caret at the trailing edge of a
                chip is what the window strip's chips wear, and there it means
                "this opens a menu" — on a chip that only turns itself around it
                promised a dropdown. An arrow says which way the column reads,
                which is the whole of what this glyph is for.

                (A bare ▲, the quest list's spelling of it, renders as whatever
                the text font has rather than as one of the icons the rest of
                the view is drawn with.)

                Drawn on all three and merely HIDDEN on the two that are not
                sorting: the glyph is part of what sizes a chip, so one that
                grows only when picked shoves the chips beside it along every
                time the column changes. */}
            {/* `inline-flex`, not a bare span: an `<svg>` in a text box sits on
                the BASELINE, so it rides up by the descender space under it —
                the chip centres its items, but what it was centring was a line
                box taller than the glyph. The window strip's chips are spared
                this only because their caret is a flex child of the chip
                itself; this one needs a wrapper to hold its space when idle. */}
            <span aria-hidden className={`inline-flex items-center ${active ? "" : "invisible"}`}>
              {active && sort.direction === "desc" ? (
                <ArrowDown size={11} weight="bold" />
              ) : (
                <ArrowUp size={11} weight="bold" />
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
};

/** The log this pane is reading, and every log it could read instead.
 *
 * A `Combobox` rather than a `Select` because an option is a party, a quest and
 * two times — not a string. Repeat chains are group HEADERS with their runs as
 * the options beneath: picking a run picks a log like any other, which is the
 * whole of the chain handling (see the spec). */
export const LogPicker = ({ logs, value, onChange }: LogPickerProps) => {
  const { t } = useTranslation();
  // Kept across opens rather than cleared with the dropdown: narrowing to a
  // quest is how a comparison is set up, and re-picking it every time the
  // dropdown closes is the work this bar exists to save. Out of the URL, which
  // carries how a log is READ — not how it was found.
  //
  // TWO of them: `draft` is what the controls hold, `filters` is what the list
  // has been narrowed by. A pick used to be both at once, and the list resizing
  // under every tick is what made picking four characters hard — this dropdown
  // opens UPWARD in the lower pane, so a list that shortens takes the filter
  // bar up with it, out from under the cursor that is still using it. The draft
  // is committed when focus leaves the bar (see the `onBlur` below).
  const [draft, setDraft] = useState<PickerFilters>({ questId: null, characters: [], players: [] });
  const [filters, setFilters] = useState<PickerFilters>({ questId: null, characters: [], players: [] });
  const [sort, setSort] = useState<PickerSort>({ key: "time", direction: "desc" });

  // Read by the close handler below, which `useCombobox` holds from the first
  // render and which would otherwise commit whatever the draft was back then.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const combobox = useCombobox({
    // Also on close, not only on blur: picking a log or clicking away can leave
    // an uncommitted draft, and the next open would then show controls that
    // disagree with the list under them.
    onDropdownClose: () => setFilters(draftRef.current),
  });
  // The combobox store's own flag, not a mirror of it in local state: two
  // sources of truth for "is this open" means the next handler that closes the
  // dropdown by another path has to remember to reset the copy.
  const opened = combobox.dropdownOpened;

  // Which side the dropdown opens on, decided ONCE per open. Mantine's `flip`
  // middleware re-runs while the dropdown is open, so a narrowing that shortened
  // the list far enough for it to fit below the control sent it back down there
  // mid-read. Whichever side it opens on it now stays on.
  const [position, setPosition] = useState<"top-start" | "bottom-start">("bottom-start");

  // THIS picker's option list, for the open-scroll below.
  const optionsRef = useRef<HTMLDivElement>(null);

  // Names are what streamer mode exists to withhold; a dropdown listing every
  // person who has ever been in the party is exactly that.
  const streamerMode = useMeterSettingsStore((state) => state.streamer_mode);

  // What the filters can be narrowed to, off the WHOLE library rather than the
  // current narrowing — a list that shrank to what the other filters left would
  // take away the option just picked (see `pickerFacets`).
  //
  // Gated on `opened`, the same trade `keepMounted={false}` below makes for the
  // DOM: nothing here is rendered until the dropdown is open, and this is a
  // full-library pass allocating a Set per log, per pane, on the view's first
  // paint whether or not anyone opens the picker.
  const facets = useMemo(() => (opened ? pickerFacets(logs) : EMPTY_FACETS), [opened, logs]);
  // In the order the facets hand them over — most-run first (see
  // `pickerFacets`) — rather than alphabetically. A library of thousands is a
  // handful of quests run over and over and a tail run once, and sorted by name
  // the one you want sits wherever its initial falls.
  const questOptions = useMemo(
    () =>
      facets.questIds.map((id) => ({
        value: String(id),
        label: id === NO_QUEST ? t("ui.logs.picker-no-quest") : translateQuestId(id),
      })),
    [facets.questIds, t]
  );
  const characterOptions = useMemo(
    () =>
      facets.characters
        .map((type) => ({
          value: type,
          label: translateCharacterType(type as CharacterType),
          icon: characterIconUrl(type),
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [facets.characters]
  );
  // A player is their own label: the game gives us the name and nothing else,
  // which is exactly why these pills stay words while the characters' become
  // busts.
  const playerOptions = useMemo(() => facets.players.map((name) => ({ value: name, label: name })), [facets.players]);

  // The whole matching library, then the slice of it the dropdown draws. Two
  // steps rather than one: the count behind the cap is what the footer states,
  // and a narrowing that leaves nothing has to reach `Combobox.Empty` rather
  // than "0 more".
  //
  // Two MEMOS as well, because only the cap reads `value` — folded together,
  // picking a log re-filtered, re-chained and re-sorted the entire library to
  // change which group gets rescued past the cap. Gated on `opened` for the
  // same reason as `facets`.
  const matching = useMemo(
    () => (opened ? logPickerGroups(logs, filters, sort) : EMPTY_GROUPS),
    [opened, logs, filters, sort]
  );
  const { groups, hiddenRuns } = useMemo(() => capPickerGroups(matching, value), [matching, value]);
  const selected = useMemo(() => logs.find((log) => log.id === value) ?? null, [logs, value]);

  // Open on the log the pane is already reading. Without this the list opens at
  // the top, which in a library of thousands is nowhere near wherever the
  // reader actually is — and the option marked as theirs is off screen.
  // On OPEN only, deliberately: re-running it as the list changes would yank
  // the scroll back to the selected run on every keystroke in a filter, which
  // is the one moment somebody is looking somewhere else on purpose.
  //
  // The LIST is scrolled, by hand. `scrollIntoView` was what this called, and
  // it scrolls every scrollable ancestor of the element, not just the nearest
  // one: with the page behind the dropdown scrolled to the top, opening the
  // picker scrolled the whole view down to bring the option into range.
  //
  // Through a REF, not `document.querySelector`: there is one picker per pane
  // now, and a document-wide lookup returns whichever list is first in the DOM
  // — so with two mounted it measures and scrolls the other pane's list and
  // leaves this one where it opened, in a library of thousands where this
  // scroll is the only way to find the log you are on.
  useEffect(() => {
    if (!opened) return;
    const list = optionsRef.current;
    const option = list?.querySelector<HTMLElement>('[data-selected-log="true"]');
    if (!list || !option) return;
    const offset = option.getBoundingClientRect().top - list.getBoundingClientRect().top;
    list.scrollTop += offset - (list.clientHeight - option.clientHeight) / 2;
  }, [opened]);

  return (
    <Combobox
      store={combobox}
      // Mantine's default is `keepMounted: true` — the dropdown stays in the DOM
      // and is merely hidden. That is the right trade for a list of a dozen
      // options and the wrong one for the log library: every log ever recorded
      // sat mounted behind a closed control, on every pane, whether or not the
      // picker was ever opened. Measured at 1,881 logs: 17,708 nodes and 7,528
      // `<img>`s per picker, and React reconciling all of them on every render
      // of the view around it.
      keepMounted={false}
      position={position}
      // `flip` off, because the side is chosen on open (see `position`) and a
      // dropdown that moves to the other side of its control while being read
      // is the confusing part, not which side it started on. `shift` stays: it
      // slides the panel along the edge to keep it on screen, which never moves
      // it past the control.
      middlewares={{ flip: false, shift: true }}
      onOptionSubmit={(id) => {
        onChange(Number(id));
        combobox.closeDropdown();
      }}
      classNames={{
        dropdown: "rounded-sm border border-line-strong bg-panel",
        // Only what every row wears: hover and the selected marking are on the
        // option itself (see `OPTION_CLASS`).
        option: "rounded-xs text-md text-ink-2",
        group: "text-sm text-ink-3",
        // Mantine's group label is a FLEX row ending in an `::after` rule that
        // takes `flex: 1` — the divider it draws beside a one-word caption. Our
        // header is a row of its own, so as a flex ITEM it sized to its content
        // and the leftover width went to that rule: the span sat against the
        // clocks with `ml-auto` having nothing to push it away from. Block, and
        // no rule, so the header owns the full width. Mantine's own padding
        // stays, which is what keeps its right edge over the options' below.
        groupLabel: "block after:hidden",
      }}
    >
      <Combobox.Target>
        <button
          type="button"
          className={`${TARGET_CLASS} ${CONTROL_W}`}
          aria-label={t("ui.logs.picker-label")}
          // The control measures its own room rather than a ref measuring it
          // for it: the side is only ever decided here, at the click that
          // opens the dropdown.
          onClick={(event) => {
            if (combobox.dropdownOpened) {
              combobox.closeDropdown();
              return;
            }
            const rect = event.currentTarget.getBoundingClientRect();
            const below = window.innerHeight - rect.bottom;
            setPosition(below < DROPDOWN_H && rect.top > below ? "top-start" : "bottom-start");
            combobox.openDropdown();
          }}
        >
          {/* A pane can name a log the library has not handed over — the load is
              still in flight, or a bookmarked URL names a deleted run. The id
              alone still says which log the pane is on, where an empty control
              would read as "no log". */}
          {selected === null ? (
            <span className="flex-1 truncate text-lg text-ink-3">
              {/* eslint-disable-next-line i18next/no-literal-string -- "#" plus a database id is notation */}
              {value === null ? t("ui.logs.picker-none-selected") : `#${value}`}
            </span>
          ) : (
            <LogRow log={selected} />
          )}
          {/* The closed control drew no affordance at all, so the only thing
              saying it opened anything was the cursor. */}
          <Combobox.Chevron className="shrink-0 text-ink-3" />
        </button>
      </Combobox.Target>

      <Combobox.Dropdown>
        {/* The filter bar. Free text is gone: every string in this library is a
            quest name, a character or a player, and each of those is a list we
            already hold — so they are picked rather than spelled, and a typo
            can no longer empty the dropdown.

            Three FIXED rows rather than one wrapping line: the quest names are
            the longest strings here and get the full width to themselves, the
            two party filters split the next row, and the sort — which is not a
            filter — has its own. Wrapping put four controls of different widths
            wherever they happened to land, and rearranged them as the dropdown
            resized.

            The bar COMMITS on blur: React's `onBlur` is `focusout`, which
            bubbles, so this fires when focus leaves any of the three controls.
            It has to check WHERE focus went, though — `focusout` bubbles for a
            hop BETWEEN two of them just as it does for leaving the bar, so
            without the containment test picking a quest and then reaching for
            the character filter committed mid-edit and resized the list out
            from under the cursor, which is the whole failure the draft/filters
            split exists to prevent. `relatedTarget` is null when focus leaves
            the document entirely, which counts as leaving. */}
        <div
          className="flex flex-col gap-1.5 border-b border-line p-1.5"
          onBlur={(event) => {
            if (event.currentTarget.contains(event.relatedTarget)) return;
            setFilters(draft);
          }}
        >
          <Select
            data={questOptions}
            value={draft.questId === null ? null : String(draft.questId)}
            onChange={(next) => setDraft((current) => ({ ...current, questId: next === null ? null : Number(next) }))}
            placeholder={t("ui.logs.picker-quest-filter")}
            aria-label={t("ui.logs.picker-quest-filter")}
            size="xs"
            searchable
            clearable
            // Every quest, boss and character name in these lists is a proper
            // noun no dictionary carries — the same reason PinSelect turns
            // these off.
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            classNames={{ input: FILTER_INPUT_CLASS, section: "text-ink-3" }}
            comboboxProps={FILTER_COMBOBOX_PROPS}
          />
          {/* The party filters, an equal half each — or the whole row, when
              streamer mode has withheld the players. `min-w-0` on both (it is
              inside `PartyFilter`): a pill input reports a wide intrinsic size,
              and without it the two halves stop being halves the moment either
              is used. */}
          <div className="flex gap-1.5">
            <PartyFilter
              options={characterOptions}
              value={draft.characters}
              onChange={(characters) => setDraft((current) => ({ ...current, characters }))}
              placeholder={t("ui.logs.picker-character-filter")}
              art
            />
            {!streamerMode && (
              <PartyFilter
                options={playerOptions}
                value={draft.players}
                onChange={(players) => setDraft((current) => ({ ...current, players }))}
                placeholder={t("ui.logs.picker-player-filter")}
              />
            )}
          </div>
          <SortPicker sort={sort} onChange={setSort} />
        </div>

        {/* Held by ref, so the open effect above scrolls THIS list and nothing
            else — see what `scrollIntoView` did to the page behind it, and what
            a document-wide lookup does once there is a picker per pane. The
            attribute stays for the tests that reach for it. */}
        <Combobox.Options ref={optionsRef} data-picker-options mah={360} style={{ overflowY: "auto" }}>
          {groups.length === 0 && <Combobox.Empty>{t("ui.logs.picker-empty")}</Combobox.Empty>}
          {groups.map((group) => {
            const options = group.runs.map((run) => (
              <Combobox.Option
                key={run.id}
                value={String(run.id)}
                active={run.id === value}
                // The log the pane is ALREADY on, marked as a state rather than
                // as a highlight: `active` reads the same as hover, so on its
                // own it said only "the cursor is here".
                data-selected-log={run.id === value ? "true" : undefined}
                className={run.id === value ? OPTION_SELECTED_CLASS : OPTION_CLASS}
              >
                {/* Only inside a chain: a lone run has nothing to be the best
                    of, so nothing on it is tinted. */}
                <LogRow
                  log={run}
                  {...(group.isChain
                    ? {
                        bests: {
                          duration: group.bestDurationId === run.id,
                          questElapsed: group.bestQuestElapsedId === run.id,
                        },
                      }
                    : {})}
                />
              </Combobox.Option>
            ));

            // Every group wears the SAME gutter, chain or not — one class, used
            // by both branches, so the two cannot drift apart. A lone run's is
            // transparent: without it, the chain's 2px rule and its indent
            // pushed only the chained rows across, and the list read as two
            // left edges. The bar is what differs between the two, not where
            // the row starts.
            return (
              <div
                key={group.key}
                className={`${GROUP_CLASS} ${group.isChain ? CHAIN_CLASS : ""}`}
                style={
                  group.isChain
                    ? {
                        borderLeftColor: group.color,
                        // A chain also reads as one BLOCK, so the eye can see
                        // where a repeat chain starts and stops. A grey label
                        // alone read as a section heading over rows that looked
                        // no different.
                        background: "color-mix(in srgb, var(--color-raised) 45%, transparent)",
                      }
                    : { borderLeftColor: "transparent" }
                }
              >
                {group.isChain ? (
                  // The header is a node of its own rather than `Combobox.Group`'s
                  // `label`, which takes a string: what a chain came to is a row of
                  // figures on the same columns as the runs, not a caption.
                  <Combobox.Group label={<ChainHeader group={group} />}>{options}</Combobox.Group>
                ) : (
                  options
                )}
              </div>
            );
          })}
        </Combobox.Options>

        {/* What the cap left out, stated rather than trailed off: a list that
            silently stops reads as a library that ends there. The filters above
            reach all of it — this is the line that says so. */}
        {hiddenRuns > 0 && (
          <Combobox.Footer className="text-sm text-ink-3">
            {t("ui.logs.picker-more", { count: hiddenRuns })}
          </Combobox.Footer>
        )}
      </Combobox.Dropdown>
    </Combobox>
  );
};
