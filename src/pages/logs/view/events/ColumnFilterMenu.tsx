import { Checkbox, Popover, TextInput, UnstyledButton } from "@mantine/core";
import { FunnelSimple } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { EntityIcon } from "@/components/ui/EntityIcon";
import { Figure } from "@/components/ui/Figure";

import { DROPDOWN_PANEL_CLASS } from "../analysis/dropdownSkin";
import type { ColumnOption, EventColumn } from "./columnFilters";

/** A bare glyph sitting ON the line of the head it belongs to — no box, no
 * border. A column head is a run of text, and a bordered control in the middle
 * of it reads as a second thing rather than as part of the name it filters. */
const TRIGGER_CLASS = [
  "inline-flex flex-none cursor-pointer items-center self-center align-middle",
  "text-ink-3 hover:text-ink",
].join(" ");

/** Lit while the column is narrowing something, so a table that is hiding rows
 * never looks like a table that simply has none. */
const TRIGGER_ACTIVE_CLASS = "text-accent hover:text-accent";

const SEARCH_CLASS = [
  "h-control min-h-control rounded-sm border border-line bg-panel text-md text-ink",
  "placeholder:text-ink-3 hover:border-line-strong focus:border-accent focus-within:border-accent",
].join(" ");

export type ColumnFilterMenuProps = {
  column: EventColumn;
  /** The column's own translated name, for the control's accessible name — a
   * row of three identical funnels is three controls announced the same way. */
  name: string;
  /** Called only once the menu OPENS. Building a column's values walks every
   * row in the stream, and a stream runs to fifty thousand — doing that on
   * every render for three menus nobody opened is pure waste. */
  options: (column: EventColumn) => ColumnOption[];
  picked: ReadonlySet<string>;
  onChange: (picked: ReadonlySet<string>) => void;
};

/** The funnel on one column head, and the list of values behind it.
 *
 * Multi-select, because the question a reader actually has is "these two
 * players" or "these three abilities" far more often than "this one thing" —
 * and a single-select control cannot be asked the former at all.
 *
 * The values are deduped by NAME (see `columnOptions`), so one line can stand
 * for two ids the game names identically; ticking it keeps both, which is why
 * an option carries tokens rather than a token. */
export const ColumnFilterMenu = ({ column, name, options, picked, onChange }: ColumnFilterMenuProps) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const all = useMemo(() => (open ? options(column) : []), [open, options, column]);
  const shown = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    return wanted === "" ? all : all.filter((option) => option.label.toLowerCase().includes(wanted));
  }, [all, query]);

  const toggle = (tokens: string[], on: boolean) => {
    const next = new Set(picked);
    for (const token of tokens) {
      if (on) next.add(token);
      else next.delete(token);
    }
    onChange(next);
  };

  return (
    <Popover
      opened={open}
      onChange={setOpen}
      position="bottom-start"
      // Inside the table rather than portalled to the body: the stream is a
      // scrolling container, and a portalled panel would sit still while the
      // head it belongs to scrolled away under it.
      withinPortal={false}
      trapFocus
    >
      <Popover.Target>
        <UnstyledButton
          data-column-filter={column}
          aria-label={t("ui.logs.events-filter-column", { column: name })}
          aria-expanded={open}
          className={cn(TRIGGER_CLASS, picked.size > 0 && TRIGGER_ACTIVE_CLASS)}
          onClick={() => setOpen((was) => !was)}
        >
          <FunnelSimple size={15} weight={picked.size > 0 ? "fill" : "bold"} />
        </UnstyledButton>
      </Popover.Target>

      <Popover.Dropdown className={cn(DROPDOWN_PANEL_CLASS, "w-[calc(260px*var(--density))]")}>
        <TextInput
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={t("ui.logs.events-filter-search")}
          aria-label={t("ui.logs.events-filter-search")}
          classNames={{ input: SEARCH_CLASS }}
        />

        <div className="mt-1 max-h-[calc(220px*var(--density))] overflow-y-auto">
          {shown.length === 0 ? (
            <Figure size="sm" tone="dim" className="block px-1 py-2">
              {t("ui.logs.events-filter-empty")}
            </Figure>
          ) : (
            shown.map((option) => {
              // Ticked only when EVERY token behind the name is — a half-ticked
              // fold would report itself as on while keeping only some of what
              // its count promised.
              const on = option.tokens.every((token) => picked.has(token));
              return (
                <Checkbox
                  key={option.label}
                  data-filter-option={option.label}
                  size="xs"
                  checked={on}
                  onChange={(event) => toggle(option.tokens, event.currentTarget.checked)}
                  className="rounded-xs px-1 py-1 hover:bg-raised"
                  classNames={{ label: "min-w-0 flex-1 text-md text-ink-2", body: "items-center gap-1.5" }}
                  label={
                    <span className="flex min-w-0 items-center gap-1.5">
                      {option.iconUrl !== undefined && <EntityIcon size="control" src={option.iconUrl} alt="" />}
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      {/* How many rows ticking this WOULD keep, given what the
                          other columns already admit — see `facetFor`. */}
                      <Figure size="sm" tone="dim" data-filter-count={option.label}>
                        {t("ui.logs.events-filter-option-count", { count: option.count })}
                      </Figure>
                    </span>
                  }
                />
              );
            })
          )}
        </div>

        {picked.size > 0 && (
          <Button
            variant="subtle"
            data-filter-clear
            className="mt-1 w-full justify-start py-1 text-left text-md"
            onClick={() => onChange(new Set())}
          >
            {t("ui.logs.events-filter-clear")}
          </Button>
        )}
      </Popover.Dropdown>
    </Popover>
  );
};
