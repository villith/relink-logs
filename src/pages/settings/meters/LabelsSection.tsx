import useSettings from "@/pages/useSettings";
import { PLAYER_LABEL_TOKENS } from "@/utils";
import { Code, Group, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { TemplateField } from "./TemplateField";

/** A filled party slot — the case worth previewing, since it exercises every token. */
const SAMPLE = { slot: "1", name: "Player", character: "Cagliostro" };

/** How the meter writes a player's name. */
export const LabelsSection = () => {
  const { t } = useTranslation();
  const { player_label_template, setMeterSettings } = useSettings();

  return (
    <Stack gap="xs">
      <Text size="md" fw={700}>
        {t("ui.meter-labels-section")}
      </Text>
      <TemplateField
        label={t("ui.player-label-template")}
        value={player_label_template}
        onChange={(value) => setMeterSettings({ player_label_template: value })}
        tokens={PLAYER_LABEL_TOKENS}
        sample={SAMPLE}
      />
      <Group gap={6}>
        <Text size="xs" c="dimmed">
          {t("ui.template-tokens")}
        </Text>
        {PLAYER_LABEL_TOKENS.map((token) => (
          <Code key={token}>{`{${token}}`}</Code>
        ))}
      </Group>
      <Text size="xs" c="dimmed">
        {t("ui.player-label-hint")}
      </Text>
    </Stack>
  );
};
