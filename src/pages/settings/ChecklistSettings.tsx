import useChecklistSettings from "@/pages/useChecklistSettings";
import { Button, Stack, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { ChecklistSection } from "./ChecklistSection";

/** Settings → Checklist: the Builds-tab checklist criteria, one editable group
 * for the player's own sigils and one for AI companions. */
const ChecklistSettings = () => {
  const { t } = useTranslation();
  const checklist = useChecklistSettings();

  return (
    <Stack gap="md" pr="md">
      <Title order={4}>{t("ui.checklist-settings.title")}</Title>
      <ChecklistSection
        group="build"
        legend={t("ui.checklist-settings.sigils-section")}
        addPlaceholder={t("ui.checklist-settings.add-trait")}
        checklist={checklist}
      />
      <ChecklistSection
        group="ai"
        legend={t("ui.checklist-settings.ai-section")}
        addPlaceholder={t("ui.checklist-settings.add-trait")}
        checklist={checklist}
      />
      <Button variant="default" onClick={checklist.reset} style={{ alignSelf: "flex-start" }}>
        {t("ui.checklist-settings.reset")}
      </Button>
    </Stack>
  );
};

export default ChecklistSettings;
