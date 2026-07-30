import { TokenPalette, TokenPaletteProvider } from "@/components/tokenField/TokenPalette";
import useSettings from "@/pages/useSettings";
import { DEFAULT_PLAYER_LABEL } from "@/stores/useMeterSettingsStore";
import { PLAYER_LABEL_TOKENS } from "@/utils";
import { Anchor, Group, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { TemplateField } from "./TemplateField";

/** A filled party slot — the case worth previewing, since it exercises every token. */
const SAMPLE = { slot: "1", name: "Player", character: "Cagliostro" };

/** How the meter writes a player's name. */
export const LabelsSection = () => {
  const { t } = useTranslation();
  const { player_label_template, setMeterSettings } = useSettings();

  const reset = () => setMeterSettings({ player_label_template: DEFAULT_PLAYER_LABEL });

  return (
    <TokenPaletteProvider>
      <Stack gap="xs">
        <Group justify="space-between">
          <Text size="md" fw={700}>
            {t("ui.meter-labels-section")}
          </Text>
          <Anchor component="button" type="button" size="xs" onClick={reset}>
            {t("ui.reset-to-defaults")}
          </Anchor>
        </Group>
        <TemplateField
          label={t("ui.player-label-template")}
          value={player_label_template}
          onChange={(value) => setMeterSettings({ player_label_template: value })}
          tokens={PLAYER_LABEL_TOKENS}
          sample={SAMPLE}
        />
        <TokenPalette tokens={PLAYER_LABEL_TOKENS} />
        <Text size="xs" c="dimmed">
          {t("ui.player-label-hint")}
        </Text>
      </Stack>
    </TokenPaletteProvider>
  );
};
