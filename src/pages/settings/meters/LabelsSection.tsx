import { TokenField } from "@/components/tokenField/TokenField";
import { TokenPalette, TokenPaletteProvider } from "@/components/tokenField/TokenPalette";
import { usedTokens } from "@/labelTemplate";
import useSettings from "@/pages/useSettings";
import { DEFAULT_PLAYER_LABEL } from "@/stores/useMeterSettingsStore";
import { PLAYER_LABEL_TOKENS } from "@/utils";
import { Anchor, Group, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

/**
 * How the meter writes a player's name.
 *
 * Laid out exactly like the overlay header editor — palette, then field —
 * because it is the same control doing the same job on a different template,
 * and two orders for one interaction is one to learn twice. The inline rendered
 * sample the field used to carry is gone with it: the live meter preview beside
 * this section already shows the names as they will read.
 */
export const LabelsSection = () => {
  const { t } = useTranslation();
  const { player_label_template, setMeterSettings } = useSettings();

  const reset = () => setMeterSettings({ player_label_template: DEFAULT_PLAYER_LABEL });
  const used = usedTokens([player_label_template]);

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
        <TokenPalette tokens={PLAYER_LABEL_TOKENS} used={used} />
        <TokenField
          label={t("ui.player-label-template")}
          value={player_label_template}
          onChange={(value) => setMeterSettings({ player_label_template: value })}
          tokens={PLAYER_LABEL_TOKENS}
          used={used}
        />
      </Stack>
    </TokenPaletteProvider>
  );
};
