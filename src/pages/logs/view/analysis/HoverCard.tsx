import { Box, Text } from "@mantine/core";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { CursorCard } from "@/components/CursorCard";
import { EntityIcon } from "@/components/ui/EntityIcon";
import { Figure } from "@/components/ui/Figure";
import { Label } from "@/components/ui/Label";
import { cn } from "@/components/ui/cn";
import { useCtrlHeld } from "@/components/useCtrlHeld";
import type { GroupFacts } from "@/types";
import { humanizeNumber, share } from "@/utils";

import { factCaption, factCell } from "../metrics/damageDone";

import { MetricBar } from "./MetricBar";
import { RowArt } from "./RowArt";

import "./analysis.css";

/** The chrome every cursor-following panel in the view wears: this card and the
 * aura tiles' own. Size is the caller's — a breakdown card needs a width floor
 * an effect name does not — but the surface must not differ, or one view teaches
 * two kinds of tooltip. Shared as a constant rather than as a class, so the two
 * cannot drift apart while both are written out in TSX. */
export const HOVER_PANEL_CLASS = "overflow-hidden rounded-sm border border-line-strong bg-panel text-white shadow-md";

/** A stacked section of a card, ruled off from the one above it. `&+&` rather
 * than an index: a card's sections come from two components (`Section` and
 * `CardNotes`), so neither knows whether it is the first. */
const SECTION_CLASS = "[&+&]:border-t [&+&]:border-line-strong";

// `h-card-row` rather than a literal: `--spacing-art-card` reads the same token,
// so a card entry's art is always exactly as tall as the bar it stands at.
const CARD_ROW_CLASS = "relative mx-1 my-0.5 flex h-card-row items-center rounded-xs pl-[var(--row-pad)] pr-2";

/** Every entry gives its left padding up to the art box: the bar runs edge to
 * edge under the figures on the right, and an inset on the left alone leaves a
 * gap on one side of a bar that has none on the other. Unconditional because
 * every entry draws the box — art or placeholder (see the `RowArt` below) —
 * exactly as the table's rows do. */
const CARD_ROW_ART_CLASS = "[--row-pad:0px]";

/** The two fixed cells at the end of a row, scaled like everything else — the
 * heads read the same widths, which is what keeps the columns stacked. */
const AMOUNT_W = "w-[calc(64px*var(--density))]";
const SHARE_W = "w-[calc(52px*var(--density))]";

/** One row of a card section. `color` overrides the section's colour for this
 * row alone — a "by source" section is per player, and one colour across every
 * row of it would say nothing about who dealt what. `icon` is the entity's
 * art, where it has any; rows without draw the same faint placeholder diamond
 * a table row without art draws, so the card's name column holds one left
 * edge and reads like the table it explains. */
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
  /** The row's damage-fact tallies, for the "Damage facts" section — absent
   * wherever `MetricRow.facts` is (see its own doc): the enemy side, `taken`
   * rows, `other`, and everything the descriptors' SkillState-based fold
   * produces. `total` is the ROW's own value, not this section's — the
   * Overdrive/Break split answers "what share of the row happened there",
   * and an Overdrive+Break sum does not equal the row (a hit can be in
   * neither, or the row's damage can predate either state).
   *
   * `facts` is always the RAW measure (see `MetricRow.facts`'s own doc), so
   * with Merge Sup DMG on, the split's numerator (direct hits only) is
   * divided by a `total` that is the MERGED, echo-folded row value — the
   * share reads slightly low in that state, a direct consequence of facts
   * staying raw rather than a bug in the division itself. */
  damageFacts?: { facts: GroupFacts; total: number };
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
    <Box data-card-section className={SECTION_CLASS}>
      {showHeading && (
        <Box data-card-head className="flex h-head items-center bg-raised px-2">
          <Label className="flex-1">{t(headingKey)}</Label>
          {/* Amount then share, matching the table above it: the amount is what
              the row is about and the share qualifies it. */}
          <Label className={`${AMOUNT_W} text-right`}>{t(amountKey)}</Label>
          {showShare ? (
            <Label className={`${SHARE_W} text-right`}>{t("ui.logs.column-share")}</Label>
          ) : (
            <Box className={SHARE_W} />
          )}
        </Box>
      )}
      {shown.map((entry) => {
        return (
          <Box key={entry.key} data-card-row className={cn(CARD_ROW_CLASS, CARD_ROW_ART_CLASS)}>
            <MetricBar
              value={entry.value}
              subValue={entry.subValue}
              largest={largest}
              color={entry.color ?? color}
              variant="card"
              // ONE head for every card entry, where a table row picks between
              // two. A card's entries are not typed — a chart tooltip's section
              // is whatever the plot is grouped by, so player rows and ability
              // rows arrive through the same list — and `point` is the reading
              // that holds for both: the bar draws the diamond's head itself
              // and the art stands on it, whether that art is a diamond or a
              // bust. The silhouette is the table's either way. Headed even
              // without art, like a table row: the placeholder is translucent,
              // so the bar's own head shows through it.
              head="point"
            />
            {/* Out of the name cell and into a box of its own, exactly as a
                table row draws it: at the bar's height it cannot sit inside a
                one-line truncating text. Rendered for EVERY entry — `RowArt`
                draws the faint placeholder diamond where there is no art, the
                same box a table row without art gets. */}
            <RowArt src={entry.icon} scale="card" />
            <Text data-card-name className="relative min-w-0 flex-1 truncate text-md">
              {entry.label}
            </Text>
            <Figure data-card-amount size="sm" className={`relative ${AMOUNT_W} text-right`}>
              {format(entry.value)}
            </Figure>
            {/* The share column's width is RESERVED when its figures are not
                written. It is a fixed cell at the end of a flex row, so simply
                dropping it slides the amount 52px right and the Total lands
                under the share column of every row it sums. */}
            {showShare ? (
              <Figure data-card-share size="sm" tone="muted" className={`relative ${SHARE_W} text-right`}>
                {share(entry.value, total)}
              </Figure>
            ) : (
              <Box data-card-share-spacer className={SHARE_W} />
            )}
          </Box>
        );
      })}
      {/* The reserved remainder. Empty rather than a dimmed zero row: nothing
          happened in this slot, and writing "0" would be a figure the plot
          does not draw. Hidden from assistive tech, which has no use for a
          layout floor. */}
      {Array.from({ length: padding }, (_, index) => (
        <Box key={`slot-${index}`} data-card-row className={CARD_ROW_CLASS} aria-hidden />
      ))}
    </Box>
  );
};

/** One row of a note section: an event or span the card reports but does not
 * measure. `color` is the entity's own — the marker line's stroke, the window
 * band's shade — so the row and the mark it stands for on the plot agree.
 *
 * `icon` is that entity's art where it has any, drawn exactly as a measured
 * entry's is. A death or a Skybound Art is an actor doing something, and a note
 * row naming a player next to a card row naming the same player looked like two
 * different kinds of thing for want of the picture. Absent on the window notes,
 * which name a span rather than an actor. */
export type CardNote = {
  key: string;
  color: string;
  text: string;
  icon?: string;
  /** A short label ahead of the text, in a colour of its own — the compare
   * overlay's log id, where several fights' spans share one card and the
   * swatch is already spoken for by the kind. */
  tag?: { text: string; color: string };
};

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
    <Box data-card-section className={SECTION_CLASS}>
      <Box data-card-head className="flex h-head items-center bg-raised px-2">
        <Label className="flex-1">{t(headingKey)}</Label>
      </Box>
      {notes.map((note) => (
        <Box key={note.key} data-card-row className={CARD_ROW_CLASS}>
          {/* Identity never rides colour alone — the swatch marks which line on
              the plot this is, and the text says it in words. */}
          <Box
            data-card-swatch
            className="relative mr-[7px] size-swatch flex-none rounded-xs"
            style={{ backgroundColor: note.color }}
          />
          <Text data-card-name className="relative min-w-0 flex-1 truncate text-md">
            {/* The same size and inline offset a measured entry's art takes, so
                a notes section and a breakdown section above it line up. */}
            {note.icon && <EntityIcon size="card" src={note.icon} alt="" className="mr-[5px] align-[-3px]" />}
            {note.tag && (
              <span data-card-tag className="mr-[6px] font-medium" style={{ color: note.tag.color }}>
                {note.tag.text}
              </span>
            )}
            {note.text}
          </Text>
        </Box>
      ))}
    </Box>
  );
};

/** The Crit%/WP%/BA% rows the "Damage facts" section fills, in the order the
 * table's own trailing columns show them.
 *
 * Crit leads and has no column of its own — the card is where it is read (see
 * `factColumns`) — so this list is one longer than the table's, deliberately. */
const FACT_ROWS: { field: "crit" | "weakPoint" | "backAttack"; labelKey: string }[] = [
  { field: "crit", labelKey: "ui.skill-columns.crit" },
  { field: "weakPoint", labelKey: "ui.skill-columns.weak-point" },
  { field: "backAttack", labelKey: "ui.skill-columns.back-attack" },
];

/** The Overdrive/Break rows: which `GroupFacts` damage field, and what to call
 * it. */
const SPLIT_ROWS: { field: "overdriveDamage" | "breakDamage"; labelKey: string }[] = [
  { field: "overdriveDamage", labelKey: "ui.logs.hover-in-overdrive" },
  { field: "breakDamage", labelKey: "ui.logs.hover-in-break" },
];

/** A row hover card's "Damage facts" section: the same crit/weak-point/
 * back-attack rates the table's own trailing three columns show (`~` marker
 * included, from the same `factCell`), each captioned where its rate needs
 * explaining (`factCaption`); then the Overdrive/Break damage split, as an
 * amount plus its share of the ROW's own total.
 *
 * Rendered directly rather than through `CardSection`/`Section`: every
 * section of a `HoverCardBody` reads ONE shared `amountKey`/`format`
 * (`CardAmount`), which fits a breakdown of contributors but not a
 * percentage rate sitting in the same card as a damage split. Fixed-size —
 * three rates plus two split rows, each with at most one caption line — so
 * it never needs the five-entry cap the breakdown sections do. */
const DamageFactsSection = ({ facts, total }: { facts: GroupFacts; total: number }) => {
  const { t } = useTranslation();
  return (
    <Box data-card-section className={SECTION_CLASS}>
      <Box data-card-head className="flex h-head items-center bg-raised px-2">
        <Label className="flex-1">{t("ui.logs.hover-damage-facts")}</Label>
      </Box>
      {FACT_ROWS.map(({ field, labelKey }) => {
        const factTally = facts[field];
        const caption = factCaption(factTally);
        return (
          <Box key={field} data-card-row className="relative mx-1 my-0.5 flex flex-col justify-center px-2 py-1">
            <Box className="flex items-center">
              <Text data-card-name className="relative min-w-0 flex-1 truncate text-md">
                {t(labelKey)}
              </Text>
              <Figure data-card-amount size="sm" className={`relative ${AMOUNT_W} text-right`}>
                {factCell(factTally)}
              </Figure>
            </Box>
            {caption && (
              <Text data-card-caption className="relative text-xs text-ink-2">
                {t(caption.key, "params" in caption ? caption.params : undefined)}
              </Text>
            )}
          </Box>
        );
      })}
      {SPLIT_ROWS.map(({ field, labelKey }) => (
        <Box key={field} data-card-row className={CARD_ROW_CLASS}>
          <Text data-card-name className="relative min-w-0 flex-1 truncate text-md">
            {t(labelKey)}
          </Text>
          <Figure data-card-amount size="sm" className={`relative ${AMOUNT_W} text-right`}>
            {humanizeNumber(facts[field])}
          </Figure>
          <Figure data-card-share size="sm" tone="muted" className={`relative ${SHARE_W} text-right`}>
            {share(facts[field], total)}
          </Figure>
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
 * be arbitrarily long. The "Damage facts" section ignores `detailed` — it is
 * already fixed-size, so there is nothing for Ctrl to lift. */
export const HoverCardBody = ({ sections, detailed = false, amountKey, format, damageFacts }: HoverCardBodyProps) => (
  <Box>
    {sections.map((section) => (
      <Section key={section.headingKey} {...section} detailed={detailed} amountKey={amountKey} format={format} />
    ))}
    {damageFacts && <DamageFactsSection facts={damageFacts.facts} total={damageFacts.total} />}
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
  if (!body.damageFacts && body.sections.every((section) => section.entries.length === 0)) {
    return children;
  }

  return (
    <CursorCard
      content={content}
      testId="metric-hover-card"
      // Surface (colours, border, shadow, clipping) from the shared panel the
      // aura tiles' card also wears; only the SIZE is this card's own — a
      // breakdown needs a width floor an effect name does not.
      //
      // No token class, though the card portals to document.body: every token
      // is on :root, and custom properties inherit down from there to a portal
      // as readily as to anything else.
      className={HOVER_PANEL_CLASS}
      style={{ minWidth: 300, maxWidth: 420, maxHeight: "70vh" }}
    >
      {children}
    </CursorCard>
  );
};
