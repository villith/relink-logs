import { renderTemplate, unknownTokens, type TemplateTokens } from "@/labelTemplate";
import { Code, Group, Stack, Text, TextInput } from "@mantine/core";
import { useTranslation } from "react-i18next";

export type TemplateFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Token names this field accepts — anything else is flagged as a typo. */
  tokens: readonly string[];
  /** Sample values used to render the inline preview. */
  sample: TemplateTokens;
};

/**
 * A template text input with a live rendered preview beneath it and a warning
 * for tokens that do not exist.
 *
 * The preview is the whole point: a template is unreadable until you see what
 * it produces, and the collapse rules mean the output is not a simple
 * substitution of the string you typed.
 */
export const TemplateField = ({ label, value, onChange, tokens, sample }: TemplateFieldProps) => {
  const { t } = useTranslation();
  const unknown = unknownTokens(value, tokens);
  const preview = renderTemplate(value, sample);

  return (
    <Stack gap={4} style={{ flex: 1 }}>
      <TextInput label={label} value={value} onChange={(event) => onChange(event.currentTarget.value)} />
      <Group gap="xs">
        <Text size="xs" c="dimmed">
          {t("ui.template-preview")}
        </Text>
        <Code>{preview === "" ? t("ui.template-preview-empty") : preview}</Code>
      </Group>
      {unknown.length > 0 && (
        <Text size="xs" c="orange">
          {t("ui.template-unknown-tokens", { tokens: unknown.map((token) => `{${token}}`).join(", ") })}
        </Text>
      )}
    </Stack>
  );
};
