import { ColumnEditor } from "@/components/ColumnEditor";
import { useColumnControls } from "@/components/useColumnControls";
import { Divider, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { BarAppearanceSection } from "./BarAppearanceSection";
import { ColorsSection } from "./ColorsSection";
import { HeaderSegmentsEditor } from "./HeaderSegmentsEditor";
import { LabelsSection } from "./LabelsSection";
import { MeterPreview } from "./MeterPreview";
import { NamesSection } from "./NamesSection";
import { ValuesSection } from "./ValuesSection";

/** Settings → Meters: how the meter renders, in the overlay and in the Logs
 * quest details. Composition and layout only — each group owns its own
 * controls, and the preview at the top reflects all of them. */
const MeterSettings = () => {
  const { t } = useTranslation();
  const { overlayPlayer, overlaySkill } = useColumnControls();

  return (
    <Stack gap="lg" pr="md">
      <Title order={4}>{t("ui.meter-settings")}</Title>
      <MeterPreview />
      {/* Colours and bar style are one visual decision, so they sit together. */}
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <ColorsSection />
        <BarAppearanceSection />
      </SimpleGrid>
      <Divider />
      <LabelsSection />
      <HeaderSegmentsEditor />
      <Divider />
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg">
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
  );
};

export default MeterSettings;
