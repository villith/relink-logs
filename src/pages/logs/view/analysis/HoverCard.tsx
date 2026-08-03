import { Box, Text } from "@mantine/core";
import { cloneElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { rafThrottle } from "@/components/rafThrottle";
import { humanizeNumbers } from "@/utils";

import "./analysis.css";

// The card grows up and to the right of the cursor, sitting this many pixels
// clear of it and kept this far in from the viewport edges. Both copied from
// SkillTargetTooltip, which this replaces.
const CURSOR_OFFSET = 6;
const VIEWPORT_PADDING = 5;

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

export type HoverCardBodyProps = {
  sections: CardSection[];
};

const Section = ({ headingKey, color, entries }: CardSection) => {
  const { t } = useTranslation();
  if (entries.length === 0) return null;

  // Scaled to the section's largest entry, not its total: a three-row target
  // list scaled to the total would be three slivers.
  const largest = Math.max(...entries.map((entry) => entry.value));
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
          {t("ui.meter-columns.damage")}
        </Text>
        <Text className="analysis-label" style={{ width: 52, textAlign: "right" }}>
          {t("ui.logs.column-share")}
        </Text>
      </Box>
      {entries.map((entry) => {
        const [n, suffix] = humanizeNumbers(entry.value);
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
            <Text className="analysis-card-amount">
              {n}
              {suffix}
            </Text>
            <Text className="analysis-card-share">
              {total === 0 ? "0.0%" : `${((entry.value / total) * 100).toFixed(1)}%`}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
};

/** The card's contents, separated from its positioning so it can be tested
 * without a cursor.
 *
 * Long lists are capped by the portal's max-height rather than truncated per
 * section, so the card never grows past 70vh. A party's top damage dealer can
 * carry 30+ abilities, which measured 873px in a 1124px viewport before the
 * cap. */
export const HoverCardBody = ({ sections }: HoverCardBodyProps) => (
  <Box>
    {sections.map((section) => (
      <Section key={section.headingKey} {...section} />
    ))}
  </Box>
);

/** [`HoverCardBody`] in a cursor-following portal.
 *
 * The two hard-won behaviours here come from `SkillTargetTooltip`, which this
 * replaces, and are not incidental: the body is mounted only while hovered, and
 * cursor tracking is rAF-throttled. A quest view holds one of these per row, and
 * repositioning on every `mousemove` forced a reflow over a large subtree —
 * up to ~1000/sec on a high-polling-rate mouse. */
export const HoverCard = ({
  children,
  ...body
}: HoverCardBodyProps & {
  children: React.ReactElement;
}) => {
  const [opened, setOpened] = useState(false);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  // Cached once per open: the content is fixed while one row is hovered, so
  // clamping needs no per-move measurement (which would reflow every frame).
  const [size, setSize] = useState({ width: 0, height: 0 });
  const floatingRef = useRef<HTMLDivElement>(null);

  const commitCursor = useMemo(() => rafThrottle((x: number, y: number) => setCursor({ x, y })), []);
  useEffect(() => () => commitCursor.cancel(), [commitCursor]);

  const content = useMemo(() => <HoverCardBody {...body} />, [body]);

  // Re-measured when the card opens AND when its content changes, so a row
  // whose data shifts mid-hover (scrubbing the window) does not keep a stale
  // size and mis-place the grow-up and edge clamps.
  //
  // The bail-out is load-bearing, not a micro-optimisation: `content` is
  // memoized on a props object rebuilt every render, so this effect fires on
  // every render, and storing a fresh {width, height} unconditionally would
  // schedule another render each time — an unbounded loop. Returning the
  // previous object when nothing moved lets React skip the update.
  useLayoutEffect(() => {
    if (!opened || !floatingRef.current) return;
    const rect = floatingRef.current.getBoundingClientRect();
    setSize((previous) =>
      previous.width === rect.width && previous.height === rect.height
        ? previous
        : { width: rect.width, height: rect.height }
    );
  }, [opened, content]);

  // A position: fixed card would otherwise stay frozen over a now-different row
  // when the table is scrolled without moving the mouse.
  useEffect(() => {
    if (!opened) return;
    const close = () => setOpened(false);
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("scroll", close, { capture: true, passive: true });
    return () => {
      window.removeEventListener("wheel", close);
      window.removeEventListener("scroll", close, { capture: true });
    };
  }, [opened]);

  // Nothing to explain — render the row alone rather than an empty card.
  if (body.sections.every((section) => section.entries.length === 0)) {
    return children;
  }

  const handleMouseEnter = (event: React.MouseEvent) => {
    children.props.onMouseEnter?.(event);
    setCursor({ x: event.clientX, y: event.clientY });
    setOpened(true);
  };
  const handleMouseMove = (event: React.MouseEvent) => {
    children.props.onMouseMove?.(event);
    commitCursor(event.clientX, event.clientY);
  };
  const handleMouseLeave = (event: React.MouseEvent) => {
    children.props.onMouseLeave?.(event);
    commitCursor.cancel();
    setOpened(false);
  };

  // Held invisible until measured, so the first frame cannot flash in the wrong
  // spot before the grow-up offset is known.
  const left = Math.max(
    VIEWPORT_PADDING,
    Math.min(cursor.x + CURSOR_OFFSET, window.innerWidth - size.width - VIEWPORT_PADDING)
  );
  const top = Math.max(
    VIEWPORT_PADDING,
    Math.min(cursor.y - CURSOR_OFFSET - size.height, window.innerHeight - size.height - VIEWPORT_PADDING)
  );

  return (
    <>
      {/* A raw react-dom portal, not Mantine's <Portal>: Mantine's mounts its
          children only after its own effect has run, so the layout effect above
          would measure a null ref and leave the card hidden for the whole
          hover. */}
      {opened &&
        createPortal(
          <Box
            ref={floatingRef}
            data-testid="metric-hover-card"
            className="analysis-tokens"
            style={{
              position: "fixed",
              top: Math.round(top),
              left: Math.round(left),
              zIndex: 300,
              pointerEvents: "none",
              visibility: size.height > 0 ? "visible" : "hidden",
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
            {content}
          </Box>,
          document.body
        )}
      {cloneElement(children, {
        onMouseEnter: handleMouseEnter,
        onMouseMove: handleMouseMove,
        onMouseLeave: handleMouseLeave,
      })}
    </>
  );
};
