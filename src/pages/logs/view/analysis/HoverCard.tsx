import { Box, Text } from "@mantine/core";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { CursorCard } from "@/components/CursorCard";
import { useCtrlHeld } from "@/components/useCtrlHeld";
import { share } from "@/utils";

import { MetricBar } from "./MetricBar";

import "./analysis.css";

/** One row of a card section. `color` overrides the section's colour for this
 * row alone — a "by source" section is per player, and one colour across every
 * row of it would say nothing about who dealt what. `icon` is the entity's
 * art, where it has any; rows without stay text-only rather than reserving a
 * blank box. */
export type BreakdownEntry = {
  key: string;
  label: string;
  value: number;
  /** The supplementary part of `value` — see `MetricRow.subValue`. */
  subValue?: number;
  color?: string;
  icon?: string;
};

/** One stacked section of the card: a heading naming the dimension, then its
 * rows. `color` is the entity's colour — ability rows take their owner's, target
 * rows take the target's — so colour keeps following the entity. */
export type CardSection = {
  headingKey: string;
  color: string;
  entries: BreakdownEntry[];
  /** Whether the rows state their share of the section. Off for a section
   * whose shares are meaningless — a one-row Total is 100% of itself by
   * construction, and a column that can only read 100% is noise. Defaults on:
   * a breakdown without shares is the thing a breakdown is FOR. */
  showShare?: boolean;
  /** Whether the section names itself. Off where the rows already say it: the
   * Total section's single row is labelled "Total", and a heading above it
   * repeats the word rather than adding a dimension. The section separator
   * still divides it from the breakdown, which is the part that has to read. */
  showHeading?: boolean;
  /** A FLOOR on the rows drawn: short of it, the section pads with blank
   * slots. `SECTION_ENTRY_CAP` is still the ceiling.
   *
   * For a section whose entry count varies between renders of one card — the
   * chart tooltip's, which is one BUCKET of a plot, where most bands are zero
   * at any one second and drop out. Dropping them is right (they bury the few
   * that fired) but the card then resized under the cursor on every move.
   * Absent for the row cards, whose sections are fixed by the row they
   * explain; padding those would only open a gap under the last row. */
  reserve?: number;
};

/** How a card writes its figures, and what it calls them.
 *
 * Per card rather than per section: every section of one card measures the
 * same thing, and the heading said "DMG" over stun figures for as long as it
 * was hard-coded here. Supplied by the active metric — see `MetricCard`. */
export type CardAmount = {
  /** i18next key for the amount column. */
  amountKey: string;
  format: (value: number) => string;
};

export type HoverCardBodyProps = {
  sections: CardSection[];
  /** Whether to show the card's DETAIL reading rather than the summary it
   * shows at rest — today, every entry of a section instead of its top five.
   *
   * A prop rather than a hook call inside this component, deliberately: the
   * card shells own the key read (see `HoverCard` below), because a body that
   * changed size on its own would leave `CursorCard`'s cached measurement — and
   * so its grow-up offset and viewport clamps — stale for the rest of the
   * hover. It is also the seam future detail content branches on. */
  detailed?: boolean;
} & CardAmount;

/** WCL's cap: a section shows its top five entries and stays silent about
 * the rest — no "+N more" row. Applied after the builders' descending sort,
 * so the five are always the largest. Lifted while `detailed` is set. */
export const SECTION_ENTRY_CAP = 5;

const Section = ({
  headingKey,
  color,
  entries,
  detailed,
  amountKey,
  format,
  showShare = true,
  showHeading = true,
  reserve = 0,
}: CardSection & CardAmount & { detailed: boolean }) => {
  const { t } = useTranslation();
  if (entries.length === 0) return null;

  // Top five only; every builder sorts descending, so the slice IS the
  // largest five. `total` stays over the FULL list — a capped section's
  // shares must not re-normalize to 100%, which is also what lets the tail
  // appear without moving a single figure already on screen.
  const shown = detailed ? entries : entries.slice(0, SECTION_ENTRY_CAP);
  // Blank slots up to the reserve. Detailed, the card is deliberately as long
  // as its data, so a floor it has already passed would only add empty rows at
  // the bottom of it.
  const padding = detailed ? 0 : Math.max(0, Math.min(reserve, SECTION_ENTRY_CAP) - shown.length);
  // Scaled to the section's largest entry, not its total: a three-row target
  // list scaled to the total would be three slivers.
  const largest = Math.max(...shown.map((entry) => entry.value));
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);

  return (
    <Box className="analysis-card-section">
      {showHeading && (
        <Box className="analysis-card-head">
          <Text className="analysis-label" style={{ flex: 1 }}>
            {t(headingKey)}
          </Text>
          {/* Amount then share, matching the table above it: the amount is what
              the row is about and the share qualifies it. */}
          <Text className="analysis-label" style={{ width: 64, textAlign: "right" }}>
            {t(amountKey)}
          </Text>
          {showShare ? (
            <Text className="analysis-label" style={{ width: 52, textAlign: "right" }}>
              {t("ui.logs.column-share")}
            </Text>
          ) : (
            <Box style={{ width: 52 }} />
          )}
        </Box>
      )}
      {shown.map((entry) => {
        return (
          <Box key={entry.key} className="analysis-card-row">
            <MetricBar
              value={entry.value}
              subValue={entry.subValue}
              largest={largest}
              color={entry.color ?? color}
              variant="card"
            />
            <Text className="analysis-card-name">
              {entry.icon && <img className="analysis-card-icon" src={entry.icon} alt="" />}
              {entry.label}
            </Text>
            <Text className="analysis-card-amount">{format(entry.value)}</Text>
            {/* The share column's width is RESERVED when its figures are not
                written. It is a fixed cell at the end of a flex row, so simply
                dropping it slides the amount 52px right and the Total lands
                under the share column of every row it sums. */}
            {showShare ? (
              <Text className="analysis-card-share">{share(entry.value, total)}</Text>
            ) : (
              <Box className="analysis-card-share-spacer" style={{ width: 52 }} />
            )}
          </Box>
        );
      })}
      {/* The reserved remainder. Empty rather than a dimmed zero row: nothing
          happened in this slot, and writing "0" would be a figure the plot
          does not draw. Hidden from assistive tech, which has no use for a
          layout floor. */}
      {Array.from({ length: padding }, (_, index) => (
        <Box key={`slot-${index}`} className="analysis-card-row analysis-card-row-empty" aria-hidden />
      ))}
    </Box>
  );
};

/** One row of a note section: an event or span the card reports but does not
 * measure. `color` is the entity's own — the marker line's stroke, the window
 * band's shade — so the row and the mark it stands for on the plot agree. */
export type CardNote = { key: string; color: string; text: string };

/** A section of notes rather than of figures.
 *
 * Deaths, SBA casts and the battle windows carry no VALUE, and inventing a
 * number to fit them into a `BreakdownEntry` would be worse than keeping them
 * apart — but rendered as bare coloured paragraphs they stopped looking like
 * the card they sat in. This is the card's own section shell with the amount
 * and share columns dropped: a heading naming the kind, then one swatched row
 * per note. */
export const CardNotes = ({ headingKey, notes }: { headingKey: string; notes: CardNote[] }) => {
  const { t } = useTranslation();
  if (notes.length === 0) return null;

  return (
    <Box className="analysis-card-section">
      <Box className="analysis-card-head">
        <Text className="analysis-label" style={{ flex: 1 }}>
          {t(headingKey)}
        </Text>
      </Box>
      {notes.map((note) => (
        <Box key={note.key} className="analysis-card-row">
          {/* Identity never rides colour alone — the swatch marks which line on
              the plot this is, and the text says it in words. */}
          <Box className="analysis-card-note-swatch" style={{ backgroundColor: note.color }} />
          <Text className="analysis-card-name">{note.text}</Text>
        </Box>
      ))}
    </Box>
  );
};

/** The card's contents, separated from its positioning so it can be tested
 * without a cursor.
 *
 * At rest each section truncates to its top `SECTION_ENTRY_CAP` entries;
 * `detailed` lifts that. The portal's 70vh max-height stays as the guard
 * behind both, since a card can stack several sections and a detailed one can
 * be arbitrarily long. */
export const HoverCardBody = ({ sections, detailed = false, amountKey, format }: HoverCardBodyProps) => (
  <Box>
    {sections.map((section) => (
      <Section key={section.headingKey} {...section} detailed={detailed} amountKey={amountKey} format={format} />
    ))}
  </Box>
);

/** [`HoverCardBody`] in a cursor-following portal — `CursorCard`, which the
 * quest view's own row tooltip shares. */
export const HoverCard = ({
  children,
  ...body
}: HoverCardBodyProps & {
  children: React.ReactElement;
}) => {
  // The key read lives HERE rather than in the body, and the answer travels
  // down as a prop. `CursorCard` re-measures only when its `content` changes
  // identity, so a body that grew itself would keep the size it was measured
  // at and mis-place the panel for the rest of the hover. Read here, the flip
  // rebuilds `content` below, which is exactly the signal that effect waits on.
  const detailed = useCtrlHeld();

  // Memoized because CursorCard re-renders on every committed cursor frame and
  // only its outer box should move. The deps are a props object rebuilt every
  // render, so this is a fresh element each time — which is exactly why
  // CursorCard's measure effect has to bail when the size has not changed.
  const content = useMemo(() => <HoverCardBody {...body} detailed={detailed} />, [body, detailed]);

  // Nothing to explain — render the row alone rather than an empty card.
  if (body.sections.every((section) => section.entries.length === 0)) {
    return children;
  }

  return (
    <CursorCard
      content={content}
      testId="metric-hover-card"
      // Surface (colours, border, shadow, clipping) from the shared panel
      // class the aura tiles' card also wears; only the SIZE is this card's
      // own — a breakdown needs a width floor an effect name does not.
      className="analysis-tokens analysis-hover-panel"
      style={{ minWidth: 300, maxWidth: 420, maxHeight: "70vh" }}
    >
      {children}
    </CursorCard>
  );
};
