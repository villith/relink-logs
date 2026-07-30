import { ColumnEditor } from "@/components/ColumnEditor";
import { useColumnControls } from "@/components/useColumnControls";
import { Box, Divider, Flex, SegmentedControl, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { BarAppearanceSection } from "./BarAppearanceSection";
import { ColorsSection } from "./ColorsSection";
import { HeaderSegmentsEditor } from "./HeaderSegmentsEditor";
import { LabelsSection } from "./LabelsSection";
import { MeterPreview } from "./MeterPreview";
import { NamesSection } from "./NamesSection";
import { ValuesSection } from "./ValuesSection";

/** Shared settings apply to both meters, so the preview asks which one you want
 * to judge them against rather than silently picking one. */
const ScopedPreview = () => {
  const { t } = useTranslation();
  const [scope, setScope] = useState<"overlay" | "logs">("overlay");

  return (
    <Stack gap="xs">
      <SegmentedControl
        size="xs"
        value={scope}
        onChange={(value) => setScope(value as "overlay" | "logs")}
        data={[
          { value: "overlay", label: t("ui.preview-scope-overlay") },
          { value: "logs", label: t("ui.preview-scope-logs") },
        ]}
      />
      <MeterPreview live={scope === "overlay"} showHeader={scope === "overlay"} />
    </Stack>
  );
};

/** Settings → Meters: how the meter renders, in the overlay and in the Logs
 * quest details.
 *
 * Composition and layout only — each group owns its own controls. Options run
 * down the left; the preview sits in a sticky column on the right so it stays
 * on screen while the user scrolls the options past it. Below `lg` the two
 * stack, preview first, since there is no room for a side-by-side. */
const MeterSettings = () => {
  const { t } = useTranslation();
  const { overlayPlayer, overlaySkill } = useColumnControls();

  return (
    <Stack gap="md" pr="md">
      <Title order={4}>{t("ui.meter-settings")}</Title>
      <Flex gap="lg" align="flex-start" direction={{ base: "column-reverse", lg: "row" }}>
        <Stack gap="lg" style={{ flex: 1, minWidth: 0, width: "100%" }}>
          {/* Full width rather than paired side by side: the preview already
              claims a column, and splitting what is left again squeezes the
              four colour swatches to the point their labels wrap. Height is
              cheap here — the preview is sticky, so a longer column costs the
              user nothing. */}
          <ColorsSection />
          <BarAppearanceSection />
          <Divider />
          <LabelsSection />
          <HeaderSegmentsEditor />
          <Divider />
          {/* These two are short checkbox lists, so they still pair up fine. */}
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
            <NamesSection />
            <ValuesSection />
          </SimpleGrid>
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
        {/* Sticky against the page scroll: the settings shell puts no overflow
            container between here and the window, so `top` is measured from the
            viewport — and must therefore clear the fixed AppShell header, or the
            preview slides underneath it. Read from Mantine's own header-height
            variable so the two cannot drift apart. A flex item's containing block
            is the flex row, which is as tall as the options column — that is the
            room the preview has to travel in. */}
        {/* Width is not arbitrary: the meter table needs a 120px name column
            plus one fixed 4.5rem column per visible value, so with the default
            six it wants ~600px before the name starts truncating. Narrower
            viewports get less and the name ellipsises — which is exactly what a
            real overlay that narrow would do, so the preview stays honest. */}
        <Box
          w={{ base: "100%", lg: 520, xl: 620 }}
          style={{
            flexShrink: 0,
            position: "sticky",
            top: "calc(var(--app-shell-header-height, 50px) + var(--mantine-spacing-sm))",
          }}
        >
          <ScopedPreview />
        </Box>
      </Flex>
    </Stack>
  );
};

export default MeterSettings;
