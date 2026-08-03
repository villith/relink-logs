import { Box, Group, Text } from "@mantine/core";
import { cloneElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { SkillTargetState } from "@/types";
import { humanizeNumbers, translateEnemyType } from "@/utils";

import { rafThrottle } from "./rafThrottle";

// The tooltip grows up and to the right of the cursor, sitting this many pixels
// clear of it; kept `PADDING` in from the viewport edges (matching the shift
// behaviour the old Mantine `Tooltip.Floating` used).
const CURSOR_OFFSET = 6;
const VIEWPORT_PADDING = 5;

/** Hover breakdown of a quest-view meter row (player or skill): the row's
 * damage split by enemy, styled as a mini damage meter — one bar per enemy
 * with total-damage and share columns. Follows the cursor, growing up and to
 * the right from it. The breakdown comes from the same filtered reparse as
 * the row's numbers, so it already honors the target and time-window filters.
 * Renders bare children for payloads without breakdown data (live meters pass
 * empty targets).
 *
 * Cursor tracking is rAF-throttled and the breakdown is mounted only while
 * hovered: a quest view holds one of these per player row plus one per skill
 * row, and the old cursor-following tooltip repositioned (a forced reflow) on
 * every `mousemove` — up to ~1000/sec on high-polling-rate mice — over a big,
 * always-mounted breakdown subtree, which janked hard on data-heavy logs. */
export const SkillTargetTooltip = ({
  label,
  targets,
  showFullValues,
  color,
  children,
}: {
  /** The hovered row's display name (player or skill), shown in the header. */
  label: string;
  targets: SkillTargetState[];
  showFullValues: boolean;
  /** Bar fill — the hovered row's player color, so the tooltip reads as part of that row. */
  color: string;
  children: React.ReactElement;
}) => {
  const totalDamage = targets.reduce((total, target) => total + target.totalDamage, 0);

  const [opened, setOpened] = useState(false);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  // Cached once per open: the content is fixed while a single row is hovered, so
  // clamping needs no per-move measurement (which would reflow every frame).
  const [size, setSize] = useState({ width: 0, height: 0 });
  const floatingRef = useRef<HTMLDivElement>(null);

  // Coalesce a burst of mousemove events into one cursor commit per frame.
  const commitCursor = useMemo(() => rafThrottle((x: number, y: number) => setCursor({ x, y })), []);
  useEffect(() => () => commitCursor.cancel(), [commitCursor]);

  // Built once per data change, not per cursor frame: a reposition re-renders
  // this component every frame, and only the outer box's position should change
  // — the enemy list is referentially stable so React skips re-diffing it.
  const breakdown = useMemo(
    () => (
      <Box miw={260} maw={360}>
        <Text size="xs" fw={600} mb={4}>
          {label}
        </Text>
        {targets.map((target, index) => {
          const percentage = totalDamage > 0 ? (target.totalDamage / totalDamage) * 100 : 0;
          const [damage, damageUnit] = humanizeNumbers(target.totalDamage);

          return (
            <Box key={index} pos="relative" px={8} py={2} mb={2} style={{ overflow: "hidden", borderRadius: 3 }}>
              <Box
                pos="absolute"
                style={{ left: 0, top: 0, bottom: 0, width: `${percentage}%`, backgroundColor: color, opacity: 0.75 }}
              />
              <Group gap={12} wrap="nowrap" pos="relative">
                <Text size="xs" truncate style={{ flex: 1 }}>
                  {translateEnemyType(target.enemyType)}
                </Text>
                <Text size="xs" ta="right" style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                  {showFullValues ? target.totalDamage.toLocaleString() : `${damage}${damageUnit}`}
                </Text>
                <Text size="xs" ta="right" w={38} style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                  {percentage.toFixed(0)}%
                </Text>
              </Group>
            </Box>
          );
        })}
      </Box>
    ),
    [label, targets, totalDamage, showFullValues, color]
  );

  // Re-measure whenever the box opens OR its content changes (`breakdown` is a
  // fresh element only when the enemy list changes). Keying on `[opened]` alone
  // left the cached size stale when a row's targets changed mid-hover (e.g.
  // scrubbing the time-window slider), mis-positioning the grow-up/edge clamps.
  useLayoutEffect(() => {
    if (opened && floatingRef.current) {
      const rect = floatingRef.current.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    }
  }, [opened, breakdown]);

  // Dismiss on scroll/wheel, the way the replaced Mantine floating tooltip did:
  // a `position: fixed` tooltip would otherwise stay frozen over a now-different
  // row when the user scrolls the table without moving the mouse.
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

  if (targets.length === 0 || totalDamage === 0) {
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

  // Position from the committed cursor, clamped to the viewport. Held invisible
  // until measured so the first frame (size unknown) can't flash in the wrong
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
      {/* `react-dom`'s portal, not Mantine's `<Portal>`: Mantine's renders null
          on its first render and only mounts its children after its own effect
          has run, so the measure below (a layout effect keyed on `opened`) ran
          against a ref that was still null — the box stayed `hidden` for the
          whole hover. A raw portal mounts in the same commit, so the ref is
          attached by the time the layout effect measures it. */}
      {opened &&
        createPortal(
          <Box
            ref={floatingRef}
            data-testid="skill-target-tooltip"
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
              padding: "6px 8px",
              boxShadow: "var(--mantine-shadow-md)",
            }}
          >
            {breakdown}
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
