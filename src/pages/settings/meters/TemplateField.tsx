import { TokenField } from "@/components/tokenField/TokenField";
import { renderTemplate, type TemplateTokens } from "@/labelTemplate";
import { Code, Group, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

export type TemplateFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Token names this field accepts — anything else is flagged as a typo. */
  tokens: readonly string[];
  /** Sample values for the inline preview. Omit where a live preview of the
   * whole thing is already on screen; a second copy of it is noise. */
  sample?: TemplateTokens;
};

/**
 * A token-chip template field, optionally with a rendered preview beneath it.
 *
 * The unknown-token warning that used to live here is gone: an unrecognized
 * token now renders as a struck-through red chip in place, which says the same
 * thing where the problem actually is.
 */
export const TemplateField = ({ label, value, onChange, tokens, sample }: TemplateFieldProps) => {
  const { t } = useTranslation();
  const preview = sample ? renderTemplate(value, sample) : null;

  return (
    <Stack gap={4} style={{ flex: 1 }}>
      <TokenField label={label} value={value} onChange={onChange} tokens={tokens} />
      {preview !== null && (
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            {t("ui.template-preview")}
          </Text>
          <Code>{preview === "" ? t("ui.template-preview-empty") : preview}</Code>
        </Group>
      )}
    </Stack>
  );
};
