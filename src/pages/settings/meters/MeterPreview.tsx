import { HeaderSegments } from "@/components/HeaderSegments";
import { Table } from "@/components/Table";
import { TitlebarButtons } from "@/components/TitlebarButtons";
import useSettings from "@/pages/useSettings";
import { MeterColumns } from "@/types";
import { Paper, Stack, Text } from "@mantine/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PREVIEW_ENCOUNTER, PREVIEW_HEADER_TOKENS, PREVIEW_PARTY } from "./previewFixture";

/** No-op sort handlers: the preview is a picture, not a control. */
const noop = () => {};

/** Width at or below which the overlay drops its narrow-hidden pieces. Must
 * match the `max-width` in App.css — the real overlay reaches that rule through
 * a media query on its own window, which the preview cannot use. */
const NARROW_WIDTH = 325;

/**
 * Draws its children at an exact pixel size, scaled to fit the space available.
 *
 * The overlay is a window with a width, and most of what the settings page is
 * really asking about — does the header still fit, do the columns still fit —
 * only has an answer at a specific one. A preview that simply filled its column
 * would answer for the settings window's width instead, which is not a number
 * the user is editing.
 */
const OverlayFrame = ({ width, height, children }: { width: number; height: number; children: ReactNode }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Before the first measurement, assume it fits: rendering at 1 and correcting
  // is a smaller flash than rendering at 0 and growing.
  const scale = available > 0 ? Math.min(1, available / width) : 1;

  return (
    <div ref={ref}>
      {/* Holds the space the scaled frame actually occupies — a transform does
          not affect layout, so without this the content below would sit under
          an unscaled preview's worth of empty room. */}
      <div style={{ height: height * scale, overflow: "hidden" }}>
        <div
          className={width <= NARROW_WIDTH ? "overlay-preview-frame is-narrow" : "overlay-preview-frame"}
          style={{ width, height, transform: `scale(${scale})` }}
        >
          {children}
        </div>
      </div>
    </div>
  );
};

export type MeterPreviewProps = {
  /** Which column set to render: the overlay's, or the Logs window's. The two
   * are configured separately, so a preview that ignores this shows a meter the
   * user is not editing. Also selects the preview's shape — the overlay is a
   * sized window with a title bar, the Logs meter is a panel that fills what it
   * is given and has no title bar. */
  live: boolean;
};

/**
 * A live preview of the meter as currently configured.
 *
 * Renders the REAL Table and HeaderSegments rather than a mock-up of them — a
 * preview that can drift from the thing it previews is worse than none. Both
 * read the same store, so this updates as the user types, and it inherits
 * streamer mode and full-values for free. The column selection comes from
 * whichever set `live` picks, since the overlay and the Logs window keep their
 * own.
 */
export const MeterPreview = ({ live }: MeterPreviewProps) => {
  const { t } = useTranslation();
  const { transparency, header_segments, header_buttons, overlay_width, overlay_height } = useSettings();

  const surface = (
    <Paper
      withBorder
      p={0}
      style={{
        pointerEvents: "none",
        overflow: "hidden",
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {live && (
        /* `.titlebar` is position: fixed for the real overlay — pinned static
           here so it stays inside the card instead of the settings window. */
        <div className="titlebar transparent-bg font-sm" style={{ position: "static", flexShrink: 0 }}>
          <div className="titlebar-left">
            <HeaderSegments segments={header_segments} side="left" tokens={PREVIEW_HEADER_TOKENS} toneClass="hook-ok" />
          </div>
          <div className="titlebar-right">
            <HeaderSegments
              segments={header_segments}
              side="right"
              tokens={PREVIEW_HEADER_TOKENS}
              toneClass="hook-ok"
            />
            {/* No `actions`: the buttons are drawn so the header's real
                proportions show, but nothing is wired up. */}
            <TitlebarButtons visible={header_buttons} />
          </div>
        </div>
      )}
      <div style={{ background: `rgba(22, 22, 22, ${transparency})`, flex: 1, minHeight: 0, overflow: "hidden" }}>
        <Table
          live={live}
          encounterState={PREVIEW_ENCOUNTER}
          partyData={PREVIEW_PARTY}
          sortType={MeterColumns.DPS}
          sortDirection="desc"
          setSortType={noop}
          setSortDirection={noop}
        />
      </div>
    </Paper>
  );

  return (
    <Stack gap={4}>
      <Text size="md" fw={700}>
        {t("ui.meter-preview")}
      </Text>
      {live ? (
        <OverlayFrame width={overlay_width} height={overlay_height}>
          {surface}
        </OverlayFrame>
      ) : (
        surface
      )}
    </Stack>
  );
};
