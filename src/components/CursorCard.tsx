import { Box } from "@mantine/core";
import { cloneElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { rafThrottle } from "./rafThrottle";

// The card grows up out of the cursor — and to the right or the left of it, per
// `placement` — sitting this many pixels clear of it, and is kept this far in
// from the viewport edges (matching the shift behaviour the old Mantine
// `Tooltip.Floating` had).
const CURSOR_OFFSET = 6;
const VIEWPORT_PADDING = 5;

/** Which way the panel grows out of the cursor. It always grows UP; this is the
 * horizontal half.
 *
 * `top-right` suits a cell with room to its right. `top-left` is for one that
 * has none — the rightmost column of a table, where growing right only feeds
 * the viewport clamp and parks the panel at the window edge instead of beside
 * the thing it explains. */
export type CursorCardPlacement = "top-right" | "top-left";

/** A panel that follows the cursor while its child is hovered.
 *
 * Both hover breakdowns in the app are this shell — the quest view's per-row
 * damage tooltip and the analysis view's metric hover card — and the behaviours
 * it carries are hard-won rather than incidental:
 *
 * - The panel is mounted only while hovered, and cursor tracking is
 *   rAF-throttled. A quest view holds one of these per player row plus one per
 *   skill row, and repositioning on every `mousemove` forced a reflow over a
 *   large subtree — up to ~1000/sec on a high-polling-rate mouse.
 * - Size is measured once per open and re-measured when `content` changes, so a
 *   row whose data shifts mid-hover (scrubbing the window slider) cannot keep a
 *   stale size and mis-place the grow-up and edge clamps.
 * - The measure effect bails when nothing moved. Load-bearing, not a
 *   micro-optimisation: a caller may memoize `content` on a props object
 *   rebuilt every render, so the effect can fire every render, and storing a
 *   fresh {width, height} unconditionally would schedule another render each
 *   time — an unbounded loop.
 * - It dismisses on scroll and wheel. A `position: fixed` panel would otherwise
 *   stay frozen over a now-different row when the table scrolls under a still
 *   mouse.
 * - It portals through `react-dom` rather than Mantine's `<Portal>`, whose
 *   children mount only after its own effect has run — the layout effect would
 *   measure a null ref and leave the panel hidden for the whole hover.
 *
 * The caller decides whether there is anything to show: render `children`
 * directly instead of this when there is not, rather than opening an empty
 * panel.
 */
export const CursorCard = ({
  content,
  children,
  testId,
  className,
  style,
  placement = "top-right",
}: {
  /** Memoize this. The component re-renders on every committed cursor frame,
   * and only the outer box's position should change — a referentially stable
   * subtree is one React skips re-diffing. */
  content: React.ReactNode;
  /** The hovered element. Its own mouse handlers are preserved. */
  children: React.ReactElement;
  testId: string;
  className?: string;
  /** The panel's own chrome — background, border, sizing. Positioning,
   * stacking and visibility are owned here and cannot be overridden. */
  style?: CSSProperties;
  /** See [`CursorCardPlacement`]. Defaults to growing right. */
  placement?: CursorCardPlacement;
}) => {
  const [opened, setOpened] = useState(false);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  // Cached once per open: the content is fixed while one row is hovered, so
  // clamping needs no per-move measurement (which would reflow every frame).
  const [size, setSize] = useState({ width: 0, height: 0 });
  const floatingRef = useRef<HTMLDivElement>(null);

  // Coalesce a burst of mousemove events into one cursor commit per frame.
  const commitCursor = useMemo(() => rafThrottle((x: number, y: number) => setCursor({ x, y })), []);
  useEffect(() => () => commitCursor.cancel(), [commitCursor]);

  useLayoutEffect(() => {
    if (!opened || !floatingRef.current) return;
    const rect = floatingRef.current.getBoundingClientRect();
    setSize((previous) =>
      previous.width === rect.width && previous.height === rect.height
        ? previous
        : { width: rect.width, height: rect.height }
    );
  }, [opened, content]);

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
  // until measured so the first frame (size unknown) cannot flash in the wrong
  // spot before the grow-up offset is known.
  //
  // The anchored edge is whichever one faces the cursor: the panel's left edge
  // sits right of it, or its right edge sits left of it. The clamp then applies
  // equally to both, so a `top-left` card near the LEFT viewport edge still
  // slides back into view.
  const anchoredLeft = placement === "top-left" ? cursor.x - CURSOR_OFFSET - size.width : cursor.x + CURSOR_OFFSET;
  const left = Math.max(VIEWPORT_PADDING, Math.min(anchoredLeft, window.innerWidth - size.width - VIEWPORT_PADDING));
  const top = Math.max(
    VIEWPORT_PADDING,
    Math.min(cursor.y - CURSOR_OFFSET - size.height, window.innerHeight - size.height - VIEWPORT_PADDING)
  );

  return (
    <>
      {opened &&
        createPortal(
          <Box
            ref={floatingRef}
            data-testid={testId}
            className={className}
            style={{
              ...style,
              position: "fixed",
              top: Math.round(top),
              left: Math.round(left),
              zIndex: 300,
              pointerEvents: "none",
              visibility: size.height > 0 ? "visible" : "hidden",
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
