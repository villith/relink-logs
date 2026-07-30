import { HeaderSegments } from "@/components/HeaderSegments";
import { Table } from "@/components/Table";
import useSettings from "@/pages/useSettings";
import { MeterColumns } from "@/types";
import { Paper, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { PREVIEW_ENCOUNTER, PREVIEW_HEADER_TOKENS, PREVIEW_PARTY } from "./previewFixture";

/** No-op sort handlers: the preview is a picture, not a control. */
const noop = () => {};

/**
 * A live preview of the meter as currently configured.
 *
 * Renders the REAL Table and HeaderSegments rather than a mock-up of them — a
 * preview that can drift from the thing it previews is worse than none. Both
 * read the same store, so this updates as the user types, and it inherits
 * streamer mode, the column selection and full-values for free.
 */
export const MeterPreview = () => {
  const { t } = useTranslation();
  const { transparency, header_segments } = useSettings();

  return (
    <Stack gap={4}>
      <Text size="md" fw={700}>
        {t("ui.meter-preview")}
      </Text>
      <Paper withBorder p={0} style={{ pointerEvents: "none", overflow: "hidden" }}>
        {/* `.titlebar` is position: fixed for the real overlay — pinned static
            here so it stays inside the card instead of the settings window. */}
        <div className="titlebar transparent-bg font-sm" style={{ position: "static" }}>
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
          </div>
        </div>
        <div style={{ background: `rgba(22, 22, 22, ${transparency})` }}>
          <Table
            encounterState={PREVIEW_ENCOUNTER}
            partyData={PREVIEW_PARTY}
            sortType={MeterColumns.DPS}
            sortDirection="desc"
            setSortType={noop}
            setSortDirection={noop}
          />
        </div>
      </Paper>
    </Stack>
  );
};
