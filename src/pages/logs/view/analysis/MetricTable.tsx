import { Box, Text, UnstyledButton } from "@mantine/core";
import { CaretDown, CaretUp, Eye, EyeSlash } from "@phosphor-icons/react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Label } from "@/components/ui/Label";

import type { MetricRow } from "../metrics/types";
import { sectionHeadings } from "../sectionRuns";
import type { SelectorPins } from "../selectorOptions";

import { AnalysisRow } from "./AnalysisRow";
import { HoverCard, type CardAmount, type CardSection } from "./HoverCard";
import { MetricBar } from "./MetricBar";
import "./analysis.css";

export type MetricTableProps = {
  rows: MetricRow[];
  /** i18next keys for the numeric columns, from the active descriptor. */
  columnKeys: string[];
  onPin: (pins: Partial<SelectorPins>) => void;
  /** Turns a row's raw `label` into what is drawn — a player name honouring
   * streamer mode, or a translated skill name. Injected because that lookup
   * needs i18n and the settings store, which would otherwise make this table
   * untestable without both. Defaults to the raw label. */
  renderLabel?: (row: MetricRow) => React.ReactNode;
  /** Resolves a row's bar colour from its `colorSlot`. Injected for the same
   * reason as `renderLabel`: the palette lives in the settings store. */
  rowColor?: (row: MetricRow) => string;
  /** i18next key naming what a row currently represents. */
  rowsLabelKey?: string;
  /** The hover card's sections for one row, or null for no card. Injected
   * because the breakdown needs translated names and the settings store. */
  rowSections?: (row: MetricRow) => CardSection[] | null;
  /** What those sections MEASURE — the amount column's name and format, from
   * the active metric. No default: a card whose figures had no stated meaning
   * is how every tab's tooltip came to report damage. Absent, rows carry no
   * card, whatever `rowSections` returns. */
  cardAmount?: CardAmount;
  /** Per-row eye toggle, or null where a row has nothing to show. NOTHING
   * passes it today — don't go hunting for the caller; the capability is kept
   * for the approved "Source/Target Auras Filter" follow-up, which is the next
   * thing to feed it. Absent, no row grows a control and the table keeps the
   * DOM it has. */
  rowToggle?: (row: MetricRow) => { shown: boolean; onToggle: () => void } | null;
  /** Child rows behind one row, resolved by the caller — the descriptor's
   * `children` accessor bound to the current derived state. Null (or no
   * accessor) falls back to the row's OWN `children`, the groups path's
   * member variants — which is the drilled reading. Injected for the same
   * reason as `rowSections`: the per-source split needs the derived party,
   * which the table deliberately knows nothing about. */
  rowChildren?: (row: MetricRow) => MetricRow[] | null;
  /** Length of the window `MetricRow.timeline` spans, in milliseconds — the
   * denominator that turns a window into a position. Zero (or absent) makes
   * every row fall back to its magnitude bar, which is what a fight with no
   * measured length can honestly draw. */
  timelineMs?: number;
  /** What an empty table says. Defaults to the pins explanation, which is the
   * usual reason for one — but a log that never recorded the metric at all has
   * nothing to do with the pins, and saying so sends the user clearing them. */
  emptyKey?: string;
  /** A section name per row, for tables whose rows group into titled runs
   * (the effects table's provenance sections). When the name changes between
   * two consecutive rows the table draws a muted subheader above the second —
   * purely visual: no state, nothing collapses, rows keep their own order.
   * The caller passes rows already sorted so equal sections are adjacent. */
  sectionLabel?: (row: MetricRow) => string | null;
};

const FALLBACK_COLOR = "var(--color-ink-3)";

/** The one table every metric renders through.
 *
 * The bar is the row: a full-height background fill with the text on it, in the
 * row's party-slot colour so the same player is the same colour here and in the
 * chart above.
 *
 * Bars scale against the LARGEST row rather than the total: at the abilities
 * level the rows are a subset of one player's damage, so a share-of-total bar
 * would render every row as a sliver. */
export const MetricTable = ({
  rows,
  columnKeys,
  onPin,
  renderLabel,
  rowColor,
  rowsLabelKey,
  rowSections,
  cardAmount,
  rowToggle,
  rowChildren,
  timelineMs = 0,
  emptyKey = "ui.logs.no-rows",
  sectionLabel,
}: MetricTableProps) => {
  const { t } = useTranslation();

  // Built once per row set rather than once per render. At the players level a
  // single call folds that player's whole skill breakdown (and at the skills
  // level it scans the entire party twice), while the card that consumes it
  // only ever opens under the pointer — so recomputing every row's sections on
  // each band toggle, tab switch and window drag was pure waste.
  const sectionsByRow = useMemo(
    () => (rowSections ? new Map(rows.map((row) => [row.key, rowSections(row)])) : null),
    [rows, rowSections]
  );

  // Resolved once per row, not once per comparison: `sectionLabel` walks the
  // cause ladder, and asking it for each row AND for its predecessor doubled
  // that walk on every render. The timeline draws the same headings from the
  // same helper (see `sectionRuns`).
  const headings = useMemo(() => sectionHeadings(rows, sectionLabel), [rows, sectionLabel]);

  // Resolved once per row set, same as `sectionsByRow`: the accessor scans the
  // whole party's breakdown per row, and its answer only changes when the rows
  // do. Null falls back to the row's own children — the member variants the
  // groups fold attached — so one prop serves both reading modes.
  //
  // A split of FEWER THAN TWO falls back too, by the same ≥2 rule that decides
  // whether to draw a caret at all: a one-entry expansion restates its parent,
  // so preferring it over the member variants does not just show nothing — it
  // hides an expansion that had something to say. Reachable on every
  // character-unique ability at the "Done by ability" grouping (and so on
  // every ability row of a solo log), where `damageDone.children` returns the
  // single player who used it and the group's member actions go unreachable.
  const childrenByRow = useMemo(
    () =>
      new Map(
        rows.map((row) => {
          const split = rowChildren?.(row) ?? null;
          return [row.key, (split !== null && split.length >= 2 ? split : null) ?? row.children ?? split ?? []];
        })
      ),
    [rows, rowChildren]
  );

  // Which skill-group parents are open. Transient like `banded`, and reset
  // when the rows change identity: a regroup or refetch hands the table new
  // rows, and expansion keyed to the old ones would leak onto them.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  useEffect(() => setExpanded(new Set()), [rows]);

  if (rows.length === 0) {
    return (
      <Text size="sm" c="dimmed" ta="center" py="lg">
        {t(emptyKey)}
      </Text>
    );
  }

  const largest = Math.max(...rows.map((row) => row.value));

  return (
    <Box role="grid">
      {/* `data-head` rather than a styling class: the column heads and the data
          rows share role="row", so tests need something to tell them apart that
          survives this table being restyled. */}
      <Box
        className="mb-1.5 flex h-[calc(20px*var(--density))] items-center border-b border-line px-2"
        role="row"
        data-head
      >
        <Label className="flex-1" role="columnheader">
          {rowsLabelKey ? t(rowsLabelKey) : ""}
        </Label>
        {/* The head cell states the column's width itself rather than wearing
            the data cells' class, which carries the row FONT SIZE with it — the
            heads rendered at row size for as long as they shared it. */}
        {columnKeys.map((key) => (
          <Label key={key} role="columnheader" className="w-cell text-right">
            {t(key)}
          </Label>
        ))}
      </Box>

      {rows.map((row, rowIndex) => {
        const childRows = childrenByRow.get(row.key) ?? [];

        // One renderer for the row and its subrows (member variants or the
        // per-source split), so the two can never drift apart. A subrow is the
        // same anatomy indented: no band toggle, no timeline, no expansion of
        // its own — only top-level parents carry children, and only status
        // rows (which have none) timelines.
        const rowElement = (rowData: MetricRow, nested: boolean) => {
          const toggle = nested ? null : rowToggle?.(rowData);
          // A row with windows to place draws a positional timeline instead of
          // a magnitude bar — asked three times below, so it is answered once.
          const positional = !nested && Boolean(rowData.timeline) && timelineMs > 0;
          // Only rows offering a real CHOICE expand: below two children the
          // expansion restates its parent (the spec's ≥2 rule). `childRows`
          // is the outer row's — only the outer call can pass nested=false.
          const hasChildren = !nested && childRows.length >= 2;
          const isExpanded = expanded.has(rowData.key);
          const pinOnClick = rowData.pinOnClick;
          return (
            // The row shell — a focusable div, its geometry and its name cell —
            // is `AnalysisRow`, shared with the timeline's lanes so the two can
            // never draw a row two different heights. Everything below is this
            // table's own: the bar, the controls, the uptime track, the figures.
            <AnalysisRow
              className={nested ? "analysis-subrow" : undefined}
              onClick={pinOnClick ? () => onPin(pinOnClick) : undefined}
              nameFixed={positional}
              name={renderLabel ? renderLabel(rowData) : rowData.label}
              background={
                !positional && (
                  <MetricBar
                    value={rowData.value}
                    subValue={rowData.subValue}
                    largest={largest}
                    color={rowColor ? rowColor(rowData) : FALLBACK_COLOR}
                    variant="row"
                  />
                )
              }
              leading={
                <>
                  {/* A real button now that the row is not one. Still stops
                      propagation, so banding a row does not also pin it — including
                      on the keyboard, where the row above listens for the same keys. */}
                  {toggle && (
                    <UnstyledButton
                      aria-pressed={toggle.shown}
                      aria-label={t("ui.logs.buff-band-toggle")}
                      className="analysis-row-toggle"
                      style={{ opacity: toggle.shown ? 1 : 0.35 }}
                      onClick={(event: React.MouseEvent) => {
                        event.stopPropagation();
                        toggle.onToggle();
                      }}
                      onKeyDown={(event: React.KeyboardEvent) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.stopPropagation();
                      }}
                    >
                      {toggle.shown ? <Eye size={14} weight="fill" /> : <EyeSlash size={14} />}
                    </UnstyledButton>
                  )}
                  {/* The skill-group expand control — its own button for the same
                      nesting reason as the band toggle, and stopping propagation
                      because opening a group must not also pin it. */}
                  {hasChildren && (
                    <UnstyledButton
                      aria-expanded={isExpanded}
                      aria-label={t("ui.logs.expand-row")}
                      className="analysis-row-expand"
                      onClick={(event: React.MouseEvent) => {
                        event.stopPropagation();
                        setExpanded((previous) => {
                          const next = new Set(previous);
                          if (!next.delete(rowData.key)) next.add(rowData.key);
                          return next;
                        });
                      }}
                      onKeyDown={(event: React.KeyboardEvent) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.stopPropagation();
                      }}
                    >
                      {isExpanded ? <CaretUp size={12} /> : <CaretDown size={12} />}
                    </UnstyledButton>
                  )}
                </>
              }
              trailing={
                positional &&
                rowData.timeline && (
                  // Positional, not proportional: Warcraft Logs' uptime bar marks
                  // WHEN the effect was up, and the % column beside it already
                  // says how much. Its own cell between the name and the numbers,
                  // so the pieces never sit under text. One piece per contiguous
                  // window — `toBands` merged the overlaps.
                  <Box className="analysis-track" aria-hidden>
                    {rowData.timeline.map((span, spanIndex) => (
                      <Box
                        key={spanIndex}
                        className="analysis-timeline-piece"
                        style={{
                          left: `${(span.startMs / timelineMs) * 100}%`,
                          width: `${((span.endMs - span.startMs) / timelineMs) * 100}%`,
                          // A window shorter than a pixel is still a real window;
                          // at zero width it would vanish from a row that reports
                          // it.
                          minWidth: "2px",
                          backgroundColor: rowColor ? rowColor(rowData) : FALLBACK_COLOR,
                        }}
                      />
                    ))}
                  </Box>
                )
              }
              columns={rowData.columns.map((value, columnIndex) => (
                <Text
                  key={columnIndex}
                  role="gridcell"
                  className={`analysis-cell${columnIndex === 0 ? "" : " analysis-cell-muted"}`}
                >
                  {value}
                </Text>
              ))}
            />
          );
        };

        const button = rowElement(row, false);

        // The key moves off the row and onto whichever element is the list
        // child: HoverCard clones its child and would otherwise lose it.
        const sections = sectionsByRow?.get(row.key);
        const parent =
          !sections || sections.length === 0 || !cardAmount ? (
            <Box>{button}</Box>
          ) : (
            <HoverCard sections={sections} {...cardAmount}>
              {button}
            </HoverCard>
          );

        // A subheader is drawn only where the section CHANGES, so a run of
        // rows sharing one is titled once. Purely visual: not a row, takes no
        // interaction, and absent the prop nothing is drawn at all.
        const heading = headings[rowIndex];

        return (
          <Fragment key={row.key}>
            {/* Visual grouping only: it is not a row and takes no interaction. */}
            {heading !== null && <Label className="px-2 pb-0.5 pt-2">{heading}</Label>}
            {parent}
            {expanded.has(row.key) &&
              childRows.map((child) => <Fragment key={child.key}>{rowElement(child, true)}</Fragment>)}
          </Fragment>
        );
      })}
    </Box>
  );
};
