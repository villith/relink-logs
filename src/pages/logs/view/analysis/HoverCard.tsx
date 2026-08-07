import { Box, Text } from "@mantine/core";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { CursorCard } from "@/components/CursorCard";
import { share } from "@/utils";

import "./analysis.css";

/** One row of a card section. `color` overrides the section's colour for this
 * row alone — a "by source" section is per player, and one colour across every
 * row of it would say nothing about who dealt what. `icon` is the entity's
 * art, where it has any; rows without stay text-only rather than reserving a
 * blank box. */
export type BreakdownEntry = { key: string; label: string; value: number; color?: string; icon?: string };

/** One stacked section of the card: a heading naming the dimension, then its
 * rows. `color` is the entity's colour — ability rows take their owner's, target
 * rows take the target's — so colour keeps following the entity. */
export type CardSection = {
  headingKey: string;
  color: string;
  entries: BreakdownEntry[];
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
} & CardAmount;

/** WCL's cap: a section shows its top five entries and stays silent about
 * the rest — no "+N more" row. Applied after the builders' descending sort,
 * so the five are always the largest. */
export const SECTION_ENTRY_CAP = 5;

const Section = ({ headingKey, color, entries, amountKey, format }: CardSection & CardAmount) => {
  const { t } = useTranslation();
  if (entries.length === 0) return null;

  // Top five only; every builder sorts descending, so the slice IS the
  // largest five. `total` stays over the FULL list — a capped section's
  // shares must not re-normalize to 100%.
  const shown = entries.slice(0, SECTION_ENTRY_CAP);
  // Scaled to the section's largest entry, not its total: a three-row target
  // list scaled to the total would be three slivers.
  const largest = Math.max(...shown.map((entry) => entry.value));
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);

  return (
    <Box className="analysis-card-section">
      <Box className="analysis-card-head">
        <Text className="analysis-label" style={{ flex: 1 }}>
          {t(headingKey)}
        </Text>
        {/* Amount then share, matching the table above it: the amount is what
            the row is about and the share qualifies it. */}
        <Text className="analysis-label" style={{ width: 64, textAlign: "right" }}>
          {t(amountKey)}
        </Text>
        <Text className="analysis-label" style={{ width: 52, textAlign: "right" }}>
          {t("ui.logs.column-share")}
        </Text>
      </Box>
      {shown.map((entry) => {
        return (
          <Box key={entry.key} className="analysis-card-row">
            <Box
              data-card-bar
              className="analysis-bar"
              style={{
                width: largest === 0 ? "0%" : `${(entry.value / largest) * 100}%`,
                backgroundColor: entry.color ?? color,
              }}
            />
            <Text className="analysis-card-name">
              {entry.icon && <img className="analysis-card-icon" src={entry.icon} alt="" />}
              {entry.label}
            </Text>
            <Text className="analysis-card-amount">{format(entry.value)}</Text>
            <Text className="analysis-card-share">{share(entry.value, total)}</Text>
          </Box>
        );
      })}
    </Box>
  );
};

/** The card's contents, separated from its positioning so it can be tested
 * without a cursor.
 *
 * Each section truncates to its top `SECTION_ENTRY_CAP` entries; the
 * portal's 70vh max-height stays as the guard behind that, since a card can
 * still stack several sections. */
export const HoverCardBody = ({ sections, amountKey, format }: HoverCardBodyProps) => (
  <Box>
    {sections.map((section) => (
      <Section key={section.headingKey} {...section} amountKey={amountKey} format={format} />
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
  // Memoized because CursorCard re-renders on every committed cursor frame and
  // only its outer box should move. The deps are a props object rebuilt every
  // render, so this is a fresh element each time — which is exactly why
  // CursorCard's measure effect has to bail when the size has not changed.
  const content = useMemo(() => <HoverCardBody {...body} />, [body]);

  // Nothing to explain — render the row alone rather than an empty card.
  if (body.sections.every((section) => section.entries.length === 0)) {
    return children;
  }

  return (
    <CursorCard
      content={content}
      testId="metric-hover-card"
      className="analysis-tokens"
      style={{
        color: "var(--mantine-color-white)",
        borderRadius: "var(--mantine-radius-sm)",
        boxShadow: "var(--mantine-shadow-md)",
        minWidth: 300,
        maxWidth: 420,
        maxHeight: "70vh",
        overflow: "hidden",
        border: "1px solid var(--an-line-strong)",
        backgroundColor: "var(--an-panel)",
      }}
    >
      {children}
    </CursorCard>
  );
};
