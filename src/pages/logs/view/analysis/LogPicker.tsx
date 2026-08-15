import { Combobox, useCombobox } from "@mantine/core";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { characterIconUrl } from "@/characterIcon";
import { EntityIcon } from "@/components/ui/EntityIcon";
import type { LogSummary } from "@/types";
import { epochToLocalTime, millisecondsToElapsedFormat, translateQuestId } from "@/utils";

import { logPickerGroups } from "./logPickerOptions";

export type LogPickerProps = {
  logs: LogSummary[];
  /** The log this picker currently shows, or null while a new pane is empty. */
  value: number | null;
  onChange: (id: number) => void;
};

/** The control and the dropdown in the Analysis view's own palette rather than
 * Mantine's stock dark input — the same tokens `PinSelect` reads, because this
 * sits a row above it and two designs in one column read as a mistake. */
const TARGET_CLASS = [
  "flex items-center gap-2 h-control min-h-control px-2 rounded-sm",
  "border border-line bg-panel text-md text-ink text-left",
  "hover:border-line-strong focus:border-accent",
].join(" ");

/** The four character icons of a log's party. Icons rather than names: a party
 * is recognised by its characters far faster than it is read. */
const PartyIcons = ({ log }: { log: LogSummary }) => (
  <span className="flex shrink-0 items-center gap-[2px]">
    {[log.p1Type, log.p2Type, log.p3Type, log.p4Type]
      .filter((type): type is string => !!type)
      .map((type, slot) => {
        const url = characterIconUrl(type);
        return url === undefined ? null : <EntityIcon key={`${type}-${slot}`} size="card" src={url} alt="" />;
      })}
  </span>
);

/** One log, as the closed control and as an option read it: who, which quest,
 * when, and how long the run took in game. */
const LogRow = ({ log }: { log: LogSummary }) => {
  const igt = log.questElapsedTime === null ? "" : ` · ${millisecondsToElapsedFormat(log.questElapsedTime * 1000)}`;
  // Built here rather than spelled out in the JSX: a date, a duration and a "#"
  // plus a database id are notation, and notation assembled in a string needs no
  // translation key and no lint exemption to say so.
  const stamp = `${epochToLocalTime(log.time)}${igt} · #${log.id}`;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <PartyIcons log={log} />
      <span className="truncate">{log.questId === null ? "" : translateQuestId(log.questId)}</span>
      <span className="shrink-0 text-sm text-ink-3">{stamp}</span>
    </span>
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
  const [query, setQuery] = useState("");
  const combobox = useCombobox({ onDropdownClose: () => setQuery("") });

  const groups = useMemo(
    () => logPickerGroups(logs, query, (questId) => (questId === null ? "" : translateQuestId(questId))),
    [logs, query]
  );
  const selected = useMemo(() => logs.find((log) => log.id === value) ?? null, [logs, value]);

  return (
    <Combobox
      store={combobox}
      onOptionSubmit={(id) => {
        onChange(Number(id));
        combobox.closeDropdown();
      }}
      classNames={{
        dropdown: "rounded-sm border border-line-strong bg-panel",
        option: "rounded-xs text-md text-ink-2 hover:bg-raised hover:text-ink data-[combobox-active]:bg-raised",
        group: "text-sm text-ink-3",
      }}
    >
      <Combobox.Target>
        <button
          type="button"
          className={TARGET_CLASS}
          aria-label={t("ui.logs.picker-label")}
          onClick={() => combobox.toggleDropdown()}
        >
          {/* A pane can name a log the library has not handed over — the load is
              still in flight, or a bookmarked URL names a deleted run. The id
              alone still says which log the pane is on, where an empty control
              would read as "no log". */}
          {selected === null ? (
            // eslint-disable-next-line i18next/no-literal-string -- "#" plus a database id is notation
            <span className="text-ink-3">{value === null ? t("ui.logs.picker-none-selected") : `#${value}`}</span>
          ) : (
            <LogRow log={selected} />
          )}
        </button>
      </Combobox.Target>

      <Combobox.Dropdown>
        <Combobox.Search
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={t("ui.logs.picker-search-placeholder")}
          // Every quest, boss and character name in this list is a proper noun
          // no dictionary carries — the same reason PinSelect turns these off.
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
        <Combobox.Options mah={360} style={{ overflowY: "auto" }}>
          {groups.length === 0 && <Combobox.Empty>{t("ui.logs.picker-empty")}</Combobox.Empty>}
          {groups.map((group) => {
            const options = group.runs.map((run) => (
              <Combobox.Option key={run.id} value={String(run.id)} active={run.id === value}>
                <LogRow log={run} />
              </Combobox.Option>
            ));
            return group.isChain ? (
              <Combobox.Group
                key={group.key}
                label={t("ui.logs.picker-chain-summary", {
                  count: group.runs.length,
                  time:
                    group.bestQuestElapsedTime === null
                      ? t("ui.logs.picker-chain-no-best")
                      : millisecondsToElapsedFormat(group.bestQuestElapsedTime * 1000),
                })}
              >
                {options}
              </Combobox.Group>
            ) : (
              options
            );
          })}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
};
