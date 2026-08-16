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

import { cn } from "../../../../components/ui/cn";
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
  value: number | null;
  onChange: (id: number) => void;
  color?: string;
};

const ICON_SIZE = "size-[calc(32px*var(--density))]";
const PARTY_W = "w-[calc(134px*var(--density))]";
const CONTROL_W = "min-w-[calc(320px*var(--density))] max-w-[calc(600px*var(--density))] flex-1";

const DROPDOWN_H = 480;

const TARGET_CLASS = [
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

const CLOCK_W = "min-w-[calc(96px*var(--density))]";

type ClockKind = "duration" | "quest-elapsed-time";

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

const ChainHeader = ({ group }: { group: LogPickerGroup }) => {
  const { t } = useTranslation();
  const igt = group.bestQuestElapsedMs === null ? "—" : millisecondsToElapsedFormat(group.bestQuestElapsedMs);
  const span = formatRunSpan(group.firstTime, group.lastTime);

  return (
    <div data-testid="picker-chain-header" className="flex w-full min-w-0 items-baseline gap-2 text-sm">
      <span className="shrink-0 font-semibold" style={{ color: group.color }}>
        {t("ui.logs.picker-chain-best")}
      </span>
      <Clock kind="duration" value={millisecondsToElapsedFormat(group.bestDurationMs)} best column={false} />
      <Clock kind="quest-elapsed-time" value={igt} best={group.bestQuestElapsedMs !== null} column={false} />
      <span className="h-px flex-1 self-center bg-line" aria-hidden />
      <span className="min-w-0 shrink-0 truncate text-right text-ink-3" title={span}>
        {span}
      </span>
    </div>
  );
};

const GROUP_CLASS = "rounded-xs border-l-2 pl-1";

const CHAIN_CLASS = "my-0.5 border-b border-line pb-0.5 last:border-b-0";

const OPTION_CLASS = "border-y border-transparent hover:bg-raised hover:text-ink";

const OPTION_SELECTED_CLASS = "border-y border-accent bg-accent-soft text-ink";

const FILTER_COMBOBOX_PROPS = {
  withinPortal: false,
  classNames: { dropdown: "rounded-sm border border-line-strong bg-panel", option: FILTER_OPTION_CLASS },
};

const PartyIcons = ({ log }: { log: LogSummary }) => (
  <span className={`flex shrink-0 items-center gap-[2px] ${PARTY_W}`}>
    {[log.p1Type, log.p2Type, log.p3Type, log.p4Type].map((type, slot) => {
      const url = type ? characterIconUrl(type) : undefined;
      return url === undefined ? (
        <span key={slot} className={`${ICON_SIZE} shrink-0`} aria-hidden />
      ) : (
        <EntityIcon key={slot} src={url} alt="" className={ICON_SIZE} />
      );
    })}
  </span>
);

type RunBests = { duration: boolean; questElapsed: boolean };

const LogRow = ({ log, bests, idColor }: { log: LogSummary; bests?: RunBests; idColor?: string }) => {
  const quest = log.questId === null ? "" : translateQuestId(log.questId);
  const duration = millisecondsToElapsedFormat(log.duration);
  const igt = hasQuestElapsedTime(log.questElapsedTime)
    ? millisecondsToElapsedFormat(log.questElapsedTime * 1000)
    : "—";
  const stamp = epochToLocalTime(log.time);

  return (
    <span className="flex min-w-0 flex-1 items-center gap-2.5">
      <PartyIcons log={log} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-lg font-semibold" title={quest}>
            {quest}
          </span>
          {/* eslint-disable-next-line i18next/no-literal-string -- "#" plus a database id is notation */}
          <span
            className="ml-auto shrink-0 text-sm text-ink-3"
            style={idColor === undefined ? undefined : { color: idColor }}
          >
            #{log.id}
          </span>
        </span>
        <span className="flex min-w-0 items-baseline gap-2 text-sm text-ink-3">
          <Clock kind="duration" value={duration} best={bests?.duration ?? false} />
          <Clock kind="quest-elapsed-time" value={igt} best={bests?.questElapsed ?? false} />
          <span className="ml-auto min-w-0 truncate text-right" title={stamp}>
            {stamp}
          </span>
        </span>
      </span>
    </span>
  );
};

const PARTY_MAX = 4;

type PartyOption = { value: string; label: string; icon?: string };

const PILL_CLASS = "rounded-xs border border-line bg-panel text-sm text-ink";

const SLOT_CLASS = "flex size-[calc(24px*var(--density))] shrink-0 cursor-pointer items-center justify-center";
const SLOT_HOVER_CLASS = "rounded-xs hover:bg-accent-soft hover:opacity-75";

const PILLS_INPUT_CLASS = "h-auto py-[1px]";

const FILTER_ART_W = "w-[calc(160px*var(--density))] shrink-0";
const FILTER_NAME_W = "min-w-0 flex-1";

type CharacterPillProps = {
  entry: string;
  lookup: Map<string, PartyOption>;
  onRemove: (entry: string) => void;
};

const CharacterPill = ({ entry, lookup, onRemove }: CharacterPillProps) => {
  const { t } = useTranslation();
  const option = lookup.get(entry);
  const name = option?.label ?? entry;
  return (
    <button
      key={entry}
      type="button"
      data-party-entry
      title={name}
      aria-label={t("ui.logs.picker-party-remove", { name })}
      className={cn(SLOT_CLASS, SLOT_HOVER_CLASS, "border-none bg-transparent")}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        onRemove(entry);
      }}
    >
      {option?.icon === undefined ? (
        <span className="truncate px-1 text-sm">{name}</span>
      ) : (
        <EntityIcon src={option.icon} alt="" />
      )}
    </button>
  );
};

type PlayerPillProps = {
  entry: string;
  lookup: Map<string, PartyOption>;
  onRemove: (entry: string) => void;
};

const PlayerPill = ({ entry, lookup, onRemove }: PlayerPillProps) => {
  const name = lookup.get(entry)?.label ?? entry;
  return (
    <Pill
      key={entry}
      data-party-entry
      withRemoveButton
      radius="sm"
      title={name}
      classNames={{ root: PILL_CLASS }}
      removeButtonProps={{ onMouseDown: (event) => event.preventDefault() }}
      onRemove={() => onRemove(entry)}
    >
      {name}
    </Pill>
  );
};

type PartyFilterProps = {
  options: PartyOption[];
  value: string[];
  placeholder: string;
  type: "character" | "player";
  onAdd: (entry: string) => void;
  onRemove: (entry: string) => void;
  onClear: () => void;
};

const PartyFilter = ({ options, value, placeholder, type, onAdd, onRemove, onClear }: PartyFilterProps) => {
  const { t } = useTranslation();
  const searchRef = useRef<HTMLInputElement>(null);
  const combobox = useCombobox({
    onDropdownOpen: () => {
      window.setTimeout(() => searchRef.current?.focus(), 0);
    },
    onDropdownClose: () => {
      combobox.resetSelectedOption();
      setSearch("");
    },
  });
  const [search, setSearch] = useState("");

  const lookup = useMemo(() => new Map(options.map((option) => [option.value, option])), [options]);
  const full = value.length >= PARTY_MAX;

  const query = search.trim().toLowerCase();
  const offered = options.filter(
    (option) => !value.includes(option.value) && option.label.toLowerCase().includes(query)
  );

  const inputWidthClass = useMemo(() => {
    if (type === "character") return FILTER_ART_W;
    return FILTER_NAME_W;
  }, [type]);

  const rightSection = useMemo(() => {
    if (type === "character") return <Combobox.Chevron size="xs" />;
    if (value.length > 0)
      return (
        <CloseButton
          size="xs"
          variant="transparent"
          aria-label={t("ui.logs.picker-party-clear")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onClear()}
        />
      );
    return undefined;
  }, [type, value, onClear, t]);

  const rightSectionPointerEvents = useMemo(() => {
    if (type === "character") return "all";
    if (value.length > 0) return "all";
    return "none";
  }, [type, value]);

  return (
    <Combobox
      store={combobox}
      withinPortal={false}
      size="xs"
      classNames={FILTER_COMBOBOX_PROPS.classNames}
      onOptionSubmit={(picked) => {
        onAdd(picked);
        setSearch("");
        const count = value.length + 1;
        if (count >= PARTY_MAX) combobox.closeDropdown();
      }}
    >
      <Combobox.DropdownTarget>
        <PillsInput
          size="xs"
          className={inputWidthClass}
          classNames={{ input: `${FILTER_INPUT_CLASS} ${PILLS_INPUT_CLASS}`, section: "text-ink-3" }}
          // The placeholder is DROPPED the moment the filter holds a pill (see
          // the group below), and holding several is the point of it — so the
          // control's name cannot ride the placeholder alone or it goes nameless
          // exactly when it is doing something.
          aria-label={placeholder}
          onClick={() => !full && combobox.openDropdown()}
          rightSection={rightSection}
          rightSectionPointerEvents={rightSectionPointerEvents}
        >
          <Pill.Group size="xs">
            {value.length ? null : <span className="truncate text-md text-ink-3">{placeholder}</span>}
            {value.map((entry) => {
              if (type === "character")
                return <CharacterPill key={entry} entry={entry} lookup={lookup} onRemove={onRemove} />;
              return <PlayerPill key={entry} entry={entry} lookup={lookup} onRemove={onRemove} />;
            })}
          </Pill.Group>
        </PillsInput>
      </Combobox.DropdownTarget>

      <Combobox.Dropdown>
        <Combobox.Search
          id={`${type}-filter-search`}
          ref={searchRef}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          placeholder={placeholder}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          classNames={{ input: FILTER_INPUT_CLASS }}
        />
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

const SORT_KEYS: { key: LogSortType; labelKey: string }[] = [
  { key: "time", labelKey: "ui.logs.date" },
  { key: "duration", labelKey: "ui.logs.duration" },
  { key: "quest-elapsed-time", labelKey: "ui.logs.quest-elapsed-time" },
];

const SORT_CHIP_CLASS = "inline-flex h-chip cursor-pointer items-center gap-1.5 rounded-sm border px-2 text-sm";
const SORT_CHIP_IDLE_CLASS = "border-line bg-raised text-ink-2 hover:border-line-strong hover:text-ink";

const SortPicker = ({ sort, onChange }: { sort: PickerSort; onChange: (sort: PickerSort) => void }) => {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-end gap-1.5">
      {SORT_KEYS.map(({ key, labelKey }) => {
        const active = sort.key === key;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
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

export const LogPicker = ({ logs, value, onChange, color }: LogPickerProps) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<PickerFilters>({ questId: null, characters: [], players: [] });
  const [filters, setFilters] = useState<PickerFilters>({ questId: null, characters: [], players: [] });
  const [sort, setSort] = useState<PickerSort>({ key: "time", direction: "desc" });

  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const combobox = useCombobox({
    onDropdownClose: () => setFilters(draftRef.current),
  });
  const opened = combobox.dropdownOpened;

  const [position, setPosition] = useState<"top-start" | "bottom-start">("bottom-start");

  const optionsRef = useRef<HTMLDivElement>(null);

  // Names are what streamer mode exists to withhold; a dropdown listing every
  // person who has ever been in the party is exactly that.
  const streamerMode = useMeterSettingsStore((state) => state.streamer_mode);

  const facets = useMemo(() => (opened ? pickerFacets(logs) : EMPTY_FACETS), [opened, logs]);
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
  const playerOptions = useMemo(() => facets.players.map((name) => ({ value: name, label: name })), [facets.players]);

  const matching = useMemo(
    () => (opened ? logPickerGroups(logs, filters, sort) : EMPTY_GROUPS),
    [opened, logs, filters, sort]
  );
  const { groups, hiddenRuns } = useMemo(() => capPickerGroups(matching, value), [matching, value]);
  const selected = useMemo(() => logs.find((log) => log.id === value) ?? null, [logs, value]);

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
      keepMounted={false}
      position={position}
      middlewares={{ flip: false, shift: true }}
      onOptionSubmit={(id) => {
        onChange(Number(id));
        combobox.closeDropdown();
      }}
      classNames={{
        dropdown: "rounded-sm border border-line-strong bg-panel",
        option: "rounded-xs text-md text-ink-2",
        group: "text-sm text-ink-3",
        groupLabel: "block after:hidden",
      }}
    >
      <Combobox.Target>
        <button
          type="button"
          className={`${TARGET_CLASS} ${CONTROL_W}`}
          aria-label={t("ui.logs.picker-label")}
          style={color === undefined ? undefined : { borderLeftWidth: 3, borderLeftColor: color }}
          data-series-color={color}
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
          {selected === null ? (
            <span className="flex-1 truncate text-lg text-ink-3">
              {/* eslint-disable-next-line i18next/no-literal-string -- "#" plus a database id is notation */}
              {value === null ? t("ui.logs.picker-none-selected") : `#${value}`}
            </span>
          ) : (
            <LogRow log={selected} idColor={color} />
          )}
          <Combobox.Chevron className="shrink-0 text-ink-3" />
        </button>
      </Combobox.Target>

      <Combobox.Dropdown>
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
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            classNames={{ input: FILTER_INPUT_CLASS, section: "text-ink-3" }}
            comboboxProps={FILTER_COMBOBOX_PROPS}
          />
          <div className="flex gap-1.5">
            <PartyFilter
              type="character"
              options={characterOptions}
              value={draft.characters}
              onAdd={(entry) => setDraft((current) => ({ ...current, characters: [...current.characters, entry] }))}
              onRemove={(entry) => {
                const update = (current: PickerFilters) => ({
                  ...current,
                  characters: current.characters.filter((held) => held !== entry),
                });
                setDraft(update);
                setFilters(update);
              }}
              onClear={() => {
                const update = (current: PickerFilters) => ({ ...current, characters: [] });
                setDraft(update);
                setFilters(update);
              }}
              placeholder={t("ui.logs.picker-character-filter")}
            />
            {!streamerMode && (
              <PartyFilter
                type="player"
                options={playerOptions}
                value={draft.players}
                onAdd={(entry) => setDraft((current) => ({ ...current, players: [...current.players, entry] }))}
                onRemove={(entry) => {
                  const update = (current: PickerFilters) => ({
                    ...current,
                    players: current.players.filter((held) => held !== entry),
                  });
                  setDraft(update);
                  setFilters(update);
                }}
                onClear={() => {
                  const update = (current: PickerFilters) => ({ ...current, players: [] });
                  setDraft(update);
                  setFilters(update);
                }}
                placeholder={t("ui.logs.picker-player-filter")}
              />
            )}
          </div>
          <SortPicker sort={sort} onChange={setSort} />
        </div>

        <Combobox.Options ref={optionsRef} data-picker-options mah={360} style={{ overflowY: "auto" }}>
          {groups.length === 0 && <Combobox.Empty>{t("ui.logs.picker-empty")}</Combobox.Empty>}
          {groups.map((group) => {
            const options = group.runs.map((run) => (
              <Combobox.Option
                key={run.id}
                value={String(run.id)}
                active={run.id === value}
                data-selected-log={run.id === value ? "true" : undefined}
                className={run.id === value ? OPTION_SELECTED_CLASS : OPTION_CLASS}
              >
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

            return (
              <div
                key={group.key}
                className={`${GROUP_CLASS} ${group.isChain ? CHAIN_CLASS : ""}`}
                style={
                  group.isChain
                    ? {
                        borderLeftColor: group.color,
                        background: "color-mix(in srgb, var(--color-raised) 45%, transparent)",
                      }
                    : { borderLeftColor: "transparent" }
                }
              >
                {group.isChain ? (
                  <Combobox.Group label={<ChainHeader group={group} />}>{options}</Combobox.Group>
                ) : (
                  options
                )}
              </div>
            );
          })}
        </Combobox.Options>

        {hiddenRuns > 0 && (
          <Combobox.Footer className="text-sm text-ink-3">
            {t("ui.logs.picker-more", { count: hiddenRuns })}
          </Combobox.Footer>
        )}
      </Combobox.Dropdown>
    </Combobox>
  );
};
