import { Box, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

/** The redesigned quest view. Built up across Tasks 13–18; until then it says
 * so, and the switcher gets you back to Classic. */
export const AnalysisView = () => {
  const { t } = useTranslation();

  return (
    <Box>
      <Text size="sm">{t("ui.logs.view-mode.analysis-under-construction")}</Text>
    </Box>
  );
};
