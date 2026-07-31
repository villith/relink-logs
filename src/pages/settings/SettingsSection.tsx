import { Anchor, Group, Stack, Text } from "@mantine/core";
import { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * A settings section: its heading, its controls, and — where the section has
 * defaults worth returning to — the affordance that restores them.
 *
 * Every section drew this heading itself, and the ones with a reset link built
 * it out of the same five props each time. Two shapes of one control can drift
 * apart in wording or weight while still claiming to be the same thing, which
 * is exactly what a settings page cannot afford: the reset link is a
 * destructive action, and it should look identical wherever it appears.
 *
 * `title` arrives already translated, matching how the sections passed it to
 * `Text` before.
 *
 * NOT every heading on a settings page is one of these yet: the column editors
 * on the Overlay tab and the Logs block in General still write the heading out
 * themselves, because they sit directly in a `Stack gap="lg"` and wrapping them
 * would retune the spacing between their controls. Restyling this component
 * therefore does not reach them — convert them first, deliberately, rather than
 * assuming it did.
 */
export const SettingsSection = ({
  title,
  onReset,
  children,
}: {
  /** Heading text, already translated. */
  title: string;
  /** Omitted by a section with nothing to reset — it then renders no link. */
  onReset?: () => void;
  children: ReactNode;
}) => {
  const { t } = useTranslation();

  const heading = (
    <Text size="md" fw={700}>
      {title}
    </Text>
  );

  return (
    <Stack gap="xs">
      {onReset ? (
        <Group justify="space-between">
          {heading}
          <Anchor component="button" type="button" size="xs" onClick={onReset}>
            {t("ui.reset-to-defaults")}
          </Anchor>
        </Group>
      ) : (
        heading
      )}
      {children}
    </Stack>
  );
};
