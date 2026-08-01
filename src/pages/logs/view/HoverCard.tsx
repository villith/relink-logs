import { Box, Group, Stack, Text } from "@mantine/core";
import { cloneElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { rafThrottle } from "@/components/rafThrottle";
import { humanizeNumbers } from "@/utils";

// The card grows up and to the right of the cursor, sitting this many pixels
// clear of it and kept this far in from the viewport edges. Both copied from
// SkillTargetTooltip, which this replaces.
const CURSOR_OFFSET = 6;
const VIEWPORT_PADDING = 5;

export type BreakdownEntry = { key: string; label: string; value: number };

export type HoverCardBodyProps = {
  title: string;
  subtitle: string;
  byAbility: BreakdownEntry[];
  byTarget: BreakdownEntry[];
};

const Half = ({ headingKey, entries, color }: { headingKey: string; entries: BreakdownEntry[]; color: string }) => {
  const { t } = useTranslation();
  if (entries.length === 0) return null;

  const largest = Math.max(...entries.map((entry) => entry.value));

  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed" tt="uppercase">
        {t(headingKey)}
      </Text>
      {entries.map((entry) => {
        const [n, suffix] = humanizeNumbers(entry.value);
        return (
          <Group key={entry.key} gap={6} wrap="nowrap">
            <Text size="xs" w={78} truncate>
              {entry.label}
            </Text>
            <Box style={{ flex: 1, height: 8, borderRadius: 2, background: "var(--mantine-color-dark-5)" }}>
              <Box
                style={{
                  width: largest === 0 ? "0%" : `${(entry.value / largest) * 100}%`,
                  height: "100%",
                  borderRadius: 2,
                  background: color,
                }}
              />
            </Box>
            <Text size="xs" w={46} ta="right" style={{ fontVariantNumeric: "tabular-nums" }}>
              {n}
              {suffix}
            </Text>
          </Group>
        );
      })}
    </Stack>
  );
};

/** The card's contents, separated from its positioning so it can be tested
 * without a cursor. */
export const HoverCardBody = ({ title, subtitle, byAbility, byTarget }: HoverCardBodyProps) => (
  <Stack gap={8} p="xs">
    <Stack gap={0}>
      <Text size="sm" fw={600}>
        {title}
      </Text>
      <Text size="xs" c="dimmed">
        {subtitle}
      </Text>
    </Stack>
    <Half headingKey="ui.logs.hover-by-ability" entries={byAbility} color="var(--mantine-color-blue-5)" />
    <Half headingKey="ui.logs.hover-by-target" entries={byTarget} color="var(--mantine-color-violet-5)" />
  </Stack>
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
  useLayoutEffect(() => {
    if (opened && floatingRef.current) {
      const rect = floatingRef.current.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    }
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

  if (body.byAbility.length === 0 && body.byTarget.length === 0) {
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
            style={{
              position: "fixed",
              top: Math.round(top),
              left: Math.round(left),
              zIndex: 300,
              pointerEvents: "none",
              visibility: size.height > 0 ? "visible" : "hidden",
              background: "var(--mantine-color-dark-6)",
              color: "var(--mantine-color-white)",
              borderRadius: "var(--mantine-radius-sm)",
              boxShadow: "var(--mantine-shadow-md)",
              minWidth: 260,
              maxWidth: 360,
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
