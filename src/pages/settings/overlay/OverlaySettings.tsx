import { ColumnEditor } from "@/components/ColumnEditor";
import { useColumnControls } from "@/components/useColumnControls";
import { HeaderSegmentsEditor } from "@/pages/settings/meters/HeaderSegmentsEditor";
import { MeterPreview } from "@/pages/settings/meters/MeterPreview";
import { Box, Divider, Flex, Stack, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { TransparencySection } from "./TransparencySection";

/** Settings → Overlay: the settings that apply ONLY to the always-on-top game
 * overlay — its background, its title bar, and its columns. Anything that also
 * changes the meter in the Logs window lives in Settings → Meters. */
const OverlaySettings = () => {
  const { t } = useTranslation();
  const { overlayPlayer, overlaySkill } = useColumnControls();

  return (
    <Stack gap="md" pr="md">
      <Title order={4}>{t("ui.overlay-settings")}</Title>
      <Flex gap="lg" align="flex-start" direction={{ base: "column-reverse", lg: "row" }}>
        <Stack gap="lg" style={{ flex: 1, minWidth: 0, width: "100%" }}>
          <TransparencySection />
          <Divider />
          <HeaderSegmentsEditor />
          <Divider />
          <Text size="md" fw={700}>
            {t("ui.overlay-columns-section")}
          </Text>
          <ColumnEditor
            title={t("ui.player-row")}
            droppableId="overlay-player-columns"
            translationPrefix="ui.meter-columns"
            items={overlayPlayer.items}
            onToggle={overlayPlayer.onToggle}
            onReorder={overlayPlayer.onReorder}
          />
          <ColumnEditor
            title={t("ui.skill-breakdown")}
            droppableId="overlay-skill-columns"
            translationPrefix="ui.skill-columns"
            items={overlaySkill.items}
            onToggle={overlaySkill.onToggle}
            onReorder={overlaySkill.onReorder}
          />
        </Stack>
        {/* Sticky against the page scroll, clearing the fixed AppShell header —
            see the matching note in MeterSettings for why `top` is measured
            from the viewport. */}
        <Box
          w={{ base: "100%", lg: 520, xl: 620 }}
          style={{
            flexShrink: 0,
            position: "sticky",
            top: "calc(var(--app-shell-header-height, 50px) + var(--mantine-spacing-sm))",
          }}
        >
          <MeterPreview live showHeader />
        </Box>
      </Flex>
    </Stack>
  );
};

export default OverlaySettings;
